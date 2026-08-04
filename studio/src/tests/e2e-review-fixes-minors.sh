#!/usr/bin/env bash
#
# e2e-review-fixes-minors.sh — localnet proof for the 8 minors + 1 doc item owned by "agent C"
# in the 4-reviewer consolidated PR-review fix pass (the blocker + majors were fixed and proven
# by other agents/scripts — see e2e-review-fixes-fee-sharing.sh / e2e-review-fixes-zap.sh):
#
#   M1/M2: Presale.deposit() already bundles a missing buyer escrow into the SAME transaction
#          for permissionless/merkle-proof modes — the old code built + sent a separate
#          create-escrow transaction first. Proven below: a first-time permissionless deposit
#          now produces exactly ONE "succeeded with tx hash" line, not two. Permissionless
#          escrow creation is also hardcoded to registry 0 on-chain (M2) — not separately
#          provable without a multi-registry presale, but documented + guarded pre-flight.
#   M3:    presale-vault-close-escrow (new action) — gated on the SDK's EscrowWrapper.canClose().
#          Proven below in BOTH branches: not-yet-closable right after depositing (still
#          Ongoing with a nonzero deposit), then closable once the presale fails and the
#          deposit is withdrawn back to zero.
#   M5:    farm-claim-all (new action) — batches PoolFarmImpl.claimAll across a configured farm
#          list. Farm CREATION itself is unwrapped by the farming-sdk (same documented,
#          deliberate gap as farm-create — see other-products.md), so no real farm can be
#          constructed here; this smokes the config/error-path plumbing instead (empty list
#          guard, and the real SDK's own non-null-safe pool fetch for an address that doesn't
#          decode as a farm).
#   M6:    stake2earn-stake now pre-checks the wallet's stake-mint (the pool's own base token —
#          M3M3 stakes the project token itself, not LP, verified against the compiled SDK)
#          balance before building a transaction. Proven with a second, funded-for-fees-only
#          wallet that holds none of the stake mint.
#   M7:    amount > 0 guards across every config-driven amount in the new families (presale,
#          alpha_vault, dynamic_vault, fee_sharing, lock, stake2earn — zap and farming already
#          had them). Every guard added by this fix runs BEFORE any network/account lookup, so
#          each is provable with a throwaway or even nonexistent target address.
#   M8:    stake2earn's getPendingUnstakes narrows its catch to the SDK's known
#          destructure-shaped TypeError (a wallet with no stake escrow at all — legitimately
#          "no pending unstakes") and rethrows anything else with context. Proven in two parts:
#          (a) the real bug path, end to end, on a never-staked wallet against a real farm,
#          resolves to the clean "no pending unstake requests" message; (b) a companion script
#          (stake2earn_rpc_failure_check.ts) monkey-patches the SDK call to simulate a genuine
#          RPC failure and confirms it surfaces as a real error instead.
#   M9:    alpha_vault's loadAlphaVault now wraps AlphaVault.create so a bad --vault produces a
#          clean "No alpha vault at ..." error instead of a raw TypeError. Proven directly — no
#          vault needs to exist at all for this one.
#
# SAFETY (mirrors e2e-helper-smoke.sh / e2e-review-fixes-fee-sharing.sh — read before editing):
#   - Never edits studio/.env, studio/keypair.json, or any studio/config/*.jsonc "in place"
#     without a net: each is backed up to "<file>.e2e-backup" before being touched (only if the
#     real file already exists, for .env/keypair.json — the config files always exist and are
#     always backed up) and restored by a trap that fires on normal exit, error, or Ctrl-C.
#     Refuses to run if a stale *.e2e-backup is already present (a previous run crashed before
#     restoring).
#   - Brand-new throwaway keypairs are generated for the run; base58/raw secret keys are written
#     straight to temporary files and never printed or logged.
#   - Idempotent: the validator runs with --reset (fresh ledger every time) and every on-chain
#     object (wallets, mints, pool, farm, presale, escrows) is freshly generated each run.
#
# Usage: studio/src/tests/e2e-review-fixes-minors.sh   (works from any cwd; paths below are
# resolved relative to this script's own location, not the caller's cwd).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${STUDIO_DIR}/.." && pwd)"

ENV_FILE="${STUDIO_DIR}/.env"
KEYPAIR_FILE="${STUDIO_DIR}/keypair.json"

PRESALE_CONFIG="${STUDIO_DIR}/config/presale_vault_config.jsonc"
ALPHA_VAULT_CONFIG="${STUDIO_DIR}/config/alpha_vault_config.jsonc"
DAMM_V1_CONFIG="${STUDIO_DIR}/config/damm_v1_config.jsonc"
DYNAMIC_VAULT_CONFIG="${STUDIO_DIR}/config/dynamic_vault_config.jsonc"
FEE_SHARING_CONFIG="${STUDIO_DIR}/config/fee_sharing_config.jsonc"
LOCK_CONFIG="${STUDIO_DIR}/config/lock_config.jsonc"
FARMING_CONFIG="${STUDIO_DIR}/config/farming_config.jsonc"

