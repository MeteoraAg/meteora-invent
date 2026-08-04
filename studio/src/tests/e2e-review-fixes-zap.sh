#!/usr/bin/env bash
#
# e2e-review-fixes-zap.sh — localnet proof for the PR-review fixes owned by the "zap" family
# (F3 + F4 from the 4-reviewer consolidated fix pass), against a REAL DAMM v2 pool.
#
#   F3: `sendOrderedTransactions` used to promise "Re-run the same command to resume" on any
#       mid-bundle abort, but zap-in mints a FRESH position keypair every invocation, so a
#       re-run after a late-stage live failure performs a SECOND REAL DEPOSIT instead of
#       resuming. Fixed by adding a required `retry: { retrySafety, recoveryAddress }` param:
#       zap-in call sites pass `retrySafety: 'not-idempotent'` and the position address, and
#       the abort message now says plainly that re-running does NOT resume and names what to
#       inspect first — proven below via a REAL forced mid-bundle abort on a zap-in-COMPATIBLE
#       (fee-scheduler) pool; see the PRE-FLIGHT GUARD note below for why a rate-limiter pool
#       can no longer be used to force this (it now gets refused before anything is built).
#   F4: with the shipped default `positionMode: "new"`, dry-run used to simulate each step of
#       the zap-in bundle INDEPENDENTLY against unchanged chain state. EMPIRICALLY CONFIRMED
#       on localnet (see the two findings below) that this failed the "zap in" step's
#       simulation with Anchor error 3007 `AccountOwnedByWrongProgram` on the `ledger` account
#       (created by the immediately-preceding "ledger update" step, which a simulation never
#       actually lands) — the same class of bug the reviewer hypothesized for the `position`
#       account, just manifesting through a different account first. Fixed by combining
#       create-position (if any) + setup + ledger into ONE real transaction, and marking "zap
#       in" / "clean up" `dependsOnPriorStep: true` so dry-run honestly DEFERS simulating them
#       instead of misreporting a failure — proven below via a before/after dry-run and a full
#       live send that actually lands a real deposit.
#
# PRE-FLIGHT GUARD (this WAS the "separate finding" in an earlier revision of this script;
# it has since been FIXED, not merely documented — see `assertPoolIsZapInCompatible` in
# studio/src/lib/zap/index.ts, commit 4eef9d9): while chasing F4's live-send proof, testing
# turned up that `damm_v2_config.jsonc`'s TEMPLATE DEFAULT `baseFeeMode: 2` (Rate Limiter)
# makes ANY real send of zap-in-damm-v2's "zap in" step fail on-chain with `AnchorError ...
# FailToValidateSingleSwapInstruction` (cp-amm error 6049), REGARDLESS of transaction structure
# (confirmed: still fails even with "zap in" fully isolated in its own transaction, alone) — a
# fundamental incompatibility between the zap program's CPI-based swap and the Rate Limiter fee
# mode's on-chain validation, not a dry-run/mid-bundle-ordering issue. A dry run can't surface
# this (zap-in is one of the steps `dependsOnPriorStep` legitimately defers until a live send),
# so `zapInDammV2` now decodes the pool's base-fee handler and REFUSES up front — before
# building or sending anything — the moment it sees a Rate Limiter pool. That means the
# rate-limiter pool can no longer be used to force a MID-BUNDLE F3 abort (the guard now
# intercepts it earlier than that); instead it is repurposed below as PART A, proving the guard
# itself fires with its actionable message before any transaction is sent. F3's mid-bundle
# abort proof moves to PART B, forced instead on the zap-in-COMPATIBLE fee-scheduler pool via
# `maxSqrtPriceChangeBps: 0` — verified against the zap-program repo's own source
# (programs/zap/src/instructions/ix_zap_in_damm_v2.rs): the on-chain check is
# `require!(sqrt_price_change_bps <= max_sqrt_price_change_bps, ...)`, and `get_price_change_bps`
# (in that program's utils/damm_v2_utils.rs) rounds the observed change UP (`div_ceil`) before
# comparing, so ANY nonzero swap reports at least 1 bps of change — which
# can never be <= 0. The zap-in bundle's deposit is guaranteed to trigger a real swap here
# (a fresh, empty position funded 100% single-sided in one input mint cannot be balanced
# without one), so this fails deterministically, after the earlier "create position + setup +
# ledger" step has already landed for real — a genuine mid-bundle abort, unlike the rate
# limiter case above.
#
# This script builds real chain state the existing e2e-*.sh scripts don't touch: a throwaway
# SPL mint -> TWO real balanced DAMM v2 pools (one left at the template's default Rate Limiter
# fee mode specifically so PART A can prove the pre-flight guard refuses it; one switched to a
# Linear Fee Scheduler so F4's fix can be proven with an actual successful end-to-end deposit,
# then reused for PART B's forced mid-bundle abort) -> zap-in-damm-v2 exercised in both
# positionMode "existing" and "new", dry-run and live-send.
#
# SAFETY (mirrors e2e-helper-smoke.sh / e2e-review-fixes-fee-sharing.sh — read before editing):
#   - Never edits studio/.env, studio/keypair.json, studio/config/damm_v2_config.jsonc or
#     studio/config/zap_config.jsonc "in place" without a net: each is backed up to
#     "<file>.e2e-backup" before being touched (only if the real file already exists) and
#     restored by a trap that fires on normal exit, error, or Ctrl-C. Refuses to run if a stale
#     *.e2e-backup is already present (a previous run crashed before restoring).
#   - A brand-new throwaway keypair is generated for the run; its base58 private key is written
#     straight to the temporary studio/.env and is never printed or logged. No secret key is
#     ever printed by this script or by the code paths it exercises.
#   - Idempotent: the validator runs with --reset (fresh ledger every time) and every on-chain
#     object (wallet, mint, pools, positions) is freshly generated each run.
#
# Usage: studio/src/tests/e2e-review-fixes-zap.sh   (works from any cwd; paths below are
# resolved relative to this script's own location, not the caller's cwd).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${STUDIO_DIR}/.." && pwd)"

