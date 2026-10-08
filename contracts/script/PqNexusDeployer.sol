// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Vm } from "forge-std/Vm.sol";
import { SphincsVerifier_v2 } from "../src/SphincsVerifier.sol";
import { SphincsValidator, ISphincsVerifier } from "../src/SphincsValidator.sol";
import { PqDemoToken } from "../src/PqDemoToken.sol";

/// @notice Deploys the PQ Nexus suite through the deterministic CREATE2 deployer.
/// @dev Nexus, NexusBootstrap and NexusAccountFactory are deployed from the canonical MEE suite 2.2.3
///      artifacts (lib/stx-contracts/script/deploy/artifacts @ 887924af). Those artifacts are the exact
///      creation code behind the canonical Nexus 1.3.3 deployment; only the constructor arguments differ:
///      the default validator is SphincsValidator (the canonical deployment uses K1MeeValidator).
library PqNexusDeployer {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    address internal constant ENTRYPOINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    string internal constant ARTIFACTS = "lib/stx-contracts/script/deploy/artifacts/";

    /// @notice Address prefix every suite contract is mined to start with ("safe").
    uint16 internal constant VANITY_PREFIX = 0x5afe;

    /// @notice CREATE2 salts mined with script/Mine.s.sol. The factory salt is only valid for FACTORY_OWNER,
    ///         because the owner is part of the factory's creation code.
    address internal constant FACTORY_OWNER = 0x531b827c1221EC7CE13266e8F5CB1ec6Ae470be5;

    struct Salts {
        bytes32 verifier;
        bytes32 validator;
        bytes32 nexus;
        bytes32 bootstrap;
        bytes32 factory;
        bytes32 token;
    }

    struct Suite {
        address verifier;
        address validator;
        address nexus;
        address bootstrap;
        address factory;
        address token;
    }

    function salts() internal pure returns (Salts memory) {
        return Salts({
            verifier: bytes32(uint256(0x2167)),
            validator: bytes32(uint256(0x2ec3)),
            nexus: bytes32(uint256(0xb8ef)),
            bootstrap: bytes32(uint256(0x8e7d)),
            factory: bytes32(uint256(0x24682)),
            token: bytes32(uint256(0x22c2))
        });
    }

    /// @notice Key installed on the implementation and bootstrap contracts themselves. It has no secret,
    ///         so nobody can sign for it; it only keeps the implementation from being usable as an account.
    function lockKey() internal pure returns (bytes memory) {
        bytes32 hi = ~bytes32(uint256(type(uint128).max));
        return abi.encode(keccak256("pq-nexus/lock/seed") & hi, keccak256("pq-nexus/lock/root") & hi);
    }

    function deploy(address factoryOwner) internal returns (Suite memory s) {
        return deploy(factoryOwner, salts());
    }

    function deploy(address factoryOwner, Salts memory k) internal returns (Suite memory s) {
        s.verifier = _create2(k.verifier, verifierInitCode());
        s.validator = _create2(k.validator, validatorInitCode(s.verifier));
        s.nexus = _create2(k.nexus, nexusInitCode(s.validator));
        s.bootstrap = _create2(k.bootstrap, bootstrapInitCode(s.validator));
        s.factory = _create2(k.factory, factoryInitCode(s.nexus, factoryOwner));
        s.token = _create2(k.token, tokenInitCode());
    }

    function verifierInitCode() internal pure returns (bytes memory) {
        return type(SphincsVerifier_v2).creationCode;
    }

    function validatorInitCode(address verifier) internal pure returns (bytes memory) {
        return abi.encodePacked(type(SphincsValidator).creationCode, abi.encode(verifier));
    }

    function nexusInitCode(address validator) internal view returns (bytes memory) {
        return abi.encodePacked(_artifact("Nexus"), abi.encode(ENTRYPOINT_V07, validator, lockKey()));
    }

    function bootstrapInitCode(address validator) internal view returns (bytes memory) {
        return abi.encodePacked(_artifact("NexusBootstrap"), abi.encode(validator, lockKey()));
    }

    function factoryInitCode(address nexus, address owner) internal view returns (bytes memory) {
        return abi.encodePacked(_artifact("NexusAccountFactory"), abi.encode(nexus, owner));
    }

    function tokenInitCode() internal pure returns (bytes memory) {
        return type(PqDemoToken).creationCode;
    }

    function predict(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
    }

    /// @notice initData for NexusAccountFactory.createAccount: the bootstrap installs the SPHINCS key on the
    ///         default validator and nothing else.
    function accountInitData(address bootstrap, bytes32 pkSeed, bytes32 pkRoot) internal pure returns (bytes memory) {
        bytes memory call = abi.encodeWithSignature("initNexusWithDefaultValidator(bytes)", abi.encode(pkSeed, pkRoot));
        return abi.encode(bootstrap, call);
    }

    function _artifact(string memory name) private view returns (bytes memory) {
        return vm.getCode(string.concat(ARTIFACTS, name, "/", name, ".json"));
    }

    function _create2(bytes32 salt, bytes memory initCode) private returns (address addr) {
        addr = predict(salt, initCode);
        if (addr.code.length > 0) return addr;
        (bool ok,) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initCode));
        require(ok && addr.code.length > 0, "create2 failed");
    }
}