CONFIG_FILES=(
  "$PRESALE_CONFIG" "$ALPHA_VAULT_CONFIG" "$DAMM_V1_CONFIG" "$DYNAMIC_VAULT_CONFIG"
  "$FEE_SHARING_CONFIG" "$LOCK_CONFIG" "$FARMING_CONFIG"
)

ENV_BACKUP="${ENV_FILE}.e2e-backup"
KEYPAIR_BACKUP="${KEYPAIR_FILE}.e2e-backup"

RPC_URL="http://127.0.0.1:8899"
MINT_DECIMALS=6
MINT_SUPPLY_HUMAN=10000000 # comfortably covers presaleSupply/dammV1Config.baseAmount below

VALIDATOR_PID=""
VALIDATOR_LOG=""
FAILURES=0
RESULTS=()
LAST_OUTPUT=""

# ---------------------------------------------------------------------------
# Pre-flight: refuse to run if a previous crashed run left a backup unrestored.
# ---------------------------------------------------------------------------
for f in "$ENV_BACKUP" "$KEYPAIR_BACKUP"; do
  if [[ -f "$f" ]]; then
    echo "ERROR: stale backup found at ${f}" >&2
    echo "A previous run of this script likely crashed before restoring your files." >&2
    echo "Resolve this by hand before re-running." >&2
    exit 1
  fi
done
for f in "${CONFIG_FILES[@]}"; do
  if [[ -f "${f}.e2e-backup" ]]; then
    echo "ERROR: stale backup found at ${f}.e2e-backup" >&2
    echo "A previous run of this script likely crashed before restoring your files." >&2
    echo "Resolve this by hand before re-running." >&2
    exit 1
  fi
done

echo "==> e2e-review-fixes-minors: repo root ${REPO_ROOT}"
echo "==> studio dir: ${STUDIO_DIR}"

cd "$REPO_ROOT" || exit 1
rm -rf "${STUDIO_DIR}/test-ledger"

# ---------------------------------------------------------------------------
# Cleanup trap.
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

  local f
  for f in "${CONFIG_FILES[@]}"; do
    if [[ -f "${f}.e2e-backup" ]]; then
      mv -f "${f}.e2e-backup" "$f"
    fi
  done

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
  rm -f "${STUDIO_DIR}/wallet-b-keypair.e2e-throwaway.json"

  rm -rf "${STUDIO_DIR}/test-ledger"
  if [[ -n "$VALIDATOR_LOG" && -f "$VALIDATOR_LOG" ]]; then
    rm -f "$VALIDATOR_LOG"
  fi

  echo ""
  echo "===== e2e-review-fixes-minors summary ====="
  local r
  for r in "${RESULTS[@]:-}"; do
    [[ -n "$r" ]] && echo "$r"
  done
  echo "============================================="

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
for f in "${CONFIG_FILES[@]}"; do
  cp -p "$f" "${f}.e2e-backup"
done

# ---------------------------------------------------------------------------
# Small inline Node helpers (same conventions as the sibling e2e scripts).
# ---------------------------------------------------------------------------
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

# Generates a fresh throwaway keypair, writes its raw JSON secret to the given path (Wallet B —
# funded for fees only, never given any of the stake mint), airdrops it directly (no .env/
# generate-keypair round trip needed since we already have a Connection here), and prints its
# pubkey.
WALLET_B_SETUP_JS='
const { Connection, Keypair } = require("@solana/web3.js");
const fs = require("fs");

async function main() {
  const [outPath, rpcUrl] = process.argv.slice(1);
  const kp = Keypair.generate();
  fs.writeFileSync(outPath, JSON.stringify(Array.from(kp.secretKey)));
  const connection = new Connection(rpcUrl, "confirmed");
  const sig = await connection.requestAirdrop(kp.publicKey, 1_000_000_000); // 1 SOL — fees only
  await connection.confirmTransaction(sig, "confirmed");
  console.log("WALLET_B_PUBKEY=" + kp.publicKey.toBase58());
}
main().catch((err) => {
  console.error("wallet B setup failed:", err && err.message ? err.message : err);
  process.exit(1);
});
'

# N throwaway pubkeys — never funded, never used for anything except as placeholder
# --vault/--escrow/--farm/--baseMint targets for the cheap pre-flight-guard negative tests
# below, none of which reach a real network lookup before the guard fires.
N_PUBKEYS_JS='
const { Keypair } = require("@solana/web3.js");
const n = parseInt(process.argv[1], 10);
for (let i = 0; i < n; i++) {
  console.log(Keypair.generate().publicKey.toBase58());
}
'