ENV_FILE="${STUDIO_DIR}/.env"
KEYPAIR_FILE="${STUDIO_DIR}/keypair.json"
DAMM_V2_CONFIG="${STUDIO_DIR}/config/damm_v2_config.jsonc"
ZAP_CONFIG="${STUDIO_DIR}/config/zap_config.jsonc"

ENV_BACKUP="${ENV_FILE}.e2e-backup"
KEYPAIR_BACKUP="${KEYPAIR_FILE}.e2e-backup"
DAMM_V2_CONFIG_BACKUP="${DAMM_V2_CONFIG}.e2e-backup"
ZAP_CONFIG_BACKUP="${ZAP_CONFIG}.e2e-backup"

RPC_URL="http://127.0.0.1:8899"
MINT_DECIMALS=6
MINT_SUPPLY_HUMAN=150000000

VALIDATOR_PID=""
VALIDATOR_LOG=""
FAILURES=0
RESULTS=()
LAST_OUTPUT=""

# ---------------------------------------------------------------------------
# Pre-flight: refuse to run if a previous crashed run left a backup unrestored.
# ---------------------------------------------------------------------------
for f in "$ENV_BACKUP" "$KEYPAIR_BACKUP" "$DAMM_V2_CONFIG_BACKUP" "$ZAP_CONFIG_BACKUP"; do
  if [[ -f "$f" ]]; then
    echo "ERROR: stale backup found at ${f}" >&2
    echo "A previous run of this script likely crashed before restoring your files." >&2
    echo "Resolve this by hand (inspect + restore or remove the backup) before re-running." >&2
    exit 1
  fi
done

echo "==> e2e-review-fixes-zap: repo root ${REPO_ROOT}"
echo "==> studio dir: ${STUDIO_DIR}"

cd "$REPO_ROOT" || exit 1
rm -rf "${STUDIO_DIR}/test-ledger"

