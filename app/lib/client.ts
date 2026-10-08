"use client";

import { createPublicClient, http, type Address, type Hex } from "viem";
import { ENTRYPOINT, SUITE, chain } from "./config";
import { entryPointAbi, factoryAbi, tokenAbi } from "./abi";
import type { PackedUserOp } from "./userop";

let _client: ReturnType<typeof createPublicClient> | null = null;
export function client() {
  _client ??= createPublicClient({ chain, transport: http(`${window.location.origin}/api/rpc`, { batch: true }) });
  return _client;
}

// ----------------------------------------------------------------------------- signer worker

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let seq = 0;

function call<T>(msg: object): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL("./signer.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data);
    };
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (v) => resolve(v as T), reject });
    worker!.postMessage({ ...msg, id });
  });
}

export const signer = {
  load: (secret: Hex) => call<{ pkSeed: Hex; pkRoot: Hex; ms: number }>({ type: "load", secret }),
  sign: (message: Hex) => call<{ signature: Hex; ms: number }>({ type: "sign", message }),
};

// ----------------------------------------------------------------------------- account reads

export async function accountState(address: Address) {
  const c = client();
  const [code, eth, token, nonce] = await Promise.all([
    c.getCode({ address }),
    c.getBalance({ address }),
    c.readContract({ address: SUITE.token, abi: tokenAbi, functionName: "balanceOf", args: [address] }).catch(() => 0n),
    c.readContract({ address: ENTRYPOINT, abi: entryPointAbi, functionName: "getNonce", args: [address, 0n] }),
  ]);
  return { deployed: !!code && code !== "0x", eth, token, nonce };
}

export async function computeAddress(initData: Hex): Promise<Address> {
  return client().readContract({
    address: SUITE.factory,
    abi: factoryAbi,
    functionName: "computeAccountAddress",
    args: [initData, "0x0000000000000000000000000000000000000000000000000000000000000000"],
  });
}

// ----------------------------------------------------------------------------- relayer

export async function relay(op: PackedUserOp, simulateOnly = false) {
  const res = await fetch("/api/relay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userOp: op, simulateOnly }),
  });
  const body = await res.json().catch(() => ({ error: `relayer returned ${res.status}` }));
  return body as { txHash?: Hex; simulated?: boolean; rejected?: boolean; reason?: string; error?: string };
}