# Computes now + offsetSeconds as a unix timestamp (used for a short-lived presaleEndTime).
# `node -e` has NO script-path placeholder in argv (verified: `node -e '...' a` gives
# process.argv === [node, a]), so the offset is process.argv[1], not [2].
FUTURE_TS_JS='
const offset = parseInt(process.argv[1], 10);
console.log(Math.floor(Date.now() / 1000) + offset);
'

# ---------------------------------------------------------------------------
# Step runner (same as e2e-helper-smoke.sh).
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

# Runs a command that is EXPECTED to fail (nonzero exit) with a specific message substring.
# Passes only if the command fails AND its output contains the expected substring — a zero exit,
# or a failure with the WRONG message, are both reported as failures (catches both a guard that
# doesn't fire and a guard that fires with the wrong words).
expect_failure_containing() {
  local label="$1"
  local expected="$2"
  shift 2
  echo ""
  echo "==> ${label} (expect failure containing: \"${expected}\")"
  local rc=0
  LAST_OUTPUT="$("$@" 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    echo "[FAIL] ${label} (command succeeded, expected it to fail)"
    echo "----- output -----"
    echo "$LAST_OUTPUT" | tail -n 40
    echo "------------------"
    RESULTS+=("FAIL  ${label} (unexpectedly succeeded)")
    FAILURES=$((FAILURES + 1))
    return 1
  fi
  if echo "$LAST_OUTPUT" | grep -qF "$expected"; then
    echo "[PASS] ${label}"
    RESULTS+=("PASS  ${label}")
    return 0
  fi
  echo "[FAIL] ${label} (failed, but not with the expected message)"
  echo "----- last 40 lines of output -----"
  echo "$LAST_OUTPUT" | tail -n 40
  echo "------------------------------------"
  RESULTS+=("FAIL  ${label} (wrong error message)")
  FAILURES=$((FAILURES + 1))
  return 1
}

skip_step() {
  local label="$1"
  local reason="$2"
  echo ""
  echo "==> ${label}"
  echo "[SKIP] ${label} (${reason})"
  RESULTS+=("SKIP  ${label} (${reason})")
}

# ---------------------------------------------------------------------------
# 1. Start the localnet validator and wait for it to answer getHealth.
# ---------------------------------------------------------------------------
VALIDATOR_LOG="$(mktemp -t e2e-review-fixes-minors-validator.XXXXXX)"
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
# 2. Throwaway wallet A (main) + airdrop, via the documented flow.
# ---------------------------------------------------------------------------
WALLET_INFO="$(cd "$STUDIO_DIR" && node -e "$WALLET_SETUP_JS" "$ENV_FILE")"
WALLET_PUBKEY="$(echo "$WALLET_INFO" | grep '^WALLET_PUBKEY=' | cut -d= -f2)"
if [[ -z "$WALLET_PUBKEY" ]]; then
  echo "ERROR: failed to generate the throwaway wallet."
  exit 1
fi
echo "==> Throwaway wallet A: ${WALLET_PUBKEY} (private key never printed)"

run_step "generate-keypair --network localnet --airdrop" \
  pnpm studio generate-keypair --network localnet --airdrop
# One airdrop of 5 SOL isn't enough headroom for everything this script does (presale create +
# deposit, damm-v1 pool + farm create, several stake2earn ops) — top up.
run_step "airdrop-sol --network localnet (top-up)" pnpm studio airdrop-sol --network localnet

# ---------------------------------------------------------------------------
# 3. Two throwaway SPL mints (presale base token, damm_v1 base token) minted to wallet A.
# ---------------------------------------------------------------------------
PRESALE_MINT_INFO="$(cd "$STUDIO_DIR" && node -e "$MINT_SETUP_JS" "$KEYPAIR_FILE" "$RPC_URL" "$MINT_DECIMALS" "$MINT_SUPPLY_HUMAN")"
PRESALE_MINT="$(echo "$PRESALE_MINT_INFO" | grep '^MINT=' | tail -1 | cut -d= -f2)"
if [[ -z "$PRESALE_MINT" ]]; then
  echo "ERROR: failed to create the presale test mint."
  echo "$PRESALE_MINT_INFO"
  exit 1
fi
echo "==> Presale base mint: ${PRESALE_MINT}"

