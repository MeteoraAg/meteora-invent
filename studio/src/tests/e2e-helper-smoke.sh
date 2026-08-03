#!/usr/bin/env bash
#
# e2e-helper-smoke.sh — localnet smoke test for the helper-SDK studio actions shipped in the
# "helper-SDK expansion" plan (Met Lock, Alpha Vault user ops, Presale lifecycle, Stake2Earn
# user ops, Dynamic Vault, Dynamic Fee Sharing, Zap, Pool Farms — 77 actions total).
#
# Exercises the two golden paths that need nothing but a wallet + a plain SPL mint (no pool,
# no liquidity, no second party) and are therefore fully runnable end to end on a bare
# localnet inside a ~4-minute smoke run:
#
#   (a) Met Lock:    lock-create-vesting-escrow (dry-run, then a real send) -> lock-get-escrow
#   (b) Fee Sharing: fee-sharing-create-vault (2 recipients) -> fee-sharing-fund -> fee-sharing-get-status
#
# Every other new family needs a seeded pool first (Alpha Vault/Presale need a live raise,
# Stake2Earn/Pool Farms need a DAMM v1 pool + farm, Dynamic Vault needs its program's own
# permissionless vault already initialized for the mint, Zap needs an existing DAMM v2/DLMM
# position) — each of those is its own multi-minute setup, so they stay dry-run-covered by
# the action's own built-in dryRun path (exercised whenever a maintainer edits that config)
# rather than by this script. See plan section 14 ("Testing & verification") for the full
# golden-path matrix this script deliberately narrows down from.
#
# SAFETY (read before editing):
#   - This script NEVER edits studio/.env, studio/keypair.json, studio/config/lock_config.jsonc
#     or studio/config/fee_sharing_config.jsonc "in place" without a net: each is backed up to
#     "<file>.e2e-backup" before being touched (only if the real file already exists) and
#     restored by a trap that fires on normal exit, error, or Ctrl-C. If a stale *.e2e-backup
#     is ever found at start (meaning a previous run crashed before restoring), the script
#     refuses to run instead of guessing which copy is "real" — resolve that by hand first.
#   - A brand-new throwaway keypair is generated for the run; its base58 private key is
#     written straight to the temporary studio/.env and is never printed or logged.
#   - Idempotent: safe to re-run back to back. The validator is started with --reset (fresh
#     ledger every time), and every on-chain object created (wallet, mint, escrow, fee vault)
#     is freshly generated each run, so there is nothing to collide with from a prior run.
#
# Usage: studio/src/tests/e2e-helper-smoke.sh   (works from any cwd; paths below are resolved
# relative to this script's own location, not the caller's cwd).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${STUDIO_DIR}/.." && pwd)"

ENV_FILE="${STUDIO_DIR}/.env"
KEYPAIR_FILE="${STUDIO_DIR}/keypair.json"
LOCK_CONFIG="${STUDIO_DIR}/config/lock_config.jsonc"
FEE_SHARING_CONFIG="${STUDIO_DIR}/config/fee_sharing_config.jsonc"

ENV_BACKUP="${ENV_FILE}.e2e-backup"
KEYPAIR_BACKUP="${KEYPAIR_FILE}.e2e-backup"
LOCK_CONFIG_BACKUP="${LOCK_CONFIG}.e2e-backup"
FEE_SHARING_CONFIG_BACKUP="${FEE_SHARING_CONFIG}.e2e-backup"

RPC_URL="http://127.0.0.1:8899"
MINT_DECIMALS=6
MINT_SUPPLY_HUMAN=1000000 # 1,000,000 units — comfortably covers the 12,500 the default
                          # lockCreateEscrow template locks, plus feeSharingFund's default 1.

VALIDATOR_PID=""
VALIDATOR_LOG=""
FAILURES=0
RESULTS=()
LAST_OUTPUT=""

