import { getAddress, type Address } from "viem";
import { sepolia } from "viem/chains";
import deployment from "./deployment.json";

export const chain = sepolia;
export const EXPLORER = "https://sepolia.etherscan.io";

export const ENTRYPOINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

export const SUITE = {
  verifier: getAddress(deployment.sphincsVerifier),
  validator: getAddress(deployment.sphincsValidator),
  nexus: getAddress(deployment.nexusImplementation),
  bootstrap: getAddress(deployment.nexusBootstrap),
  factory: getAddress(deployment.nexusAccountFactory),
  token: getAddress(deployment.pqDemoToken),
};

export const SOURCE_REPO = "https://github.com/bcnmy/pq-nexus-demo";
export const NEXUS_SOURCE = "https://github.com/bcnmy/stx-contracts/tree/887924afbcf57a07e68691dfb19fe38b527d7c4c";
export const VERIFIER_SOURCE =
  "https://github.com/RivaLabs-Core/Post-Quantum-AA-Infra/blob/67b04de3e9562f48759826c279c70a8087b4f8ae/src/Verifiers/SphincsVerifier_v2.sol";

/**
 * Gas limits for every UserOp. Limits only cap usage; with zero fees nobody pays for unused gas.
 * Verification covers account deployment plus the SPHINCS check, whose cost varies per signature (WOTS chain
 * lengths depend on the message). Since Glamsterdam (EIP-8037), new state costs 1,530 gas per byte and is
 * charged inside the verification frame whenever the transaction has no state-gas reservoir (tx gas at or
 * below 16.7M, which is also how several RPC providers simulate). The first op then lands around 1.2M, so
 * 2.5M leaves headroom. Calls that create state (new token holder, new recipient) also cost more, hence 600k.
 */
export const GAS = {
  verificationGasLimit: 2_500_000n,
  callGasLimit: 600_000n,
  preVerificationGas: 150_000n,
};