DAMM_V1_MINT_INFO="$(cd "$STUDIO_DIR" && node -e "$MINT_SETUP_JS" "$KEYPAIR_FILE" "$RPC_URL" "$MINT_DECIMALS" "$MINT_SUPPLY_HUMAN")"
DAMM_V1_MINT="$(echo "$DAMM_V1_MINT_INFO" | grep '^MINT=' | tail -1 | cut -d= -f2)"
if [[ -z "$DAMM_V1_MINT" ]]; then
  echo "ERROR: failed to create the damm_v1 test mint."
  echo "$DAMM_V1_MINT_INFO"
  exit 1
fi
echo "==> DAMM v1 base mint: ${DAMM_V1_MINT}"

# 5 throwaway placeholder pubkeys for the cheap pre-flight negative tests below (never funded;
# every guard they hit fires before any real lookup of these addresses). Read line-by-line
# rather than `mapfile`/`readarray` — this runs under macOS's stock bash 3.2, which has neither.
PLACEHOLDER_PUBKEYS_RAW="$(cd "$STUDIO_DIR" && node -e "$N_PUBKEYS_JS" 5)"
PLACEHOLDER_1="$(echo "$PLACEHOLDER_PUBKEYS_RAW" | sed -n '1p')"
PLACEHOLDER_2="$(echo "$PLACEHOLDER_PUBKEYS_RAW" | sed -n '2p')"
PLACEHOLDER_3="$(echo "$PLACEHOLDER_PUBKEYS_RAW" | sed -n '3p')"
PLACEHOLDER_4="$(echo "$PLACEHOLDER_PUBKEYS_RAW" | sed -n '4p')"
PLACEHOLDER_5="$(echo "$PLACEHOLDER_PUBKEYS_RAW" | sed -n '5p')"
echo "==> Placeholder pubkeys ready (never funded, never created on-chain)"

echo ""
echo "############################################################"
echo "# SECTION A — M1 / M2 / M3: Presale deposit + close-escrow  #"
echo "############################################################"

# ---------------------------------------------------------------------------
# 4. Configure a short-lived permissionless FCFS presale so it reliably reaches Failed a few
#    seconds after we deposit less than presaleMinimumCap.
# ---------------------------------------------------------------------------
patch_literal "$PRESALE_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$PRESALE_CONFIG" '"presaleSupply": 100000000000000,' '"presaleSupply": 1000000000,'

# The program enforces MINIMUM_PRESALE_DURATION = 60s (constants.rs) between start and end —
# presaleStartTime is 0 (the program treats that as "now", per
# get_presale_start_time_without_going_backwards), so this must clear 60s with margin.
PRESALE_END_TIME="$(cd "$STUDIO_DIR" && node -e "$FUTURE_TS_JS" 75)"
patch_literal "$PRESALE_CONFIG" '"presaleEndTime": 1760954400,' "\"presaleEndTime\": ${PRESALE_END_TIME},"
echo "==> presaleEndTime set to ${PRESALE_END_TIME} (~75s from now)"

# The template's default deposit amount (1 SOL) equals presaleMinimumCap exactly, which would
# make the presale Completed, not Failed, once presaleEndTime passes. Depositing less than
# presaleMinimumCap (1 SOL) — but still within this registry's own 0.01-1 SOL caps — is what
# drives the presale to Failed below, needed to prove M3's "not yet closable" -> "closable"
# transition without waiting out a real vesting schedule (Completed's canClose() instead
# requires everything CLAIMED, i.e. fully vested — a much longer wait).
patch_literal "$PRESALE_CONFIG" '"amount": 1, // amount to deposit, in quote token human units' \
  '"amount": 0.05, // amount to deposit, in quote token human units'

patch_literal "$PRESALE_CONFIG" '"dryRun": true' '"dryRun": false'

PRESALE=""
if run_step "presale-vault-create --baseMint (permissionless FCFS)" pnpm studio presale-vault-create --baseMint "$PRESALE_MINT"; then
  PRESALE="$(echo "$LAST_OUTPUT" | grep -E 'Presale Address:' | tail -1 | sed -E 's/.*Presale Address: *//' | tr -d '[:space:]')"
fi
if [[ -z "$PRESALE" ]]; then
  echo "ERROR: could not determine the created presale address from presale-vault-create output."
  echo "$LAST_OUTPUT"
  exit 1
fi
echo "==> Presale: ${PRESALE}"

# ---------------------------------------------------------------------------
# 5. M1/M2 — deposit for the first time (permissionless, registry 0): must be exactly ONE
#    "succeeded with tx hash" line, proving Presale.deposit() bundled escrow creation instead of
#    a separate create-escrow transaction. Corroborated independently via the wallet's own
#    on-chain signature count before/after (not just the action's own log line).
# ---------------------------------------------------------------------------
SIG_COUNT_JS='
const { Connection, PublicKey } = require("@solana/web3.js");
async function main() {
  const [rpcUrl, pubkey] = process.argv.slice(1);
  const connection = new Connection(rpcUrl, "confirmed");
  const sigs = await connection.getSignaturesForAddress(new PublicKey(pubkey), { limit: 1000 });
  console.log(sigs.length);
}
main();
'
SIG_COUNT_BEFORE="$(cd "$STUDIO_DIR" && node -e "$SIG_COUNT_JS" "$RPC_URL" "$WALLET_PUBKEY")"