# ---------------------------------------------------------------------------
# Cleanup trap — see e2e-helper-smoke.sh for the pattern this mirrors.
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

  if [[ -f "$DAMM_V2_CONFIG_BACKUP" ]]; then
    mv -f "$DAMM_V2_CONFIG_BACKUP" "$DAMM_V2_CONFIG"
  fi
  if [[ -f "$ZAP_CONFIG_BACKUP" ]]; then
    mv -f "$ZAP_CONFIG_BACKUP" "$ZAP_CONFIG"
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
  echo "===== e2e-review-fixes-zap summary ====="
  local r
  for r in "${RESULTS[@]:-}"; do
    [[ -n "$r" ]] && echo "$r"
  done
  echo "========================================="

  if [[ $exit_code -ne 0 ]]; then
    echo "==> Aborted early (exit code ${exit_code}) — see output above."
  elif [[ "$FAILURES" -gt 0 ]]; then
    echo "==> Completed with ${FAILURES} failed step(s)."
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
cp -p "$DAMM_V2_CONFIG" "$DAMM_V2_CONFIG_BACKUP"
cp -p "$ZAP_CONFIG" "$ZAP_CONFIG_BACKUP"

# ---------------------------------------------------------------------------
# Small inline Node helpers (see e2e-helper-smoke.sh's own comment on `node -e`
# argv semantics — process.argv.slice(1), not slice(2)).
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
main().catch((err) => { console.error("mint setup failed:", err && err.message ? err.message : err); process.exit(1); });
'

# A single large direct airdrop (localnet only, no real cost) rather than two identical
# 5-SOL requests back to back — verified empirically that two such requests within the same
# slot compile to the SAME transaction (identical blockhash) and only the first one actually
# lands, silently capping the wallet at 5 SOL instead of 10.
EXTRA_AIRDROP_JS='
const { Connection, PublicKey } = require("@solana/web3.js");
async function main() {
  const [rpcUrl, pubkeyStr, solAmountStr] = process.argv.slice(1);
  const connection = new Connection(rpcUrl, "confirmed");
  const lamports = Math.floor(parseFloat(solAmountStr) * 1e9);
  const sig = await connection.requestAirdrop(new PublicKey(pubkeyStr), lamports);
  await connection.confirmTransaction(sig, "confirmed");
  console.log("EXTRA_AIRDROP_SIG=" + sig);
}
main().catch((err) => { console.error("extra airdrop failed:", err && err.message ? err.message : err); process.exit(1); });
'

# ---------------------------------------------------------------------------
# Step runners — same contract as e2e-helper-smoke.sh's run_step/skip_step, plus the
# substring-assertion variants this script also needs.
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
    echo "----- last 60 lines of output -----"
    echo "$LAST_OUTPUT" | tail -n 60
    echo "------------------------------------"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
  return $rc
}

# Runs a command expected to FAIL (nonzero exit) with a specific substring in its output.
run_step_expect_fail() {
  local label="$1"
  local expected_substring="$2"
  shift 2
  echo ""
  echo "==> ${label}"
  local rc=0
  LAST_OUTPUT="$("$@" 2>&1)"
  rc=$?
  if [[ $rc -ne 0 ]] && echo "$LAST_OUTPUT" | grep -qF "$expected_substring"; then
    echo "[PASS] ${label} (failed as expected, contains: \"${expected_substring}\")"
    RESULTS+=("PASS  ${label} (expected failure)")
  else
    echo "[FAIL] ${label} (exit ${rc}; expected a failure containing \"${expected_substring}\")"
    echo "----- last 60 lines of output -----"
    echo "$LAST_OUTPUT" | tail -n 60
    echo "------------------------------------"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "[PASS] ${label}"
    RESULTS+=("PASS  ${label}")
  else
    echo "[FAIL] ${label} (expected output to contain: \"${needle}\")"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "[FAIL] ${label} (output should NOT contain: \"${needle}\")"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  else
    echo "[PASS] ${label} (correctly absent: \"${needle}\")"
    RESULTS+=("PASS  ${label}")
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "[PASS] ${label} (expected=${expected}, actual=${actual})"
    RESULTS+=("PASS  ${label}")
  else
    echo "[FAIL] ${label} (expected=${expected}, actual=${actual})"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
}

