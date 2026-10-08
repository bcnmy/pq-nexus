#!/usr/bin/env bash
# Runs the full demo locally against an anvil fork of Sepolia.
#
#   ./scripts/local.sh              fork Sepolia, deploy the suite, start the app on http://localhost:3000
#   ./scripts/local.sh fund <addr>  give <addr> 1 ETH on the running fork
#
# The suite is deployed by impersonating FACTORY_OWNER, so addresses match app/lib/deployment.json.
# The relayer is a throwaway key written to app/.env.local (gitignored). Ctrl+C stops everything.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORK_URL="${FORK_URL:-https://sepolia.gateway.tenderly.co}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
OWNER="0x531b827c1221EC7CE13266e8F5CB1ec6Ae470be5"
ONE_ETH="0xDE0B6B3A7640000"

if [[ "${1:-}" == "fund" ]]; then
  [[ -n "${2:-}" ]] || { echo "usage: $0 fund <address>"; exit 1; }
  cast rpc anvil_setBalance "$2" "$ONE_ETH" --rpc-url "$RPC" >/dev/null
  echo "funded $2 with 1 ETH on the fork"
  exit 0
fi

for bin in anvil cast forge pnpm; do
  command -v "$bin" >/dev/null || { echo "missing $bin"; exit 1; }
done

cleanup() { [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "==> dependencies"
git -C "$ROOT" submodule update --init --recursive
[[ -d "$ROOT/contracts/lib/stx-contracts/node_modules" ]] ||
  (cd "$ROOT/contracts/lib/stx-contracts" && pnpm install --frozen-lockfile --ignore-scripts)
[[ -d "$ROOT/app/node_modules" ]] || (cd "$ROOT/app" && pnpm install)

echo "==> anvil fork of Sepolia on $RPC"
anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --silent &
ANVIL_PID=$!
for _ in $(seq 1 30); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 1; done

echo "==> deploying the suite as $OWNER"
cast rpc anvil_impersonateAccount "$OWNER" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$OWNER" "$ONE_ETH" --rpc-url "$RPC" >/dev/null
(
  cd "$ROOT/contracts"
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender "$OWNER" | grep -E "validator|factory"
  # Fork run only: keep it out of the real Sepolia deployment record.
  rm -rf broadcast/Deploy.s.sol/11155111 deployments/11155111.json
)

echo "==> relayer"
read -r RELAYER_ADDR RELAYER_KEY < <(cast wallet new --json | python3 -c 'import json,sys; w=json.load(sys.stdin)[0]; print(w["address"], w["private_key"])')
cast rpc anvil_setBalance "$RELAYER_ADDR" "$ONE_ETH" --rpc-url "$RPC" >/dev/null
printf 'RELAYER_PRIVATE_KEY=%s\nSEPOLIA_RPC_URL=%s\n' "$RELAYER_KEY" "$RPC" > "$ROOT/app/.env.local"
echo "    $RELAYER_ADDR funded with 1 ETH (key in app/.env.local)"

echo "==> app on http://localhost:3000"
echo "    fund your demo account:  ./scripts/local.sh fund <account address>"
cd "$ROOT/app"
rm -rf .next
pnpm dev
