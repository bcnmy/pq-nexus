// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script } from "forge-std/Script.sol";
import { PqNexusDeployer } from "./PqNexusDeployer.sol";

/// @notice Simulates the deployment for FACTORY_OWNER (a dry run that needs no key) and prints the addresses.
contract Predict is Script {
    function run() external {
        PqNexusDeployer.Suite memory s = PqNexusDeployer.deploy(vm.envAddress("FACTORY_OWNER"));
        string memory o = "suite";
        vm.serializeAddress(o, "sphincsVerifier", s.verifier);
        vm.serializeAddress(o, "sphincsValidator", s.validator);
        vm.serializeAddress(o, "nexusImplementation", s.nexus);
        vm.serializeAddress(o, "nexusBootstrap", s.bootstrap);
        vm.serializeAddress(o, "nexusAccountFactory", s.factory);
        string memory json = vm.serializeAddress(o, "pqDemoToken", s.token);
        vm.writeJson(json, "deployments/11155111.predicted.json");
    }
}