run_step "presale-vault-deposit --vault (first-time permissionless deposit)" \
  pnpm studio presale-vault-deposit --vault "$PRESALE"
DEPOSIT_OUTPUT="$LAST_OUTPUT"
TX_HASH_COUNT="$(echo "$DEPOSIT_OUTPUT" | grep -c 'succeeded with tx hash:')"
echo "==> tx-hash lines in presale-vault-deposit output: ${TX_HASH_COUNT}"
if [[ "$TX_HASH_COUNT" -eq 1 ]]; then
  TX_SIG="$(echo "$DEPOSIT_OUTPUT" | grep 'succeeded with tx hash:' | tail -1 | sed -E 's/.*tx hash: *//' | tr -d '[:space:]')"
  echo "[PASS] M1/M2: exactly ONE transaction for the first-time permissionless deposit (tx ${TX_SIG})"
  RESULTS+=("PASS  M1/M2 one-tx deposit (tx ${TX_SIG})")
else
  echo "[FAIL] M1/M2: expected exactly 1 tx-hash line, got ${TX_HASH_COUNT}"
  RESULTS+=("FAIL  M1/M2 one-tx deposit (got ${TX_HASH_COUNT} tx-hash lines)")
  FAILURES=$((FAILURES + 1))
fi

SIG_COUNT_AFTER="$(cd "$STUDIO_DIR" && node -e "$SIG_COUNT_JS" "$RPC_URL" "$WALLET_PUBKEY")"
SIG_COUNT_DELTA=$((SIG_COUNT_AFTER - SIG_COUNT_BEFORE))
echo "==> Wallet A signature count: ${SIG_COUNT_BEFORE} before -> ${SIG_COUNT_AFTER} after (delta ${SIG_COUNT_DELTA})"
if [[ "$SIG_COUNT_DELTA" -eq 1 ]]; then
  echo "[PASS] M1/M2: on-chain signature count corroborates exactly one new transaction"
  RESULTS+=("PASS  M1/M2 one-tx deposit (on-chain signature delta = 1)")
else
  echo "[FAIL] M1/M2: expected the wallet's signature count to grow by exactly 1, got ${SIG_COUNT_DELTA}"
  RESULTS+=("FAIL  M1/M2 one-tx deposit (on-chain signature delta = ${SIG_COUNT_DELTA}, not 1)")
  FAILURES=$((FAILURES + 1))
fi

# ---------------------------------------------------------------------------
# 6. M3 branch 1 — NOT yet closable (presale still Ongoing, deposit > 0).
# ---------------------------------------------------------------------------
expect_failure_containing "presale-vault-close-escrow (not yet closable — still ongoing)" \
  "is closable right now" \
  pnpm studio presale-vault-close-escrow --vault "$PRESALE"

# ---------------------------------------------------------------------------
# 7. Wait for presaleEndTime to pass, then confirm the presale is now Failed (deposit was well
#    under presaleMinimumCap).
# ---------------------------------------------------------------------------
NOW_TS="$(cd "$STUDIO_DIR" && node -e "$FUTURE_TS_JS" 0)"
WAIT_SECS=$((PRESALE_END_TIME - NOW_TS + 8))
if [[ "$WAIT_SECS" -gt 0 ]]; then
  echo "==> Waiting ${WAIT_SECS}s for presaleEndTime to pass..."
  sleep "$WAIT_SECS"
fi

run_step "presale-vault-get-status --vault (expect Failed)" \
  pnpm studio presale-vault-get-status --vault "$PRESALE"
if echo "$LAST_OUTPUT" | grep -q 'Progress:.*Failed'; then
  echo "[PASS] presale reached Failed as expected"
  RESULTS+=("PASS  presale reached Failed")
else
  echo "[FAIL] presale did not report Failed progress"
  echo "$LAST_OUTPUT" | tail -20
  RESULTS+=("FAIL  presale reached Failed")
  FAILURES=$((FAILURES + 1))
fi

run_step "presale-vault-withdraw-remaining-quote --vault (refund full deposit)" \
  pnpm studio presale-vault-withdraw-remaining-quote --vault "$PRESALE"

# ---------------------------------------------------------------------------
# 8. M3 branch 2 — now closable (deposit back to zero after the Failed refund).
# ---------------------------------------------------------------------------
run_step "presale-vault-close-escrow --vault (now closable)" \
  pnpm studio presale-vault-close-escrow --vault "$PRESALE"