# Liquidity/fee values from cp-amm can exceed bash's 64-bit `(( ))` arithmetic range (Q64.64
# fixed-point liquidity is routinely a ~30-digit number) — confirmed empirically: a naive
# `(( actual > threshold ))` bash arithmetic comparison misreported a genuinely, hugely positive
# real value as not-greater-than-zero. These values are always non-negative by construction, so
# "an all-digit string that isn't exactly zero" is a correct, overflow-safe stand-in for "> 0".
assert_positive_bignum() {
  local label="$1" actual="$2"
  if [[ "$actual" =~ ^[0-9]+$ ]] && [[ "$actual" != "0" ]]; then
    echo "[PASS] ${label} (actual=${actual} > 0)"
    RESULTS+=("PASS  ${label}")
  else
    echo "[FAIL] ${label} (actual=${actual}, expected a positive integer)"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
}

# ---------------------------------------------------------------------------
# 1. Start the localnet validator and wait for it to answer getHealth.
# ---------------------------------------------------------------------------
VALIDATOR_LOG="$(mktemp -t e2e-review-fixes-zap-validator.XXXXXX)"
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
# 2. Throwaway wallet with generous headroom: two DAMM v2 pools (one needs 20 SOL of quote
#    liquidity so a 0.1 SOL test deposit stays a small fraction of it — a THIN pool trips the
#    zap's own maxSqrtPriceChangeBps slippage guard for unrelated test-setup reasons, which
#    isn't what this script is testing) plus fees/rent. NOT pre-wrapping any SOL to wSOL here:
#    empirically, damm-v2-create-balanced-pool wraps its own tokenBAmount internally when the
#    quote mint is native SOL, and zapInDammV2's assertHoldsAtLeast special-cases native SOL to
#    check the wallet's NATIVE balance directly (zap's own "setup" step wraps on the fly) — pre-
#    wrapping only shrinks the native balance those steps need and causes an unrelated
#    "insufficient lamports" failure.
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
run_step "extra direct airdrop (40 SOL headroom for two pools + zap-in + fees)" \
  bash -c "cd '$STUDIO_DIR' && node -e \"\$0\" '$RPC_URL' '$WALLET_PUBKEY' '40'" "$EXTRA_AIRDROP_JS"

# ---------------------------------------------------------------------------
# 3. TWO throwaway base SPL mints — one per pool. A DAMM v2 pool address is a PDA derived
#    purely from (tokenAMint, tokenBMint) (deriveCustomizablePoolAddress), so reusing the same
#    base mint against the same wSOL quote mint for a second pool would collide with the first
#    ("Allocate: account ... already in use") — confirmed empirically.
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
echo "==> Test base mint: ${MINT} (${MINT_SUPPLY_HUMAN} units minted to the wallet)"
RESULTS+=("PASS  create test SPL mint")

MINT2_INFO="$(cd "$STUDIO_DIR" && node -e "$MINT_SETUP_JS" "$KEYPAIR_FILE" "$RPC_URL" "$MINT_DECIMALS" "$MINT_SUPPLY_HUMAN")"
MINT2="$(echo "$MINT2_INFO" | grep '^MINT=' | tail -1 | cut -d= -f2)"
if [[ -z "$MINT2" ]]; then
  echo "ERROR: failed to create the second throwaway test mint."
  echo "$MINT2_INFO"
  RESULTS+=("FAIL  create second test SPL mint")
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "==> Test base mint 2: ${MINT2} (${MINT_SUPPLY_HUMAN} units minted to the wallet)"
RESULTS+=("PASS  create second test SPL mint")

# ---------------------------------------------------------------------------
# 4. Common damm_v2_config.jsonc patches (both pools need these regardless of fee mode).
# ---------------------------------------------------------------------------
patch_literal "$DAMM_V2_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$DAMM_V2_CONFIG" '"dryRun": true' '"dryRun": false'
patch_literal "$DAMM_V2_CONFIG" '"creator": "YOUR_CREATOR_ADDRESS"' "\"creator\": \"${WALLET_PUBKEY}\""
patch_literal "$DAMM_V2_CONFIG" '"newPositionOwner": "YOUR_NEW_POSITION_OWNER_ADDRESS"' "\"newPositionOwner\": \"${WALLET_PUBKEY}\""