# ---------------------------------------------------------------------------
# Pre-flight: refuse to run if a previous crashed run left a backup unrestored
# (meaning we can't tell which copy of the user's real file is authoritative).
# Nothing has been touched yet at this point, so a plain exit here is safe —
# the cleanup trap below isn't registered until after this check passes.
# ---------------------------------------------------------------------------
for f in "$ENV_BACKUP" "$KEYPAIR_BACKUP" "$LOCK_CONFIG_BACKUP" "$FEE_SHARING_CONFIG_BACKUP"; do
  if [[ -f "$f" ]]; then
    echo "ERROR: stale backup found at ${f}" >&2
    echo "A previous run of this script likely crashed before restoring your files." >&2
    echo "Resolve this by hand (inspect + restore or remove the backup) before re-running." >&2
    exit 1
  fi
done

echo "==> e2e-helper-smoke: repo root ${REPO_ROOT}"
echo "==> studio dir: ${STUDIO_DIR}"

cd "$REPO_ROOT" || exit 1
rm -rf "${STUDIO_DIR}/test-ledger"

# ---------------------------------------------------------------------------
# Cleanup trap — runs on normal exit, any `exit N`, or Ctrl-C/TERM. Kills the
# validator, restores every backed-up file (or removes the throwaway version
# if there was nothing to restore), and wipes throwaway artifacts. Recomputes
# the script's own exit code from $FAILURES so a run that completed but had
# failed steps still reports failure.
# ---------------------------------------------------------------------------
# shellcheck disable=SC2317  # only invoked indirectly via `trap ... EXIT INT TERM`
cleanup() {
  local exit_code=$?
  set +e
  trap - EXIT INT TERM

  echo ""
  echo "==> Cleaning up"

  if [[ -n "$VALIDATOR_PID" ]]; then
    kill "$VALIDATOR_PID" >/dev/null 2>&1
  fi
  pkill -f "solana-test-validator --account-dir .*src/tests/artifacts" >/dev/null 2>&1
  sleep 1
  if lsof -ti:8899 >/dev/null 2>&1; then
    lsof -ti:8899 | xargs kill -9 >/dev/null 2>&1
  fi
  if [[ -n "$VALIDATOR_PID" ]]; then
    wait "$VALIDATOR_PID" 2>/dev/null
  fi

  if [[ -f "$LOCK_CONFIG_BACKUP" ]]; then
    mv -f "$LOCK_CONFIG_BACKUP" "$LOCK_CONFIG"
  fi
  if [[ -f "$FEE_SHARING_CONFIG_BACKUP" ]]; then
    mv -f "$FEE_SHARING_CONFIG_BACKUP" "$FEE_SHARING_CONFIG"
  fi

  if [[ -f "$ENV_BACKUP" ]]; then
    mv -f "$ENV_BACKUP" "$ENV_FILE"
  else
    rm -f "$ENV_FILE"
  fi
  if [[ -f "$KEYPAIR_BACKUP" ]]; then
    mv -f "$KEYPAIR_BACKUP" "$KEYPAIR_FILE"
  else
    rm -f "$KEYPAIR_FILE"
  fi

  rm -rf "${STUDIO_DIR}/test-ledger"
  if [[ -n "$VALIDATOR_LOG" && -f "$VALIDATOR_LOG" ]]; then
    rm -f "$VALIDATOR_LOG"
  fi

  echo ""
  echo "===== Smoke test summary ====="
  local r
  for r in "${RESULTS[@]:-}"; do
    [[ -n "$r" ]] && echo "$r"
  done
  echo "==============================="

  if [[ $exit_code -ne 0 ]]; then
    echo "==> Aborted early (exit code ${exit_code}) — see output above."
  elif [[ "$FAILURES" -gt 0 ]]; then
    echo "==> Completed with ${FAILURES} failed/skipped step(s)."
    exit_code=1
  else
    echo "==> All steps passed."
  fi
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Back up whatever the developer already has before we touch anything.
# ---------------------------------------------------------------------------
[[ -f "$ENV_FILE" ]] && cp -p "$ENV_FILE" "$ENV_BACKUP"
[[ -f "$KEYPAIR_FILE" ]] && cp -p "$KEYPAIR_FILE" "$KEYPAIR_BACKUP"
cp -p "$LOCK_CONFIG" "$LOCK_CONFIG_BACKUP"
cp -p "$FEE_SHARING_CONFIG" "$FEE_SHARING_CONFIG_BACKUP"

# ---------------------------------------------------------------------------
# Small inline Node helpers. Each is passed to `node -e` — for `-e`, argv has
# NO script-path placeholder (verified: `node -e '...' a b` gives
# process.argv === [node, a, b]), so every helper below reads its arguments
# via process.argv.slice(1), not slice(2).
# ---------------------------------------------------------------------------

# Literal (non-regex) find/replace inside a text file. Used to patch the
# fixed *.jsonc config files without disturbing their comments/formatting —
# every call site below targets a whole "key": value fragment so a miss
# (typo, upstream template change) fails loudly instead of silently no-op'ing.
PATCH_LITERAL_JS='
const fs = require("fs");
const [file, search, replace] = process.argv.slice(1);
const text = fs.readFileSync(file, "utf8");
if (!text.includes(search)) {
  console.error("pattern not found in " + file + ": " + search);
  process.exit(1);
}
fs.writeFileSync(file, text.split(search).join(replace));
'
patch_literal() {
  node -e "$PATCH_LITERAL_JS" "$1" "$2" "$3"
}

# Generates a fresh throwaway keypair and writes ONLY its base58 private key
# to the (already backed-up) studio/.env — never printed, never logged.
WALLET_SETUP_JS='
const { Keypair } = require("@solana/web3.js");
const _b = require("bs58");
const bs58 = _b.default ?? _b;
const fs = require("fs");
const [envPath] = process.argv.slice(1);
const kp = Keypair.generate();
fs.writeFileSync(envPath, "PRIVATE_KEY=" + bs58.encode(kp.secretKey) + "\n");
console.log("WALLET_PUBKEY=" + kp.publicKey.toBase58());
'

# Creates a throwaway SPL mint, an ATA for the given keypair, and mints
# MINT_SUPPLY_HUMAN units to it. Needs studio's own node_modules, so the
# caller must invoke this with cwd=$STUDIO_DIR (node -e resolves `require()`
# against the current working directory, verified empirically).
MINT_SETUP_JS='
const { Connection, Keypair } = require("@solana/web3.js");
const { createMint, getOrCreateAssociatedTokenAccount, mintTo } = require("@solana/spl-token");
const fs = require("fs");

async function main() {
  const [keypairPath, rpcUrl, decimalsStr, humanAmountStr] = process.argv.slice(1);
  const decimals = parseInt(decimalsStr, 10);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const connection = new Connection(rpcUrl, "confirmed");

  const mint = await createMint(connection, payer, payer.publicKey, null, decimals);
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
  const rawAmount = BigInt(humanAmountStr) * (10n ** BigInt(decimals));
  await mintTo(connection, payer, mint, ata.address, payer, rawAmount);

  console.log("MINT=" + mint.toBase58());
}
main().catch((err) => {
  console.error("mint setup failed:", err && err.message ? err.message : err);
  process.exit(1);
});
'

# Two throwaway fee-sharing recipient pubkeys (create/fund/get-status never
# need these to sign or hold a balance, only claim would — out of scope here).
TWO_PUBKEYS_JS='
const { Keypair } = require("@solana/web3.js");
console.log(Keypair.generate().publicKey.toBase58());
console.log(Keypair.generate().publicKey.toBase58());
'

# ---------------------------------------------------------------------------
# Step runner: captures combined stdout+stderr, prints PASS/FAIL, and never
# aborts the script on a non-zero exit (no `set -e`) so later, independent
# steps still get a chance to run and report their own result.
# ---------------------------------------------------------------------------
run_step() {
  local label="$1"
  shift
  echo ""
  echo "==> ${label}"
  local rc=0
  LAST_OUTPUT="$("$@" 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[PASS] ${label}"
    RESULTS+=("PASS  ${label}")
  else
    echo "[FAIL] ${label} (exit ${rc})"
    echo "----- last 40 lines of output -----"
    echo "$LAST_OUTPUT" | tail -n 40
    echo "------------------------------------"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
  return $rc
}

skip_step() {
  local label="$1"
  local reason="$2"
  echo ""
  echo "==> ${label}"
  echo "[SKIP] ${label} (${reason})"
  RESULTS+=("SKIP  ${label} (${reason})")
  FAILURES=$((FAILURES + 1))
}

# ---------------------------------------------------------------------------
# 1. Start the localnet validator (reuses the package.json command) and wait
#    for it to answer getHealth.
# ---------------------------------------------------------------------------
VALIDATOR_LOG="$(mktemp -t e2e-helper-smoke-validator.XXXXXX)"
echo "==> Starting local validator (log: ${VALIDATOR_LOG})"
(cd "$REPO_ROOT" && pnpm studio start-test-validator) >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!

VALIDATOR_READY=0
sleep 2
for _ in $(seq 1 90); do
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "Validator process exited early."
    break
  fi
  resp="$(curl -s -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC_URL" 2>/dev/null || true)"
  if echo "$resp" | grep -q '"result":"ok"'; then
    VALIDATOR_READY=1
    break
  fi
  sleep 1
