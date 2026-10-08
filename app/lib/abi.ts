import { parseAbi } from "viem";

export const entryPointAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

export const factoryAbi = parseAbi([
  "function createAccount(bytes initData, bytes32 salt) payable returns (address)",
  "function computeAccountAddress(bytes initData, bytes32 salt) view returns (address)",
  "function ACCOUNT_IMPLEMENTATION() view returns (address)",
]);

export const nexusAbi = parseAbi([
  "function execute(bytes32 mode, bytes executionCalldata) payable",
  "function accountId() view returns (string)",
]);

export const validatorAbi = parseAbi([
  "function getKey(address account) view returns (bytes32 pkSeed, bytes32 pkRoot)",
  "function rotateKey(bytes32 pkSeed, bytes32 pkRoot)",
]);

export const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function mint(uint256 amount)",
]);
