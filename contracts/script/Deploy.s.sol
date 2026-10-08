// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";
import { PqNexusDeployer } from "./PqNexusDeployer.sol";

/// @notice forge script script/Deploy.s.sol --rpc-url sepolia --broadcast [--account <keystore> | --ledger]
/// @dev Uses DEPLOYER_PRIVATE_KEY from the environment when set (never pass a key as a CLI argument),
///      otherwise the wallet given to forge (--account, --ledger, or --unlocked --sender).
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        // The mined factory salt only yields a 0x5afe address for this owner; re-run Mine.s.sol for another.
        require(deployer == PqNexusDeployer.FACTORY_OWNER, "deployer != FACTORY_OWNER, re-mine salts");

        PqNexusDeployer.Suite memory s = PqNexusDeployer.deploy(deployer);
        vm.stopBroadcast();

        string memory o = "suite";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "entryPoint", PqNexusDeployer.ENTRYPOINT_V07);
        vm.serializeAddress(o, "sphincsVerifier", s.verifier);
        vm.serializeAddress(o, "sphincsValidator", s.validator);
        vm.serializeAddress(o, "nexusImplementation", s.nexus);
        vm.serializeAddress(o, "nexusBootstrap", s.bootstrap);
        vm.serializeAddress(o, "nexusAccountFactory", s.factory);
        string memory json = vm.serializeAddress(o, "pqDemoToken", s.token);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));

        console2.log("deployer", deployer);
        console2.log("validator", s.validator);
        console2.log("factory", s.factory);
    }
}