done

if [[ "$VALIDATOR_READY" -ne 1 ]]; then
  echo "ERROR: validator did not become healthy in time. Last 60 log lines:"
  tail -n 60 "$VALIDATOR_LOG" 2>/dev/null || true
  RESULTS+=("FAIL  start-test-validator (health check)")
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "==> Validator healthy at ${RPC_URL}"
RESULTS+=("PASS  start-test-validator (health check)")

# ---------------------------------------------------------------------------
# 2. Throwaway wallet: fresh keypair's base58 secret -> temp studio/.env, then
#    the documented generate-keypair + localnet airdrop flow converts it to
#    studio/keypair.json and funds it with 5 SOL.
# ---------------------------------------------------------------------------
WALLET_INFO="$(cd "$STUDIO_DIR" && node -e "$WALLET_SETUP_JS" "$ENV_FILE")"
WALLET_PUBKEY="$(echo "$WALLET_INFO" | grep '^WALLET_PUBKEY=' | cut -d= -f2)"
if [[ -z "$WALLET_PUBKEY" ]]; then
  echo "ERROR: failed to generate the throwaway wallet."
  exit 1
fi
echo "==> Throwaway wallet: ${WALLET_PUBKEY} (private key never printed)"

run_step "generate-keypair --network localnet --airdrop" \
  pnpm studio generate-keypair --network localnet --airdrop

