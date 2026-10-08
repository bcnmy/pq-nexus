// Foundry FFI bridge to lib/sphincs.mjs, so the contract tests sign with the same code as the app.
//   node sphincs-cli.mjs pubkey <secret32>          -> abi.encode(bytes32 pkSeed, bytes32 pkRoot)
//   node sphincs-cli.mjs sign   <secret32> <msg32>  -> 6,176-byte signature
import { keyFromSecret, sign, hexToBytes } from "../lib/sphincs.mjs";

const [cmd, secret, message] = process.argv.slice(2);
const key = keyFromSecret(hexToBytes(secret));
if (cmd === "pubkey") process.stdout.write(key.pkSeed + key.pkRoot.slice(2));
else if (cmd === "sign") process.stdout.write(sign(key, message));
else throw new Error(`unknown command ${cmd}`);