# ---------------------------------------------------------------------------
# 5. POOL_RATELIMITER: left at the template's DEFAULT baseFeeMode (2, Rate Limiter) — only
#    quoteAmount needs to go from null to a real number for a balanced pool. This pool is used
#    ONLY to prove the PRE-FLIGHT GUARD (PART A below) refuses a rate-limiter pool before
#    anything is built or sent (see the header comment's "PRE-FLIGHT GUARD" note).
# ---------------------------------------------------------------------------
patch_literal "$DAMM_V2_CONFIG" '"quoteAmount": null,' '"quoteAmount": 1,'

POOL_RATELIMITER=""
if run_step "damm-v2-create-balanced-pool --baseMint <MINT> (rate-limiter fee mode, for the pre-flight guard)" \
  pnpm studio damm-v2-create-balanced-pool --baseMint "$MINT"; then
  POOL_RATELIMITER="$(echo "$LAST_OUTPUT" | grep '> Pool address:' | tail -1 | sed -E 's/.*Pool address: *//' | tr -d '[:space:]')"
fi
if [[ -z "$POOL_RATELIMITER" ]]; then
  echo "ERROR: no rate-limiter DAMM v2 pool — cannot continue the pre-flight guard proof without one."
  RESULTS+=("FAIL  damm-v2-create-balanced-pool (rate-limiter pool, no address captured)")
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "==> DAMM v2 pool (rate-limiter fee mode): ${POOL_RATELIMITER}"

# ---------------------------------------------------------------------------
# 6. PRE-FLIGHT GUARD PROOF (PART A) — `assertPoolIsZapInCompatible` must refuse this
#    rate-limiter pool with its actionable message, and must do so BEFORE any transaction is
#    sent. zap_config.jsonc's shipped defaults already are dryRun: true, positionMode: "new";
#    only rpcUrl needs patching, then dryRun flips to false so this is a genuine attempt at a
#    REAL send — proving the guard blocks it pre-flight rather than merely being skipped
#    because dry-run never sends anything anyway.
# ---------------------------------------------------------------------------
patch_literal "$ZAP_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$ZAP_CONFIG" '"dryRun": true' '"dryRun": false'

run_step_expect_fail "zap-in-damm-v2 (pre-flight guard: rate-limiter pool refused before any send)" \
  'Stopping now, before any transaction is sent.' \
  pnpm studio zap-in-damm-v2 --poolAddress "$POOL_RATELIMITER"
GUARD_OUTPUT="$LAST_OUTPUT"

assert_contains "guard: names the incompatible fee mode" \
  'uses the Rate Limiter base-fee mode' "$GUARD_OUTPUT"
assert_contains "guard: names the on-chain error it would otherwise hit" \
  'error 6049 (FailToValidateSingleSwapInstruction)' "$GUARD_OUTPUT"
assert_contains "guard: tells the user the actionable alternative for an existing pool" \
  'add liquidity directly with damm-v2-add-liquidity instead of zapping' "$GUARD_OUTPUT"
assert_not_contains "guard: never prints a secret/private key material" \
  'PRIVATE_KEY' "$GUARD_OUTPUT"

run_step "damm-v2-get-positions (confirms the guard sent nothing: still exactly the pool-creation position)" \
  pnpm studio damm-v2-get-positions --poolAddress "$POOL_RATELIMITER"
RATELIMITER_POSITION_COUNT="$(echo "$LAST_OUTPUT" | grep -c '^> Position ')"
assert_eq "guard: no transaction was sent by the blocked attempt (position count still 1)" "1" "$RATELIMITER_POSITION_COUNT"

