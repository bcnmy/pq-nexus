// End-to-end check of the relayer API, driven exactly like the browser: build -> SPHINCS sign -> POST /api/relay.
//   BASE_URL=http://localhost:3333 pnpm dlx tsx scripts/e2e.mts
import { createPublicClient, encodeFunctionData, http, parseEther, parseEventLogs, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { keyFromSecret, randomSecret, sign } from "../lib/sphincs.mjs";
import { accountInitData, buildUserOp, executeCallData, userOpHash, type Call, type PackedUserOp } from "../lib/userop";
import { ENTRYPOINT, SUITE } from "../lib/config";
import { entryPointAbi, factoryAbi, tokenAbi, validatorAbi } from "../lib/abi";

const BASE = process.env.BASE_URL ?? "http://localhost:3333";
const c = createPublicClient({ chain: sepolia, transport: http(`${BASE}/api/rpc`) });
const bob = privateKeyToAccount(generatePrivateKey()).address;

const key = keyFromSecret(randomSecret());
const initData = accountInitData(key.pkSeed as Hex, key.pkRoot as Hex);
const account = await c.readContract({ address: SUITE.factory, abi: factoryAbi, functionName: "computeAccountAddress", args: [initData, toHex(0, { size: 32 })] });
console.log("account", account);

let failures = 0;
const check = (ok: boolean, what: string) => { console.log(ok ? "PASS" : "FAIL", what); if (!ok) failures++; };

async function op(calls: Call[]) {
  const deployed = (await c.getCode({ address: account })) !== undefined;
  const nonce = await c.readContract({ address: ENTRYPOINT, abi: entryPointAbi, functionName: "getNonce", args: [account, 0n] });
  return buildUserOp(account, nonce, deployed, initData, executeCallData(calls));
}
async function post(u: PackedUserOp, simulateOnly = false) {
  const r = await fetch(`${BASE}/api/relay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userOp: u, simulateOnly }) });
  return { status: r.status, body: await r.json() };
}
async function send(title: string, calls: Call[]) {
  const u = await op(calls);
  const t = performance.now();
  u.signature = sign(key, userOpHash(u));
  const signMs = performance.now() - t;
  const res = await post(u);
  if (!res.body.txHash) { check(false, `${title}: ${JSON.stringify(res.body)}`); return; }
  const receipt = await c.waitForTransactionReceipt({ hash: res.body.txHash });
  const ev = parseEventLogs({ abi: entryPointAbi, logs: receipt.logs, eventName: "UserOperationEvent" })[0];
  check(ev?.args.success === true, `${title} (sign ${signMs.toFixed(0)} ms, ${ev?.args.actualGasUsed} gas, tx gas ${receipt.gasUsed})`);
}

const mint = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [parseEther("100")] });
await send("mint 100 pqUSD (deploys account)", [{ to: SUITE.token, value: 0n, data: mint }]);
const [seed, root] = await c.readContract({ address: SUITE.validator, abi: validatorAbi, functionName: "getKey", args: [account] });
check(seed === key.pkSeed && root === key.pkRoot, "validator holds the account's SPHINCS key");

// Fund the account on the fork (stands in for a faucet transfer).
await fetch(process.env.ANVIL_URL ?? "http://127.0.0.1:8545", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [account, toHex(parseEther("0.05"))] }) });
await send("send 0.01 ETH", [{ to: bob, value: parseEther("0.01"), data: "0x" }]);
check((await c.getBalance({ address: bob })) === parseEther("0.01"), "bob received 0.01 ETH");
check((await c.getBalance({ address: account })) === parseEther("0.04"), "account paid no gas (0.04 ETH left)");

await send("send 40 pqUSD", [{ to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [bob, parseEther("40")] }) }]);
check((await c.readContract({ address: SUITE.token, abi: tokenAbi, functionName: "balanceOf", args: [bob] })) === parseEther("40"), "bob received 40 pqUSD");

// Attacks: drain to 0x..dEaD.
const drain: Call[] = [{ to: "0x000000000000000000000000000000000000dEaD", value: parseEther("0.04"), data: "0x" }];
let u = await op(drain);
u.signature = await privateKeyToAccount(generatePrivateKey()).sign({ hash: userOpHash(u) });
let r = await post(u, true);
check(r.body.rejected === true && r.body.reason === "AA24 signature error", `ECDSA signature rejected: ${r.body.reason}`);

u = await op(drain);
const good = sign(key, userOpHash(u));
u.signature = (good.slice(0, 6002) + (parseInt(good.slice(6002, 6004), 16) ^ 1).toString(16).padStart(2, "0") + good.slice(6004)) as Hex;
r = await post(u, true);
check(r.body.rejected === true && r.body.reason === "AA24 signature error", `tampered SPHINCS signature rejected: ${r.body.reason}`);

u = await op(drain);
u.signature = sign(keyFromSecret(randomSecret()), userOpHash(u));
r = await post(u, true);
check(r.body.rejected === true && r.body.reason === "AA24 signature error", `other SPHINCS key rejected: ${r.body.reason}`);

// Relayer policy.
u = await op(drain);
u.gasFees = toHex(1n, { size: 32 });
r = await post(u);
check(r.status === 400, `non-zero gasFees refused: ${r.body.error}`);
u = await op(drain);
u.sender = "0x000000000000000000000000000000000000bEEF";
u.initCode = "0x";
r = await post(u);
check(r.status === 400, `foreign account refused: ${r.body.error}`);

console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
