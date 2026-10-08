import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { ENTRYPOINT, GAS, SUITE, chain } from "./config";
import { entryPointAbi, factoryAbi, nexusAbi } from "./abi";

/** ERC-4337 v0.7 PackedUserOperation, hex-encoded for JSON transport. */
export type PackedUserOp = {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

export type Call = { to: Address; value: bigint; data: Hex };

const MODE_SINGLE = pad("0x00", { size: 32 });
const MODE_BATCH = pad("0x01", { dir: "right", size: 32 });

/** initData for NexusAccountFactory.createAccount: the bootstrap installs the SPHINCS key on the default validator. */
export function accountInitData(pkSeed: Hex, pkRoot: Hex): Hex {
  const bootstrapCall = encodeFunctionData({
    abi: [{ type: "function", name: "initNexusWithDefaultValidator", inputs: [{ name: "data", type: "bytes" }], outputs: [], stateMutability: "payable" }],
    functionName: "initNexusWithDefaultValidator",
    args: [encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [pkSeed, pkRoot])],
  });
  return encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [SUITE.bootstrap, bootstrapCall]);
}

export function initCode(initData: Hex): Hex {
  return concat([
    SUITE.factory,
    encodeFunctionData({ abi: factoryAbi, functionName: "createAccount", args: [initData, pad("0x00", { size: 32 })] }),
  ]);
}

export function executeCallData(calls: Call[]): Hex {
  if (calls.length === 1) {
    const c = calls[0];
    return encodeFunctionData({
      abi: nexusAbi,
      functionName: "execute",
      args: [MODE_SINGLE, encodePacked(["address", "uint256", "bytes"], [c.to, c.value, c.data])],
    });
  }
  const batch = encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
    [calls.map((c) => ({ target: c.to, value: c.value, callData: c.data }))],
  );
  return encodeFunctionData({ abi: nexusAbi, functionName: "execute", args: [MODE_BATCH, batch] });
}

/**
 * Builds an unsigned op. gasFees are zero: the demo relayer sponsors gas, so the account's own ETH is only
 * ever moved by the calls it signs. Nonce key 0 selects validator address(0), i.e. the Nexus default
 * validator, which in this deployment is the SphincsValidator.
 */
export function buildUserOp(sender: Address, nonce: bigint, deployed: boolean, initData: Hex, callData: Hex): PackedUserOp {
  return {
    sender,
    nonce: toHex(nonce),
    initCode: deployed ? "0x" : initCode(initData),
    callData,
    accountGasLimits: concat([pad(toHex(GAS.verificationGasLimit), { size: 16 }), pad(toHex(GAS.callGasLimit), { size: 16 })]),
    preVerificationGas: toHex(GAS.preVerificationGas),
    gasFees: pad("0x00", { size: 32 }),
    paymasterAndData: "0x",
    signature: "0x",
  };
}

/** EntryPoint v0.7 getUserOpHash, computed locally. */
export function userOpHash(op: PackedUserOp): Hex {
  const packed = encodeAbiParameters(
    [
      { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" },
    ],
    [
      op.sender, BigInt(op.nonce), keccak256(op.initCode), keccak256(op.callData),
      op.accountGasLimits, BigInt(op.preVerificationGas), op.gasFees, keccak256(op.paymasterAndData),
    ],
  );
  return keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [keccak256(packed), ENTRYPOINT, BigInt(chain.id)]),
  );
}

export function handleOpsData(op: PackedUserOp, beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPointAbi,
    functionName: "handleOps",
    args: [[{ ...op, nonce: BigInt(op.nonce), preVerificationGas: BigInt(op.preVerificationGas) }], beneficiary],
  });
}