# ---------------------------------------------------------------------------
# 7. POOL_LINEAR: switch to baseFeeMode 0 (Linear Fee Scheduler) with real, comfortably-sized
#    liquidity so F4's fix can be proven with an ACTUAL successful end-to-end live deposit, not
#    just a clean simulation — isolating F4 from the separate rate-limiter finding above.
# ---------------------------------------------------------------------------
BASEFEE_RATELIMITER='"baseFeeMode": 2, // 0 - Fee Scheduler: Linear | 1 - Fee Scheduler: Exponential | 2 - Rate Limiter | 3 - Fee Market Cap Scheduler: Linear | 4 - Fee Market Cap Scheduler: Exponential
        // "feeTimeSchedulerParam": {
        //   "startingFeeBps": 120, // starting base fee (in basis points) (if you want a flat fee, set startingFeeBps and endingFeeBps to the same value)
        //   "endingFeeBps": 120, // ending base fee (in basis points) (if you want a flat fee, set startingFeeBps and endingFeeBps to the same value)
        //   "numberOfPeriod": 0, // number of periods
        //   "totalDuration": 0 // total duration (If activationType is 0 (slots), totalDuration = duration / 0.4 | If activationType is 1 (timestamp), totalDuration = duration)
        // }
        "rateLimiterParam": {
          "baseFeeBps": 120, // base fee (max 50% base fee === 5000 bps)
          "feeIncrementBps": 100, // fee increment (max fee increment = 5000 bps - baseFeeBps)
          "referenceAmount": 1, // reference amount (not in lamports)
          "maxLimiterDuration": 3600, // if activationType is 0 (slots), maxLimiterDuration = duration / 0.4, if activationType is 1 (timestamp), maxLimiterDuration = duration)
          "maxFeeBps": 5000 // max 50% base fee can go to === 5000 bps
        }'
BASEFEE_LINEAR='"baseFeeMode": 0, // switched from 2 (Rate Limiter) for this test pool -- see e2e-review-fixes-zap.sh header
        "feeTimeSchedulerParam": {
          "startingFeeBps": 120,
          "endingFeeBps": 120,
          "numberOfPeriod": 0,
          "totalDuration": 0
        }'
node -e "$PATCH_LITERAL_JS" "$DAMM_V2_CONFIG" "$BASEFEE_RATELIMITER" "$BASEFEE_LINEAR"
patch_literal "$DAMM_V2_CONFIG" '"quoteAmount": 1,' '"quoteAmount": 20,'
patch_literal "$DAMM_V2_CONFIG" '"baseAmount": 100000000,' '"baseAmount": 200000,'

POOL_LINEAR=""
if run_step "damm-v2-create-balanced-pool --baseMint <MINT2> (linear fee mode, for F4)" \
  pnpm studio damm-v2-create-balanced-pool --baseMint "$MINT2"; then
  POOL_LINEAR="$(echo "$LAST_OUTPUT" | grep '> Pool address:' | tail -1 | sed -E 's/.*Pool address: *//' | tr -d '[:space:]')"
fi
if [[ -z "$POOL_LINEAR" ]]; then
  echo "ERROR: no linear-fee DAMM v2 pool — cannot continue the F4 proof without one."
  RESULTS+=("FAIL  damm-v2-create-balanced-pool (linear-fee pool, no address captured)")
  FAILURES=$((FAILURES + 1))
  exit 1
fi
echo "==> DAMM v2 pool (linear fee mode): ${POOL_LINEAR}"

run_step "damm-v2-get-positions (baseline: exactly the pool-creation position, 1 total)" \
  pnpm studio damm-v2-get-positions --poolAddress "$POOL_LINEAR"
BASELINE_POSITION_COUNT="$(echo "$LAST_OUTPUT" | grep -c '^> Position ')"
assert_eq "baseline position count on POOL_LINEAR is exactly 1 (pool creation's own)" "1" "$BASELINE_POSITION_COUNT"

# ---------------------------------------------------------------------------
# 8. F4 PROOF, part A — positionMode "existing" dry-run, run FIRST (while POOL_LINEAR still
#    has exactly one wallet-owned position, so "existing" mode resolves it without an
#    interactive prompt). Proves the no-preamble branch of the same combine+defer fix.
# ---------------------------------------------------------------------------
patch_literal "$ZAP_CONFIG" '"dryRun": false' '"dryRun": true'
patch_literal "$ZAP_CONFIG" '"positionMode": "new"' '"positionMode": "existing"'