if echo "$LAST_OUTPUT" | grep -q 'closable' && echo "$LAST_OUTPUT" | grep -q 'succeeded with tx hash'; then
  echo "[PASS] M3: escrow closed for real once eligible"
  RESULTS+=("PASS  M3 close-escrow (closable branch)")
else
  echo "[FAIL] M3: expected the escrow to close for real this time"
  RESULTS+=("FAIL  M3 close-escrow (closable branch)")
  FAILURES=$((FAILURES + 1))
fi

echo ""
echo "############################################################"
echo "# SECTION B — M7 cheap negative tests (amount > 0 guards)   #"
echo "############################################################"

patch_literal "$ALPHA_VAULT_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$DYNAMIC_VAULT_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$FEE_SHARING_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$LOCK_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'

# Presale: negative deposit / zero withdraw (registry already has an escrow from Section A, but
# the amount guard fires before that even matters). presaleDeposit.amount is 0.05 at this point
# (patched in Section A, down from the template's default 1).
patch_literal "$PRESALE_CONFIG" '"amount": 0.05, // amount to deposit, in quote token human units' \
  '"amount": -1, // amount to deposit, in quote token human units'
expect_failure_containing "presale-vault-deposit (amount = -1)" "presaleDeposit.amount must be > 0" \
  pnpm studio presale-vault-deposit --vault "$PRESALE"

patch_literal "$PRESALE_CONFIG" '"amount": 1, // amount to withdraw, in quote token human units' \
  '"amount": 0, // amount to withdraw, in quote token human units'
expect_failure_containing "presale-vault-withdraw (amount = 0)" "presaleWithdraw.amount must be > 0" \
  pnpm studio presale-vault-withdraw --vault "$PRESALE"

# Alpha Vault: guard fires before the (nonexistent) vault is ever looked up.
patch_literal "$ALPHA_VAULT_CONFIG" \
  '"amount": 1 // amount to deposit, in quote token human units' \
  '"amount": -1 // amount to deposit, in quote token human units'
expect_failure_containing "alpha-vault-deposit (amount = -1, nonexistent vault)" \
  "alphaVaultDeposit.amount must be > 0" \
  pnpm studio alpha-vault-deposit --vault "$PLACEHOLDER_1"

patch_literal "$ALPHA_VAULT_CONFIG" \
  '"amount": 1 // amount to withdraw, in quote token human units' \
  '"amount": 0 // amount to withdraw, in quote token human units'
expect_failure_containing "alpha-vault-withdraw (amount = 0, nonexistent vault)" \
  "alphaVaultWithdraw.amount must be > 0" \
  pnpm studio alpha-vault-withdraw --vault "$PLACEHOLDER_1"

# Dynamic Vault: guard fires before the (nonexistent) vault is ever looked up.
patch_literal "$DYNAMIC_VAULT_CONFIG" \
  '"amount": 1 // amount to deposit, in baseMint human units (e.g. 1 = 1 USDC for a 6-decimal USDC mint)' \
  '"amount": -1 // amount to deposit, in baseMint human units (e.g. 1 = 1 USDC for a 6-decimal USDC mint)'
expect_failure_containing "vault-deposit (amount = -1, nonexistent vault)" \
  "dynamicVaultDeposit.amount must be > 0" \
  pnpm studio vault-deposit --baseMint "$PLACEHOLDER_2"

# The concrete bug the reviewer flagged: a NEGATIVE withdraw amount used to slip past the
# `amountLamports.gt(lpBalance)` upper-bound check (negative is never .gt() a non-negative
# balance). Proven directly: it is now rejected before that check even runs.
patch_literal "$DYNAMIC_VAULT_CONFIG" \
  '"amount": 1 // amount of VAULT LP TOKENS to redeem, in human units (see UNIT WARNING above)' \
  '"amount": -5 // amount of VAULT LP TOKENS to redeem, in human units (see UNIT WARNING above)'
expect_failure_containing "vault-withdraw (amount = -5, nonexistent vault)" \
  "dynamicVaultWithdraw.amount must be > 0" \
  pnpm studio vault-withdraw --baseMint "$PLACEHOLDER_2"

# Fee Sharing: guard fires before the (nonexistent) vault is ever looked up.
patch_literal "$FEE_SHARING_CONFIG" '"amount": 1' '"amount": 0'
expect_failure_containing "fee-sharing-fund (amount = 0, nonexistent vault)" \
  "feeSharingFund.amount must be > 0" \
  pnpm studio fee-sharing-fund --vault "$PLACEHOLDER_3"

