import { parseEther } from "viem";
import { ENTRYPOINT, PolicyError, checkPolicy, clientIp, rateLimited, relayer, revertReason } from "@/lib/server";
import { handleOpsData } from "@/lib/userop";

export const maxDuration = 30;

const MIN_RELAYER_BALANCE = parseEther("0.01");

/**
 * Sponsored bundler for PQ Nexus accounts. The relayer's ECDSA key only pays gas: it submits
 * EntryPoint.handleOps, and the EntryPoint only executes ops the account's SPHINCS validator accepts.
 * Body: { userOp, simulateOnly? }. Every op is simulated first; a rejected op never reaches the chain.
 */
export async function POST(req: Request) {
  const ip = clientIp(req);
  if (rateLimited(`relay:${ip}`, 12, 60_000)) return Response.json({ error: "rate limited, try again in a minute" }, { status: 429 });

  let body: { userOp?: unknown; simulateOnly?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  let r;
  try {
    r = await relayer();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }

  try {
    const op = await checkPolicy(body.userOp);
    const data = handleOpsData(op, r.account.address);

    try {
      await r.client.call({ account: r.account.address, to: ENTRYPOINT, data });
    } catch (e) {
      return Response.json({ rejected: true, reason: revertReason(e) }, { status: body.simulateOnly ? 200 : 422 });
    }
    if (body.simulateOnly) return Response.json({ simulated: true });

    if (rateLimited(`send:${op.sender}`, 6, 60_000)) return Response.json({ error: "too many ops for this account" }, { status: 429 });
    const balance = await r.client.getBalance({ address: r.account.address });
    if (balance < MIN_RELAYER_BALANCE) return Response.json({ error: "relayer is out of Sepolia ETH" }, { status: 503 });

    const gas = await r.client.estimateGas({ account: r.account.address, to: ENTRYPOINT, data });
    const txHash = await r.wallet.sendTransaction({ to: ENTRYPOINT, data, gas: (gas * 13n) / 10n });
    return Response.json({ txHash });
  } catch (e) {
    if (e instanceof PolicyError) return Response.json({ error: e.message }, { status: 400 });
    console.error("relay failed", e);
    return Response.json({ error: revertReason(e) }, { status: 500 });
  }
}

export async function GET() {
  try {
    const { account, client } = await relayer();
    const balance = await client.getBalance({ address: account.address });
    return Response.json({ relayer: account.address, balance: balance.toString() });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 503 });
  }
}
