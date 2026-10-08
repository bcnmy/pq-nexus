// Holds the SPHINCS key off the main thread. The secret arrives once via "load" and stays inside the worker.
import { hexToBytes, keyFromSecret, sign } from "./sphincs.mjs";

type Key = ReturnType<typeof keyFromSecret>;
let key: Key | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      const t = performance.now();
      key = keyFromSecret(hexToBytes(msg.secret));
      self.postMessage({ id: msg.id, pkSeed: key.pkSeed, pkRoot: key.pkRoot, ms: performance.now() - t });
    } else if (msg.type === "sign") {
      if (!key) throw new Error("no key loaded");
      const t = performance.now();
      const signature = sign(key, msg.message);
      self.postMessage({ id: msg.id, signature, ms: performance.now() - t });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: (err as Error).message });
  }
};