# Met Lock: negative cliffUnlockAmount, and a negative lockClaim.maxAmount against a nonexistent
# escrow (guard fires before the escrow lookup).
patch_literal "$LOCK_CONFIG" '"cliffUnlockAmount": 2500,' '"cliffUnlockAmount": -1,'
expect_failure_containing "lock-create-vesting-escrow (cliffUnlockAmount = -1)" \
  "lockCreateEscrow.cliffUnlockAmount must be >= 0" \
  pnpm studio lock-create-vesting-escrow --baseMint "$PRESALE_MINT"

patch_literal "$LOCK_CONFIG" '"maxAmount": null' '"maxAmount": -5'
expect_failure_containing "lock-claim (maxAmount = -5, nonexistent escrow)" \
  "lockClaim.maxAmount must be null or > 0" \
  pnpm studio lock-claim --escrow "$PLACEHOLDER_4"

echo ""
echo "############################################################"
echo "# SECTION C — M9: alpha-vault clean error for a bad --vault #"
echo "############################################################"

expect_failure_containing "alpha-vault-get-status --vault (nonexistent vault)" \
  "No alpha vault at" \
  pnpm studio alpha-vault-get-status --vault "$PLACEHOLDER_5"

echo ""
echo "############################################################"
echo "# SECTION D — M6 / M7(stake2earn) / M8: DAMM v1 + Stake2Earn #"
echo "############################################################"

patch_literal "$DAMM_V1_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$DAMM_V1_CONFIG" '"dryRun": true' '"dryRun": false'
# createDammV1Pool validates the WHOLE config object (validateDammV1ConfigFields), including
# dammV1LockLiquidity's placeholder addresses, even though this run never calls
# damm-v1-lock-liquidity — replace them with something that at least parses as a real address.
patch_literal "$DAMM_V1_CONFIG" '"address": "YOUR_ADDRESS_1"' "\"address\": \"${WALLET_PUBKEY}\""
patch_literal "$DAMM_V1_CONFIG" '"address": "YOUR_ADDRESS_2"' "\"address\": \"${WALLET_PUBKEY}\""
# Incidental finding (not one of this pass's M1-M9 items, so only worked around here, not fixed
# in the shipped template): stake2EarnFarm.startFeeDistributeTimestamp ships as a fixed PAST
# unix timestamp. The stake-for-fee program computes
# `start_fee_distribute_timestamp.checked_sub(current_timestamp)` (initialize_vault.rs:46-48)
# with NO clamping — once real time passes that fixed timestamp, this underflows (u64) and
# InitializeVault always fails with AnchorError MathOverflow (6015). Patched here to "now" so
# damm-v1-create-stake2earn-farm can succeed regardless of when this script runs.
FARM_START_FEE_TS="$(cd "$STUDIO_DIR" && node -e "$FUTURE_TS_JS" 0)"
patch_literal "$DAMM_V1_CONFIG" '"startFeeDistributeTimestamp": 1753441790' \
  "\"startFeeDistributeTimestamp\": ${FARM_START_FEE_TS}"

DAMM_V1_POOL=""
if run_step "damm-v1-create-pool --baseMint" pnpm studio damm-v1-create-pool --baseMint "$DAMM_V1_MINT"; then
  DAMM_V1_POOL="$(echo "$LAST_OUTPUT" | grep -E '^> Pool address:' | tail -1 | sed -E 's/.*Pool address: *//' | tr -d '[:space:]')"
fi
if [[ -z "$DAMM_V1_POOL" ]]; then
  echo "ERROR: could not determine the created DAMM v1 pool address."
  echo "$LAST_OUTPUT"
  exit 1
fi
echo "==> DAMM v1 pool: ${DAMM_V1_POOL}"

run_step "damm-v1-create-stake2earn-farm --baseMint" \
  pnpm studio damm-v1-create-stake2earn-farm --baseMint "$DAMM_V1_MINT"

# --- M7 (stake2earn) — cheap, guard fires before loadStakeForFee/any farm lookup. ---
patch_literal "$DAMM_V1_CONFIG" \
  '"amount": 100 // amount of the stake mint to stake, in human (stake-token) units' \
  '"amount": -1 // amount of the stake mint to stake, in human (stake-token) units'
expect_failure_containing "stake2earn-stake (amount = -1)" "stake2EarnStake.amount must be > 0" \
  pnpm studio stake2earn-stake --poolAddress "$DAMM_V1_POOL"

patch_literal "$DAMM_V1_CONFIG" \
  '"amount": 50 // amount of the stake mint to unstake, in human (stake-token) units; must not exceed' \
  '"amount": 0 // amount of the stake mint to unstake, in human (stake-token) units; must not exceed'
expect_failure_containing "stake2earn-unstake (amount = 0)" "stake2EarnUnstake.amount must be > 0" \
  pnpm studio stake2earn-unstake --poolAddress "$DAMM_V1_POOL"

