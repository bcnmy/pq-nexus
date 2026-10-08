// Measures demo op gas on live Sepolia with eth_simulateV1; nothing is sent.
//   pnpm dlx tsx scripts/measure-gas.mts
import { createPublicClient, encodeFunctionData, http, parseEther, parseEventLogs, toHex, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { keyFromSecret, randomSecret, sign } from "../lib/sphincs.mjs";
import { accountInitData, buildUserOp, executeCallData, userOpHash, handleOpsData, type Call } from "../lib/userop";
import { ENTRYPOINT, SUITE } from "../lib/config";
import { entryPointAbi, factoryAbi, tokenAbi } from "../lib/abi";
const c = createPublicClient({ chain: sepolia, transport: http(process.env.RPC ?? "https://ethereum-sepolia-rpc.publicnode.com") });
const key = keyFromSecret(randomSecret());
const initData = accountInitData(key.pkSeed as Hex, key.pkRoot as Hex);
const account = await c.readContract({ address: SUITE.factory, abi: factoryAbi, functionName: "computeAccountAddress", args: [initData, toHex(0, { size: 32 })] });
const from = "0x000000000000000000000000000000000000bEEF" as const;
const fresh = () => `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
const op = (nonce: bigint, deployed: boolean, calls: Call[]) => {
  const u = buildUserOp(account, nonce, deployed, initData, executeCallData(calls));
  u.signature = sign(key, userOpHash(u));
  return { account: from, to: ENTRYPOINT, data: handleOpsData(u, from), gas: 10_000_000n };
};
const labels = ["deploy + mint 100 pqUSD", "send pqUSD to a new holder", "send ETH to a new address", "send ETH to an existing address"];
const sim = await c.simulateBlocks({
  blocks: [{
    stateOverrides: [{ address: account, balance: parseEther("1") }],
    calls: [
      op(0n, false, [{ to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [parseEther("100")] }) }]),
      op(1n, true, [{ to: SUITE.token, value: 0n, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [fresh(), parseEther("10")] }) }]),
      op(2n, true, [{ to: fresh(), value: parseEther("0.01"), data: "0x" }]),
      op(3n, true, [{ to: "0x531b827c1221EC7CE13266e8F5CB1ec6Ae470be5", value: parseEther("0.01"), data: "0x" }]),
    ],
  }],
});
sim[0].calls.forEach((r, i) => {
  const ev = parseEventLogs({ abi: entryPointAbi, logs: r.logs ?? [], eventName: "UserOperationEvent" })[0];
  console.log(`${labels[i].padEnd(32)} status=${r.status} opSuccess=${ev?.args.success} txGas=${r.gasUsed}`);
});
