import { RPC_URLS, clientIp, rateLimited } from "@/lib/server";

const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_getBlockByNumber",
]);

/** Read-only JSON-RPC proxy so the browser never needs the RPC key. Tries each configured endpoint in turn. */
export async function POST(req: Request) {
  if (rateLimited(`rpc:${clientIp(req)}`, 240, 60_000)) return Response.json({ error: "rate limited" }, { status: 429 });

  const body = await req.json().catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  if (!calls.length || calls.length > 20 || calls.some((c) => !c || !READ_METHODS.has(c.method))) {
    return Response.json({ error: "method not allowed" }, { status: 400 });
  }

  for (const url of RPC_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      if (res.status >= 500 || res.status === 429) {
        console.warn(`rpc ${new URL(url).host} answered HTTP ${res.status}, trying next`);
        continue;
      }
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
    } catch (e) {
      console.warn(`rpc ${new URL(url).host} unreachable: ${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).name}, trying next`);
    }
  }
  return Response.json({ error: "no Sepolia RPC endpoint reachable" }, { status: 502 });
}
