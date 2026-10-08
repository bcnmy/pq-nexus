// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { Test, console2 } from "forge-std/Test.sol";
import { IEntryPoint } from "account-abstraction/interfaces/IEntryPoint.sol";
import { PackedUserOperation } from "account-abstraction/interfaces/PackedUserOperation.sol";
import { PqNexusDeployer } from "../script/PqNexusDeployer.sol";
import { SphincsVerifier_v2 } from "../src/SphincsVerifier.sol";
import { SphincsValidator } from "../src/SphincsValidator.sol";
import { PqDemoToken } from "../src/PqDemoToken.sol";

interface INexus {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
    function accountId() external view returns (string memory);
}

interface IFactory {
    function createAccount(bytes calldata initData, bytes32 salt) external payable returns (address payable);
    function computeAccountAddress(bytes calldata initData, bytes32 salt) external view returns (address payable);
}

contract PqNexusTest is Test {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    IEntryPoint internal constant EP = IEntryPoint(PqNexusDeployer.ENTRYPOINT_V07);
    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(uint256(1) << 248);

    PqNexusDeployer.Suite internal s;
    address internal relayer = makeAddr("relayer");
    address internal bob = makeAddr("bob");
    bytes32 internal aliceSecret = keccak256("alice");
    address payable internal alice;
    bytes internal aliceInit;

    function setUp() public {
        vm.createSelectFork(vm.envOr("SEPOLIA_RPC_URL", string("https://ethereum-sepolia-rpc.publicnode.com")));
        s = PqNexusDeployer.deploy(address(this));
        (bytes32 pkSeed, bytes32 pkRoot) = _pubkey(aliceSecret);
        aliceInit = PqNexusDeployer.accountInitData(s.bootstrap, pkSeed, pkRoot);
        alice = IFactory(s.factory).computeAccountAddress(aliceInit, bytes32(0));
        vm.deal(alice, 1 ether);
        vm.deal(relayer, 1 ether);
    }

    // ------------------------------------------------------------------ verifier

    function test_VerifierAcceptsReferenceVector() public view {
        string memory json = vm.readFile("test/vectors/sphincs-v2-reference-0.json");
        bytes32 pkSeed = vm.parseJsonBytes32(json, ".pkSeed");
        bytes32 pkRoot = vm.parseJsonBytes32(json, ".pkRoot");
        bytes32 message = vm.parseJsonBytes32(json, ".message");
        bytes memory sig = vm.parseJsonBytes(json, ".signature");

        uint256 g = gasleft();
        assertTrue(SphincsVerifier_v2(s.verifier).verify(pkSeed, pkRoot, message, sig));
        console2.log("verify gas", g - gasleft());

        sig[100] ^= 0x01;
        assertFalse(SphincsVerifier_v2(s.verifier).verify(pkSeed, pkRoot, message, sig));
    }

    // ------------------------------------------------------------------ account

    function test_AccountIsNexus133WithSphincsDefaultValidator() public {
        _send(_op(alice, aliceInit, _single(bob, 0, ""), aliceSecret));
        assertEq(INexus(alice).accountId(), "biconomy.nexus.1.3.3");
        assertTrue(SphincsValidator(s.validator).isInitialized(alice));
    }

    function test_DeployAndSendEth() public {
        uint256 g = gasleft();
        _send(_op(alice, aliceInit, _single(bob, 0.1 ether, ""), aliceSecret));
        console2.log("first op (deploy + send) gas", g - gasleft());
        assertEq(bob.balance, 0.1 ether);

        g = gasleft();
        _send(_op(alice, "", _single(bob, 0.2 ether, ""), aliceSecret));
        console2.log("second op (send) gas", g - gasleft());
        assertEq(bob.balance, 0.3 ether);
    }

    function test_BatchMintAndTransferToken() public {
        Execution[] memory calls = new Execution[](2);
        calls[0] = Execution(s.token, 0, abi.encodeCall(PqDemoToken.mint, (100 ether)));
        calls[1] = Execution(s.token, 0, abi.encodeWithSignature("transfer(address,uint256)", bob, 40 ether));
        _send(_op(alice, aliceInit, abi.encodeCall(INexus.execute, (MODE_BATCH, abi.encode(calls))), aliceSecret));
        assertEq(PqDemoToken(s.token).balanceOf(alice), 60 ether);
        assertEq(PqDemoToken(s.token).balanceOf(bob), 40 ether);
    }

    function test_RejectsEcdsaSignature() public {
        PackedUserOperation memory op = _op(alice, aliceInit, _single(bob, 0.1 ether, ""), aliceSecret);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(uint256(aliceSecret), EP.getUserOpHash(op));
        op.signature = abi.encodePacked(r, sg, v);
        _expectRejected(op);
    }

    function test_RejectsOtherSphincsKey() public {
        PackedUserOperation memory op = _op(alice, aliceInit, _single(bob, 0.1 ether, ""), keccak256("mallory"));
        _expectRejected(op);
    }

    function test_RejectsTamperedSignature() public {
        PackedUserOperation memory op = _op(alice, aliceInit, _single(bob, 0.1 ether, ""), aliceSecret);
        op.signature[3000] ^= 0x01;
        _expectRejected(op);
    }

    function test_Erc1271() public {
        _send(_op(alice, aliceInit, _single(bob, 0, ""), aliceSecret));
        bytes32 hash = keccak256("hello post-quantum");
        bytes memory sig = _sign(aliceSecret, SphincsValidator(s.validator).erc1271Message(alice, hash));
        assertEq(INexus(alice).isValidSignature(hash, abi.encodePacked(address(0), sig)), bytes4(0x1626ba7e));
        assertEq(INexus(alice).isValidSignature(keccak256("other"), abi.encodePacked(address(0), sig)), bytes4(0xffffffff));
    }

    function test_RotateKey() public {
        bytes32 newSecret = keccak256("alice-2");
        (bytes32 pkSeed, bytes32 pkRoot) = _pubkey(newSecret);
        bytes memory rotate = abi.encodeCall(SphincsValidator.rotateKey, (pkSeed, pkRoot));
        _send(_op(alice, aliceInit, _single(s.validator, 0, rotate), aliceSecret));

        _expectRejected(_op(alice, "", _single(bob, 0.1 ether, ""), aliceSecret));
        _send(_op(alice, "", _single(bob, 0.1 ether, ""), newSecret));
        assertEq(bob.balance, 0.1 ether);
    }

    function test_AddressCommitsToKey() public {
        (bytes32 pkSeed, bytes32 pkRoot) = _pubkey(keccak256("mallory"));
        bytes memory otherInit = PqNexusDeployer.accountInitData(s.bootstrap, pkSeed, pkRoot);
        assertTrue(IFactory(s.factory).computeAccountAddress(otherInit, bytes32(0)) != alice);
    }

    // ------------------------------------------------------------------ helpers

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(INexus.execute, (MODE_SINGLE, abi.encodePacked(target, value, data)));
    }

    /// @dev Zero gas fees: the relayer sponsors the op, so the account's ETH is untouched by gas.
    function _op(address sender, bytes memory init, bytes memory callData, bytes32 secret)
        internal
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.nonce = EP.getNonce(sender, 0); // key 0 -> validator address(0) -> Nexus default validator
        op.initCode = init.length == 0 ? bytes("") : abi.encodePacked(s.factory, abi.encodeCall(IFactory.createAccount, (init, bytes32(0))));
        op.callData = callData;
        op.accountGasLimits = bytes32(uint256(2_000_000) << 128 | uint256(500_000));
        op.preVerificationGas = 150_000;
        op.gasFees = bytes32(0);
        op.signature = _sign(secret, EP.getUserOpHash(op));
    }

    function _send(PackedUserOperation memory op) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.prank(relayer, relayer);
        EP.handleOps(ops, payable(relayer));
    }

    function _expectRejected(PackedUserOperation memory op) internal {
        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        _send(op);
    }

    function _pubkey(bytes32 secret) internal returns (bytes32 pkSeed, bytes32 pkRoot) {
        string[] memory cmd = new string[](4);
        (cmd[0], cmd[1], cmd[2], cmd[3]) = ("node", "../app/scripts/sphincs-cli.mjs", "pubkey", vm.toString(secret));
        return abi.decode(vm.ffi(cmd), (bytes32, bytes32));
    }

    function _sign(bytes32 secret, bytes32 message) internal returns (bytes memory) {
        string[] memory cmd = new string[](5);
        (cmd[0], cmd[1], cmd[2], cmd[3], cmd[4]) =
            ("node", "../app/scripts/sphincs-cli.mjs", "sign", vm.toString(secret), vm.toString(message));
        return vm.ffi(cmd);
    }
}
