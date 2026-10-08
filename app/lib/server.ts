import "server-only";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  fallback,
  getAddress,
  http,
  isHex,
  slice,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRYPOINT, GAS, SUITE, chain } from "./config";
import { entryPointAbi } from "./abi";
import type { PackedUserOp } from "./userop";

const PUBLIC_RPCS = ["https://sepolia.gateway.tenderly.co", "https://ethereum-sepolia-rpc.publicnode.com"];
const configured = process.env.SEPOLIA_RPC_URL;
const isLocal = !!configured && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(configured);

/**
 * SEPOLIA_RPC_URL first, then public endpoints as backups. A local URL (an anvil fork) is used alone, so fork
 * state is never mixed with real Sepolia.
 */
export const RPC_URLS = isLocal ? [configured!] : [...new Set([configured, ...PUBLIC_RPCS].filter((u): u is string => !!u))];

/** Reads: falls back across RPC_URLS. */
export const publicClient = createPublicClient({
  chain,
  transport: fallback(RPC_URLS.map((url) => http(url, { timeout: 8_000, retryCount: 0 }))),
});

/** First endpoint that answers eth_chainId within a few seconds. */
async function healthyRpc(): Promise<string> {
  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(4_000),
      });
      if (res.ok) return url;
      console.warn(`rpc ${new URL(url).host} answered HTTP ${res.status}`);
    } catch (e) {
      console.warn(`rpc ${new URL(url).host} unreachable: ${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name}`);
    }
  }
  throw new Error("no Sepolia RPC endpoint reachable");
}

/**
 * The relayer picks one healthy node per request and simulates, estimates, sends and reads its nonce through
 * it, so all of them see the same state (mixing nodes leads to stale nonces).
 */
export async function relayer() {
  const pk = process.env.RELAYER_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("RELAYER_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(pk as Hex);
  const transport = http(await healthyRpc(), { timeout: 15_000 });
  return {
    account,
    client: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account, chain, transport }),
  };
}

// ----------------------------------------------------------------------------- rate limiting
// Per-instance memory only. Good enough for a testnet demo; the relayer also refuses to go below a floor.

const hits = new Map<string, number[]>();

export function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

// ----------------------------------------------------------------------------- UserOp policy

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const CREATE_ACCOUNT_SELECTOR = "0xea6d13ac"; // createAccount(bytes,bytes32)

const FIELDS = ["sender", "nonce", "initCode", "callData", "accountGasLimits", "preVerificationGas", "gasFees", "paymasterAndData", "signature"] as const;

/** Only ops for accounts of this deployment, with the demo's own gas limits and zero fees, are relayed. */
export async function checkPolicy(raw: unknown): Promise<PackedUserOp> {
  if (typeof raw !== "object" || raw === null) throw new PolicyError("missing userOp");
  const op = raw as Record<string, unknown>;
  for (const f of FIELDS) if (typeof op[f] !== "string" || !isHex(op[f])) throw new PolicyError(`bad field ${f}`);
  const u = op as unknown as PackedUserOp;

  if (BigInt(u.gasFees) !== 0n) throw new PolicyError("gasFees must be zero (relayer-sponsored)");
  if (u.paymasterAndData !== "0x") throw new PolicyError("paymasters are not supported");
  if (BigInt(u.preVerificationGas) > GAS.preVerificationGas) throw new PolicyError("preVerificationGas too high");
  const verificationGas = BigInt(slice(u.accountGasLimits, 0, 16));
  const callGas = BigInt(slice(u.accountGasLimits, 16, 32));
  if (verificationGas > GAS.verificationGasLimit || callGas > GAS.callGasLimit) throw new PolicyError("gas limits too high");
  if ((u.signature.length - 2) / 2 > 8192 || (u.callData.length - 2) / 2 > 8192) throw new PolicyError("op too large");

  if (u.initCode !== "0x") {
    if (getAddress(slice(u.initCode, 0, 20)) !== SUITE.factory) throw new PolicyError("initCode must use the PQ Nexus factory");
    if (slice(u.initCode, 20, 24) !== CREATE_ACCOUNT_SELECTOR) throw new PolicyError("initCode must call createAccount");
  } else {
    const impl = await publicClient.getStorageAt({ address: getAddress(u.sender), slot: EIP1967_IMPL_SLOT });
    if (!impl || getAddress(slice(impl, 12, 32)) !== SUITE.nexus) throw new PolicyError("sender is not a PQ Nexus account");
  }
  return u;
}

export class PolicyError extends Error {}

/** Pulls the EntryPoint FailedOp reason (e.g. "AA24 signature error") out of a reverted simulation. */
export function revertReason(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.args) {
      // FailedOp(opIndex, reason) and FailedOpWithRevert carry the reason second; Error(string) first.
      const args = revert.data.args;
      return String(revert.data.errorName === "Error" ? args[0] : (args[1] ?? revert.shortMessage));
    }
    if (revert instanceof ContractFunctionRevertedError && revert.reason) return revert.reason;
    const data = (err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null)?.data;
    if (data) {
      try {
        const decoded = decodeErrorResult({ abi: entryPointAbi, data });
        return String(decoded.args?.[1] ?? decoded.errorName);
      } catch {}
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

export { ENTRYPOINT };