run_step "zap-in-damm-v2 (F4: positionMode=existing, dry-run) --poolAddress <POOL_LINEAR>" \
  pnpm studio zap-in-damm-v2 --poolAddress "$POOL_LINEAR"
EXISTING_DRYRUN_OUTPUT="$LAST_OUTPUT"
assert_contains "F4 existing-mode: step 1 is the combined setup+ledger transaction (no create-position)" \
  '1. setup + ledger (combined into one transaction)' "$EXISTING_DRYRUN_OUTPUT"
assert_contains "F4 existing-mode: \"zap in\" and \"clean up\" are honestly deferred, not falsely failed" \
  '2 step(s) deferred (not a failure' "$EXISTING_DRYRUN_OUTPUT"
assert_not_contains "F4 existing-mode: the ORIGINAL bug's error does not resurface" \
  'AccountOwnedByWrongProgram' "$EXISTING_DRYRUN_OUTPUT"

# ---------------------------------------------------------------------------
# 9. F4 PROOF, part B — positionMode "new" dry-run (the shipped DEFAULT — this is the exact
#    scenario the review brief asked to prove empirically) THEN a real live send, showing the
#    dry-run correctly defers the dependent steps and the live send actually lands a deposit.
# ---------------------------------------------------------------------------
patch_literal "$ZAP_CONFIG" '"positionMode": "existing"' '"positionMode": "new"'

run_step "zap-in-damm-v2 (F4: positionMode=new [shipped default], dry-run) --poolAddress <POOL_LINEAR>" \
  pnpm studio zap-in-damm-v2 --poolAddress "$POOL_LINEAR"
NEW_DRYRUN_OUTPUT="$LAST_OUTPUT"
assert_contains "F4 new-mode dry-run: step 1 combines create-position + setup + ledger" \
  '1. create position + setup + ledger (combined into one transaction)' "$NEW_DRYRUN_OUTPUT"
assert_contains "F4 new-mode dry-run: step 1 actually simulates successfully" \
  '"create position + setup + ledger (combined into one transaction)" simulation successful' "$NEW_DRYRUN_OUTPUT"
assert_contains "F4 new-mode dry-run: \"zap in\" + \"clean up\" honestly deferred (2 of them)" \
  '2 step(s) deferred (not a failure' "$NEW_DRYRUN_OUTPUT"
assert_not_contains "F4 new-mode dry-run: the ORIGINAL bug (ledger AccountOwnedByWrongProgram) is gone" \
  'AccountOwnedByWrongProgram' "$NEW_DRYRUN_OUTPUT"

patch_literal "$ZAP_CONFIG" '"dryRun": true' '"dryRun": false'
run_step "zap-in-damm-v2 (F4: positionMode=new, REAL live send) --poolAddress <POOL_LINEAR>" \
  pnpm studio zap-in-damm-v2 --poolAddress "$POOL_LINEAR"
LIVE_OUTPUT="$LAST_OUTPUT"
assert_contains "F4 live send: all 3 steps (combined create+setup+ledger, zap in, clean up) confirmed" \
  'All 3 step(s) sent and confirmed successfully.' "$LIVE_OUTPUT"

run_step "damm-v2-get-positions (after: pool-creation position + the new zap-deposited position)" \
  pnpm studio damm-v2-get-positions --poolAddress "$POOL_LINEAR"
AFTER_POSITION_COUNT="$(echo "$LAST_OUTPUT" | grep -c '^> Position ')"
assert_eq "position count on POOL_LINEAR is now 2 (a real new position was created)" "2" "$AFTER_POSITION_COUNT"
NEW_POSITION_LIQUIDITY="$(echo "$LAST_OUTPUT" | awk '/^> Position /{p=$0} /Unlocked liquidity:/{u=$NF} END{print u}')"
# The above prints the LAST position's unlocked liquidity in the listing, which is the newly
# created one (damm-v2-get-positions lists in cpAmm.getUserPositionByPool's return order; the
# freshly created position is appended after the pool-creation position).
if [[ "$NEW_POSITION_LIQUIDITY" =~ ^[0-9]+$ ]]; then
  assert_positive_bignum "F4 live send: the new position holds a REAL non-zero deposit (unlocked liquidity)" "$NEW_POSITION_LIQUIDITY"
