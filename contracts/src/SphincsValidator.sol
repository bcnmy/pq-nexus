// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import { IValidator } from "erc7579/interfaces/IERC7579Module.sol";
import { PackedUserOperation } from "account-abstraction/interfaces/PackedUserOperation.sol";
import { SPHINCS_V2_SIG_LEN } from "./SphincsVerifier.sol";

interface ISphincsVerifier {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool);
}

// DISCLAIMER: demonstration code only. Unaudited and experimental; not for mainnet or real funds. Provided as is,
// without warranty of any kind.

/// @title SphincsValidator
/// @notice ERC-7579 validator that authorizes a Nexus account with a hash-based SPHINCS signature
///         (sphincs-g parameter set, keccak256, 6,176-byte signatures). No elliptic curve is involved
///         anywhere on the validation path: forging a signature means breaking keccak256.
/// @dev    Deployed as the immutable default validator of a dedicated Nexus 1.3.3 implementation, so
///         the account has no ECDSA validator at all. UNAUDITED demo code.
contract SphincsValidator is IValidator {
    struct PublicKey {
        bytes32 pkSeed;
        bytes32 pkRoot;
    }

    uint256 internal constant MODULE_TYPE_VALIDATOR = 1;
    uint256 internal constant VALIDATION_SUCCESS = 0;
    uint256 internal constant VALIDATION_FAILED = 1;
    bytes4 internal constant ERC1271_SUCCESS = 0x1626ba7e;
    bytes4 internal constant ERC1271_FAILED = 0xffffffff;
    uint256 internal constant LOW_128 = type(uint128).max;

    ISphincsVerifier public immutable VERIFIER;

    mapping(address account => PublicKey) internal _keys;

    event KeySet(address indexed account, bytes32 pkSeed, bytes32 pkRoot);
    event KeyRemoved(address indexed account);

    error InvalidPublicKey();

    constructor(ISphincsVerifier verifier) {
        VERIFIER = verifier;
    }

    // ------------------------------------------------------------------ module lifecycle

    /// @param data abi.encode(bytes32 pkSeed, bytes32 pkRoot), both 16-byte values in the top half.
    function onInstall(bytes calldata data) external override {
        if (_keys[msg.sender].pkRoot != bytes32(0)) revert AlreadyInitialized(msg.sender);
        (bytes32 pkSeed, bytes32 pkRoot) = abi.decode(data, (bytes32, bytes32));
        _setKey(msg.sender, pkSeed, pkRoot);
    }

    function onUninstall(bytes calldata) external override {
        delete _keys[msg.sender];
        emit KeyRemoved(msg.sender);
    }

    /// @notice Replace the calling account's key. Reachable only through the account itself, i.e. by a
    ///         UserOp already signed with the current SPHINCS key.
    function rotateKey(bytes32 pkSeed, bytes32 pkRoot) external {
        if (_keys[msg.sender].pkRoot == bytes32(0)) revert NotInitialized(msg.sender);
        _setKey(msg.sender, pkSeed, pkRoot);
    }

    function isModuleType(uint256 moduleTypeId) external pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function isInitialized(address account) external view override returns (bool) {
        return _keys[account].pkRoot != bytes32(0);
    }

    function getKey(address account) external view returns (bytes32 pkSeed, bytes32 pkRoot) {
        PublicKey storage key = _keys[account];
        return (key.pkSeed, key.pkRoot);
    }

    // ------------------------------------------------------------------ validation

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        view
        override
        returns (uint256)
    {
        return _verify(msg.sender, userOpHash, userOp.signature) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
    }

    /// @dev The signed message binds the chain and the account, so one key shared by two accounts (or
    ///      chains) cannot replay a 1271 signature between them.
    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata signature)
        external
        view
        override
        returns (bytes4)
    {
        bytes32 message = erc1271Message(msg.sender, hash);
        return _verify(msg.sender, message, signature) ? ERC1271_SUCCESS : ERC1271_FAILED;
    }

    function erc1271Message(address account, bytes32 hash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, account, hash));
    }

    // ------------------------------------------------------------------ internal

    function _verify(address account, bytes32 message, bytes calldata signature) internal view returns (bool) {
        PublicKey storage key = _keys[account];
        if (key.pkRoot == bytes32(0) || signature.length != SPHINCS_V2_SIG_LEN) return false;
        try VERIFIER.verify(key.pkSeed, key.pkRoot, message, signature) returns (bool valid) {
            return valid;
        } catch {
            return false;
        }
    }

    function _setKey(address account, bytes32 pkSeed, bytes32 pkRoot) internal {
        if (pkRoot == bytes32(0) || uint256(pkSeed) & LOW_128 != 0 || uint256(pkRoot) & LOW_128 != 0) {
            revert InvalidPublicKey();
        }
        _keys[account] = PublicKey(pkSeed, pkRoot);
        emit KeySet(account, pkSeed, pkRoot);
    }
}