# ---------------------------------------------------------------------------
# 3. Throwaway SPL mint, minted to the wallet — the base token both golden
#    paths lock/share.
# ---------------------------------------------------------------------------
MINT_INFO="$(cd "$STUDIO_DIR" && node -e "$MINT_SETUP_JS" "$KEYPAIR_FILE" "$RPC_URL" "$MINT_DECIMALS" "$MINT_SUPPLY_HUMAN")"
MINT="$(echo "$MINT_INFO" | grep '^MINT=' | tail -1 | cut -d= -f2)"
if [[ -z "$MINT" ]]; then
  echo "ERROR: failed to create the throwaway test mint."
  echo "$MINT_INFO"
  RESULTS+=("FAIL  create test SPL mint")
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "==> Test mint: ${MINT} (${MINT_SUPPLY_HUMAN} units minted to the wallet)"
RESULTS+=("PASS  create test SPL mint")

# ---------------------------------------------------------------------------
# 4. Met Lock golden path
# ---------------------------------------------------------------------------
patch_literal "$LOCK_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$LOCK_CONFIG" '"recipient": "YOUR_RECIPIENT_ADDRESS"' "\"recipient\": \"${WALLET_PUBKEY}\""

# dryRun stays at the template default (true) for this first call — the
# skill's own gate #1 (dry-run before every state-changing flow, first time).
run_step "lock-create-vesting-escrow (dry-run)" \
  pnpm studio lock-create-vesting-escrow --baseMint "$MINT"