patch_literal "$DAMM_V1_CONFIG" '"maxFee": null // null = claim all pending fees' \
  '"maxFee": -5 // null = claim all pending fees'
expect_failure_containing "stake2earn-claim-fee (maxFee = -5)" "stake2EarnClaim.maxFee must be null or > 0" \
  pnpm studio stake2earn-claim-fee --poolAddress "$DAMM_V1_POOL"
patch_literal "$DAMM_V1_CONFIG" '"maxFee": -5 // null = claim all pending fees' \
  '"maxFee": null // null = claim all pending fees'

# --- M6 + M8(a): wallet B — funded for fees, holds NONE of the stake mint, never staked. ---
WALLET_B_KEYPAIR="${STUDIO_DIR}/wallet-b-keypair.e2e-throwaway.json"
WALLET_B_INFO="$(cd "$STUDIO_DIR" && node -e "$WALLET_B_SETUP_JS" "$WALLET_B_KEYPAIR" "$RPC_URL")"
WALLET_B_PUBKEY="$(echo "$WALLET_B_INFO" | grep '^WALLET_B_PUBKEY=' | cut -d= -f2)"
echo "==> Throwaway wallet B: ${WALLET_B_PUBKEY} (holds SOL for fees only, no stake mint, never staked)"

cp -p "$KEYPAIR_FILE" "${KEYPAIR_FILE}.wallet-a.e2e-tmp"
cp -p "$WALLET_B_KEYPAIR" "$KEYPAIR_FILE"

patch_literal "$DAMM_V1_CONFIG" \
  '"amount": -1 // amount of the stake mint to stake, in human (stake-token) units' \
  '"amount": 1 // amount of the stake mint to stake, in human (stake-token) units'
expect_failure_containing "stake2earn-stake as wallet B (holds 0 of the stake mint)" \
  "fund the wallet's stake-mint token account first" \
  pnpm studio stake2earn-stake --poolAddress "$DAMM_V1_POOL"

expect_failure_containing "stake2earn-cancel-unstake as wallet B (never staked — legit empty path)" \
  "No pending unstake requests found" \
  pnpm studio stake2earn-cancel-unstake --poolAddress "$DAMM_V1_POOL"

cp -p "${KEYPAIR_FILE}.wallet-a.e2e-tmp" "$KEYPAIR_FILE"
rm -f "${KEYPAIR_FILE}.wallet-a.e2e-tmp"
echo "==> Restored wallet A as the active keypair.json"

# --- M8(b): synthetic RPC failure must surface as a real error, not "no pending unstakes". ---
run_step "stake2earn_rpc_failure_check.ts (synthetic RPC failure surfaces)" \
  npx tsx "${SCRIPT_DIR}/stake2earn_rpc_failure_check.ts" "$RPC_URL" "$WALLET_B_KEYPAIR" "$DAMM_V1_POOL"

echo ""
echo "############################################################"
echo "# SECTION E — M5: farm-claim-all config/error-path smoke    #"
echo "############################################################"

patch_literal "$FARMING_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'

expect_failure_containing "farm-claim-all (empty farms list)" \
  "Missing farmClaimAll.farms in configuration" \
  pnpm studio farm-claim-all

patch_literal "$FARMING_CONFIG" '"farms": []' "\"farms\": [\"${PLACEHOLDER_1}\"]"
# Expected outcome, not a bug: PoolFarmImpl.getClaimableRewards has no null guard for a pool
# address that doesn't decode as a farm ("Pool state not found" — verified against the compiled
# farming-sdk source) — the same non-null-safe behavior every other farm-* action already has
# for a bad --farm/--poolAddress, pre-existing and out of scope for this fix pass. This proves
# farm-claim-all's own plumbing (config parsing, PublicKey resolution) reaches that real SDK
# call rather than silently reporting "nothing claimable" for an address that isn't a farm.
expect_failure_containing "farm-claim-all (nonexistent farm address — real farm creation is unwrapped, same as farm-create)" \
  "Pool state not found" \
  pnpm studio farm-claim-all
echo "==> Note: farm-claim-all reached the real SDK call for a nonexistent farm and errored"
echo "==> instead of silently reporting nothing claimable (see output above/below). A full"
echo "==> real-money run needs 2+ pre-existing, staked, reward-emitting Pool Farms, which no"
echo "==> studio action (or unwrapped SDK call) can construct from scratch — the same"
echo "==> documented gap as farm-create. This is the strongest proof available without"
echo "==> hand-rolling raw initializePool/fund/authorizeFunder instructions off the IDL."

echo ""
echo "==> Done."
echo "==> Presale: ${PRESALE} | DAMM v1 pool: ${DAMM_V1_POOL}"
exit 0
