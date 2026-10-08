// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Script, console2 } from "forge-std/Script.sol";
import { PqNexusDeployer as D } from "./PqNexusDeployer.sol";

/// @notice Mines CREATE2 salts so every suite contract starts with 0x5afe. Contracts are mined in dependency
///         order, since each address is baked into the next creation code. Paste the output into
///         PqNexusDeployer.salts().
/// @dev    forge script script/Mine.s.sol
contract Mine is Script {
    function run() external view {
        D.Salts memory k;
        D.Suite memory s;
        (k.verifier, s.verifier) = _mine(keccak256(D.verifierInitCode()));
        (k.validator, s.validator) = _mine(keccak256(D.validatorInitCode(s.verifier)));
        (k.nexus, s.nexus) = _mine(keccak256(D.nexusInitCode(s.validator)));
        (k.bootstrap, s.bootstrap) = _mine(keccak256(D.bootstrapInitCode(s.validator)));
        (k.factory, s.factory) = _mine(keccak256(D.factoryInitCode(s.nexus, D.FACTORY_OWNER)));
        (k.token, s.token) = _mine(keccak256(D.tokenInitCode()));

        _print("verifier", k.verifier, s.verifier);
        _print("validator", k.validator, s.validator);
        _print("nexus", k.nexus, s.nexus);
        _print("bootstrap", k.bootstrap, s.bootstrap);
        _print("factory", k.factory, s.factory);
        _print("token", k.token, s.token);
    }

    function _mine(bytes32 initCodeHash) internal pure returns (bytes32 salt, address addr) {
        for (uint256 i;; ++i) {
            salt = bytes32(i);
            addr = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), D.CREATE2_DEPLOYER, salt, initCodeHash))))
            );
            if (uint16(uint160(addr) >> 144) == D.VANITY_PREFIX) return (salt, addr);
        }
    }

    function _print(string memory name, bytes32 salt, address addr) internal pure {
        console2.log(name, vm.toString(salt), addr);
    }
}