patch_literal "$LOCK_CONFIG" '"dryRun": true' '"dryRun": false'

ESCROW=""
if run_step "lock-create-vesting-escrow (real send)" pnpm studio lock-create-vesting-escrow --baseMint "$MINT"; then
  ESCROW="$(echo "$LAST_OUTPUT" | grep -A1 'Escrow address (SAVE THIS' | tail -1 | tr -d '[:space:]')"
  if [[ -n "$ESCROW" ]]; then
    echo "==> Escrow: ${ESCROW}"
  else
    echo "WARNING: could not parse the escrow address out of lock-create-vesting-escrow's output."
  fi
fi

if [[ -n "$ESCROW" ]]; then
  run_step "lock-get-escrow" pnpm studio lock-get-escrow --escrow "$ESCROW"
else
  skip_step "lock-get-escrow" "no escrow address captured from the previous step"
fi

# ---------------------------------------------------------------------------
# 5. Dynamic Fee Sharing golden path
# ---------------------------------------------------------------------------
RECIPIENTS="$(cd "$STUDIO_DIR" && node -e "$TWO_PUBKEYS_JS")"
RECIPIENT_1="$(echo "$RECIPIENTS" | sed -n '1p')"
RECIPIENT_2="$(echo "$RECIPIENTS" | sed -n '2p')"

patch_literal "$FEE_SHARING_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$FEE_SHARING_CONFIG" '"address": "YOUR_RECIPIENT_ADDRESS_1"' "\"address\": \"${RECIPIENT_1}\""
patch_literal "$FEE_SHARING_CONFIG" '"address": "YOUR_RECIPIENT_ADDRESS_2"' "\"address\": \"${RECIPIENT_2}\""
# Fee sharing's golden path here runs for real directly (no separate dry-run
# demonstration) — the dry-run gate is already exercised above by Met Lock.
patch_literal "$FEE_SHARING_CONFIG" '"dryRun": true' '"dryRun": false'

VAULT=""
if run_step "fee-sharing-create-vault (2 recipients)" pnpm studio fee-sharing-create-vault --baseMint "$MINT"; then
  VAULT="$(echo "$LAST_OUTPUT" | grep 'FEE VAULT ADDRESS:' | tail -1 | sed -E 's/.*FEE VAULT ADDRESS: *//' | tr -d '[:space:]')"
  if [[ -n "$VAULT" ]]; then
    echo "==> Fee vault: ${VAULT}"
  else
    echo "WARNING: could not parse the fee vault address out of fee-sharing-create-vault's output."
  fi
fi

if [[ -n "$VAULT" ]]; then
  run_step "fee-sharing-fund" pnpm studio fee-sharing-fund --vault "$VAULT"
else
  skip_step "fee-sharing-fund" "no vault address captured from the previous step"
fi

if [[ -n "$VAULT" ]]; then
  run_step "fee-sharing-get-status" pnpm studio fee-sharing-get-status --vault "$VAULT"
else
  skip_step "fee-sharing-get-status" "no vault address captured from the create-vault step"
fi

echo ""
echo "==> Done. Created on localnet this run: mint=${MINT} escrow=${ESCROW:-<none>} feeVault=${VAULT:-<none>}"
exit 0