else
  echo "[FAIL] could not parse the new position's unlocked liquidity from damm-v2-get-positions output"
  RESULTS+=("FAIL  F4 live send: new position unlocked liquidity (unparsed)")
  FAILURES=$((FAILURES + 1))
fi

# ---------------------------------------------------------------------------
# 10. F3 PROOF (PART B) — force a REAL mid-bundle abort on a ZAP-IN-COMPATIBLE pool
#     (POOL_LINEAR, still positionMode "new" + dryRun false from step 9) and check the new
#     abort wording. `maxSqrtPriceChangeBps: 0` leaves zero headroom for the internal
#     rebalancing swap's own price impact — verified against the zap program's own source
#     (see the header comment's "PRE-FLIGHT GUARD" note): the on-chain check rounds the
#     observed sqrt-price change UP before comparing it to this ceiling, so ANY real swap
#     exceeds a ceiling of 0. A fresh, empty position ("new" mode) funded 100% single-sided
#     (zap_config.jsonc's default inputMint is native SOL, one of POOL_LINEAR's two mints)
#     cannot be balanced without a real swap, so this fails deterministically every run. Step 1
#     ("create position + setup + ledger", no swap involved) still lands for real; step 2
#     ("zap in") is where the on-chain program rejects it — a genuine mid-bundle abort, unlike
#     the pre-flight guard in PART A above (which never lets step 1 happen at all).
# ---------------------------------------------------------------------------
patch_literal "$ZAP_CONFIG" '"maxSqrtPriceChangeBps": 100,' '"maxSqrtPriceChangeBps": 0,'

run_step_expect_fail "zap-in-damm-v2 (F3 part B: real send against a zap-in-compatible pool, maxSqrtPriceChangeBps=0 forces abort at \"zap in\")" \
  'Aborted at step 2/3 ("zap in")' \
  pnpm studio zap-in-damm-v2 --poolAddress "$POOL_LINEAR"
F3_OUTPUT="$LAST_OUTPUT"

assert_contains "F3: names the failed step and that step 3 (clean up) was NOT sent" \
  'Step(s) 3-3 were NOT sent: clean up.' "$F3_OUTPUT"
assert_contains "F3: states earlier step(s) already landed on-chain" \
  'already landed on-chain — do not assume a clean slate' "$F3_OUTPUT"
assert_contains "F3: prints a recovery reference address (public position address)" \
  'Recovery reference address:' "$F3_OUTPUT"
assert_contains "F3: explicitly says re-running does NOT resume" \
  'does NOT resume this' "$F3_OUTPUT"
assert_contains "F3: warns re-running WILL repeat the action (second real deposit)" \
  'WILL repeat any action that already landed, such as a second real deposit' "$F3_OUTPUT"
assert_contains "F3: tells the user to inspect state with a read-only action first" \
  'damm-v2-get-positions / dlmm-get-positions' "$F3_OUTPUT"
assert_contains "F3: tells the user how to continue safely (positionMode existing)" \
  'set positionMode to "existing"' "$F3_OUTPUT"
assert_not_contains "F3: the OLD false blanket resume claim is gone" \
  'Re-run the same command to resume: it rebuilds a fresh ordered bundle' "$F3_OUTPUT"
assert_not_contains "F3: never prints a secret/private key material" \
  'PRIVATE_KEY' "$F3_OUTPUT"

patch_literal "$ZAP_CONFIG" '"maxSqrtPriceChangeBps": 0,' '"maxSqrtPriceChangeBps": 100,'

echo ""
echo "==> Done. Created on localnet this run: baseMint1=${MINT} poolRateLimiter=${POOL_RATELIMITER} baseMint2=${MINT2} poolLinear=${POOL_LINEAR}"
exit 0
