#!/usr/bin/env bash
#
# e2e-review-fixes-fee-sharing.sh — localnet proof for the PR-review fixes owned by the
# "fee sharing" family (F1 blocker + M4 minor from the 4-reviewer consolidated fix pass):
#
#   F1: fee-sharing-fund-from-damm-v2 was unreachable — it queried DAMM v2 positions owned by
#       the WALLET, then filtered for a position-NFT account owned by the VAULT. An SPL token
#       account has exactly one owner, so those two conditions could never both hold. Fixed by
#       querying cpAmm.getUserPositionByPool(pool, VAULT) directly, and by adding the missing
#       setup action (fee-sharing-transfer-damm-v2-position) a user needs to actually get a
#       position into vault ownership in the first place.
#   M4:  fee-sharing-fund-from-damm-v2-reward — a new action wrapping fundByClaimDammV2Reward,
#        sharing F1's fixed vault-owned-position discovery, with its own two pre-flight guards
#        (rewardIndex bounds + reward-slot-initialized) smoke-tested below.
#
# This script builds real chain state the existing e2e-helper-smoke.sh golden paths don't touch:
# a throwaway SPL mint -> a one-sided DAMM v2 pool (no quote liquidity needed to create it) -> a
# real swap against that pool (wSOL -> base) to accrue a genuine, non-zero trading fee on the
# wallet's position -> a wSOL-denominated fee vault -> the position transferred into that vault
# -> fee-sharing-fund-from-damm-v2 sweeping the real fee in, proven via a fee-sharing-get-status
# delta.
#
# Empirical F1 proof strategy (see step "position-ownership query, BEFORE transfer" /
# "... AFTER transfer" below): rather than resurrecting the literal old buggy function, this
# calls cpAmm.getUserPositionByPool(pool, X) directly for X = wallet and X = vault, before and
# after the transfer — the exact same call both the old and new code used, just pointed at a
# different owner. Before transfer: wallet-query is non-empty, vault-query is empty (this is
# EXACTLY the situation the old code needed to succeed and never could: it queried the wallet
# — non-empty — then required the SAME returned entries to be vault-owned, i.e. needed the
# vault-query set and the wallet-query set to overlap, which by definition of "one owner per
# token account" they never can). After transfer: the sets flip (wallet-query empties out,
# vault-query populates) — proving the NEW code's query target is the one that actually tracks
# real ownership across the transfer, which is what fee-sharing-fund-from-damm-v2 now uses.
#
# SAFETY (mirrors e2e-helper-smoke.sh — read before editing):
#   - Never edits studio/.env, studio/keypair.json, studio/config/damm_v2_config.jsonc or
#     studio/config/fee_sharing_config.jsonc "in place" without a net: each is backed up to
#     "<file>.e2e-backup" before being touched (only if the real file already exists) and
#     restored by a trap that fires on normal exit, error, or Ctrl-C. Refuses to run if a stale
#     *.e2e-backup is already present (a previous run crashed before restoring).
#   - A brand-new throwaway keypair is generated for the run; its base58 private key is written
#     straight to the temporary studio/.env and is never printed or logged.
#   - Idempotent: the validator runs with --reset (fresh ledger every time) and every on-chain
#     object (wallet, mint, pool, vault) is freshly generated each run.
#
# Usage: studio/src/tests/e2e-review-fixes-fee-sharing.sh   (works from any cwd; paths below are
# resolved relative to this script's own location, not the caller's cwd).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STUDIO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${STUDIO_DIR}/.." && pwd)"

ENV_FILE="${STUDIO_DIR}/.env"
KEYPAIR_FILE="${STUDIO_DIR}/keypair.json"
DAMM_V2_CONFIG="${STUDIO_DIR}/config/damm_v2_config.jsonc"
FEE_SHARING_CONFIG="${STUDIO_DIR}/config/fee_sharing_config.jsonc"

ENV_BACKUP="${ENV_FILE}.e2e-backup"
KEYPAIR_BACKUP="${KEYPAIR_FILE}.e2e-backup"
DAMM_V2_CONFIG_BACKUP="${DAMM_V2_CONFIG}.e2e-backup"
FEE_SHARING_CONFIG_BACKUP="${FEE_SHARING_CONFIG}.e2e-backup"

RPC_URL="http://127.0.0.1:8899"
MINT_DECIMALS=6
MINT_SUPPLY_HUMAN=150000000 # comfortably covers dammV2Config's default baseAmount (100,000,000)

WSOL_WRAP_SOL="1" # 1 SOL wrapped to wSOL — covers dammV2Swap.amountIn default (0.1) many times over

VALIDATOR_PID=""
VALIDATOR_LOG=""
FAILURES=0
RESULTS=()
LAST_OUTPUT=""

# ---------------------------------------------------------------------------
# Pre-flight: refuse to run if a previous crashed run left a backup unrestored.
# ---------------------------------------------------------------------------
for f in "$ENV_BACKUP" "$KEYPAIR_BACKUP" "$DAMM_V2_CONFIG_BACKUP" "$FEE_SHARING_CONFIG_BACKUP"; do
  if [[ -f "$f" ]]; then
    echo "ERROR: stale backup found at ${f}" >&2
    echo "A previous run of this script likely crashed before restoring your files." >&2
    echo "Resolve this by hand (inspect + restore or remove the backup) before re-running." >&2
    exit 1
  fi
done

echo "==> e2e-review-fixes-fee-sharing: repo root ${REPO_ROOT}"
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
  echo "===== e2e-review-fixes-fee-sharing summary ====="
  local r
  for r in "${RESULTS[@]:-}"; do
    [[ -n "$r" ]] && echo "$r"
  done
  echo "================================================="

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
cp -p "$FEE_SHARING_CONFIG" "$FEE_SHARING_CONFIG_BACKUP"

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
main().catch((err) => {
  console.error("mint setup failed:", err && err.message ? err.message : err);
  process.exit(1);
});
'

TWO_PUBKEYS_JS='
const { Keypair } = require("@solana/web3.js");
console.log(Keypair.generate().publicKey.toBase58());
console.log(Keypair.generate().publicKey.toBase58());
'

# Wraps native SOL into the wallet'"'"'s own wSOL ATA (create-if-missing + transfer + syncNative)
# so damm-v2-swap has something to pay with — needed because, unlike fee-sharing-fund, damm-v2
# swap does not auto-wrap SOL for you.
WRAP_SOL_JS='
const { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction } = require("@solana/web3.js");
const { NATIVE_MINT, getOrCreateAssociatedTokenAccount, createSyncNativeInstruction } = require("@solana/spl-token");
const fs = require("fs");

async function main() {
  const [keypairPath, rpcUrl, solAmountStr] = process.argv.slice(1);
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const connection = new Connection(rpcUrl, "confirmed");

  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, NATIVE_MINT, payer.publicKey);
  const lamports = Math.floor(parseFloat(solAmountStr) * 1e9);
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata.address, lamports }),
    createSyncNativeInstruction(ata.address)
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  console.log("WSOL_WRAPPED_LAMPORTS=" + lamports);
  console.log("WSOL_WRAP_SIG=" + sig);
}
main().catch((err) => {
  console.error("wrap SOL failed:", err && err.message ? err.message : err);
  process.exit(1);
});
'

# The empirical F1 proof primitive: calls the EXACT SDK query both the old and new code used
# (cpAmm.getUserPositionByPool), pointed at whatever owner pubkey is passed in. Prints a COUNT
# line the caller great-parses, plus one POSITION line per match.
QUERY_POSITIONS_JS='
const { Connection, PublicKey } = require("@solana/web3.js");
const { CpAmm } = require("@meteora-ag/cp-amm-sdk");

async function main() {
  const [rpcUrl, poolStr, ownerStr, label] = process.argv.slice(1);
  const connection = new Connection(rpcUrl, "confirmed");
  const cpAmm = new CpAmm(connection);
  const positions = await cpAmm.getUserPositionByPool(new PublicKey(poolStr), new PublicKey(ownerStr));
  console.log(label + "_COUNT=" + positions.length);
  for (const p of positions) {
    console.log(label + "_POSITION=" + p.position.toString());
  }
}
main().catch((err) => {
  console.error("position query failed:", err && err.message ? err.message : err);
  process.exit(1);
});
'
query_position_count() {
  # args: poolAddress ownerAddress label
  local out
  out="$(cd "$STUDIO_DIR" && node -e "$QUERY_POSITIONS_JS" "$RPC_URL" "$1" "$2" "$3")" || {
    echo "ERROR: position query failed for $3" >&2
    echo "$out" >&2
    echo "-1"
    return 1
  }
  echo "$out" | grep "^${3}_COUNT=" | tail -1 | cut -d= -f2
}

# ---------------------------------------------------------------------------
# Step runners — same contract as e2e-helper-smoke.sh's run_step/skip_step,
# plus two assertion-flavored variants this script also needs.
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

# Runs a command expected to FAIL (nonzero exit) with a specific substring in its output — used
# to prove a pre-flight guard fires with the right, actionable message instead of either
# succeeding wrongly or crashing with an unrelated/opaque error.
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
    echo "----- last 40 lines of output -----"
    echo "$LAST_OUTPUT" | tail -n 40
    echo "------------------------------------"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
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

assert_gt() {
  local label="$1" threshold="$2" actual="$3"
  if [[ "$actual" =~ ^-?[0-9]+$ ]] && (( actual > threshold )); then
    echo "[PASS] ${label} (actual=${actual} > ${threshold})"
    RESULTS+=("PASS  ${label}")
  else
    echo "[FAIL] ${label} (actual=${actual}, expected > ${threshold})"
    RESULTS+=("FAIL  ${label}")
    FAILURES=$((FAILURES + 1))
  fi
}

# ---------------------------------------------------------------------------
# 1. Start the localnet validator and wait for it to answer getHealth.
# ---------------------------------------------------------------------------
VALIDATOR_LOG="$(mktemp -t e2e-review-fixes-fee-sharing-validator.XXXXXX)"
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
# 2. Throwaway wallet, airdropped twice (10 SOL total: enough for pool creation,
#    wrapping 1 SOL to wSOL, and every fee-sharing/damm-v2 tx below).
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
run_step "airdrop-sol --network localnet (extra headroom for wSOL wrap)" \
  pnpm studio airdrop-sol --network localnet

# ---------------------------------------------------------------------------
# 3. Throwaway base SPL mint for the DAMM v2 pool.
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

WSOL_MINT="So11111111111111111111111111111111111111112"

# ---------------------------------------------------------------------------
# 4. One-sided DAMM v2 pool: base = our throwaway mint, quote = wSOL. One-sided
#    needs no quote-side liquidity to CREATE (quoteAmount stays null in the
#    template), so no SOL needs wrapping yet for this step.
# ---------------------------------------------------------------------------
patch_literal "$DAMM_V2_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$DAMM_V2_CONFIG" '"dryRun": true' '"dryRun": false'
patch_literal "$DAMM_V2_CONFIG" '"creator": "YOUR_CREATOR_ADDRESS"' "\"creator\": \"${WALLET_PUBKEY}\""
# Config-wide validation (validateDammV2ConfigFields) checks every address field in the file,
# not just the ones this action reads — splitPosition.newPositionOwner must be a real address
# too even though this run never touches split-position. Unused here beyond passing validation.
patch_literal "$DAMM_V2_CONFIG" '"newPositionOwner": "YOUR_NEW_POSITION_OWNER_ADDRESS"' "\"newPositionOwner\": \"${WALLET_PUBKEY}\""

POOL=""
if run_step "damm-v2-create-one-sided-pool --baseMint <MINT>" \
  pnpm studio damm-v2-create-one-sided-pool --baseMint "$MINT"; then
  POOL="$(echo "$LAST_OUTPUT" | grep '> Pool address:' | tail -1 | sed -E 's/.*Pool address: *//' | tr -d '[:space:]')"
  if [[ -n "$POOL" ]]; then
    echo "==> DAMM v2 pool: ${POOL}"
  else
    echo "WARNING: could not parse the pool address out of damm-v2-create-one-sided-pool's output."
  fi
fi

if [[ -z "$POOL" ]]; then
  echo "ERROR: no DAMM v2 pool — cannot continue the F1/M4 proof without one."
  RESULTS+=("FAIL  damm-v2-create-one-sided-pool (no pool address captured)")
  FAILURES=$((FAILURES + 1))
  exit 1
fi

run_step "damm-v2-get-positions (pre-swap: position exists, zero fees expected)" \
  pnpm studio damm-v2-get-positions --poolAddress "$POOL"

# ---------------------------------------------------------------------------
# 5. Wrap 1 SOL to wSOL, then swap a small amount of it into the pool — this is
#    what actually accrues a non-zero, REAL trading fee on the position
#    (collectFeeMode: 1 in the template = fees always land in token B = wSOL).
# ---------------------------------------------------------------------------
run_step "wrap ${WSOL_WRAP_SOL} SOL to wSOL" \
  bash -c "cd '$STUDIO_DIR' && node -e \"\$0\" '$KEYPAIR_FILE' '$RPC_URL' '$WSOL_WRAP_SOL'" "$WRAP_SOL_JS"

run_step "damm-v2-swap --poolAddress <POOL> (wSOL -> base, accrues a real fee)" \
  pnpm studio damm-v2-swap --poolAddress "$POOL"

run_step "damm-v2-get-positions (post-swap: non-zero tokenB fee expected)" \
  pnpm studio damm-v2-get-positions --poolAddress "$POOL"

# ---------------------------------------------------------------------------
# 6. wSOL-denominated fee vault (must match the pool's fee-accruing side —
#    collectFeeMode: 1 means fees are always token B / wSOL here, so the vault
#    has to be created with --baseMint = wSOL for fundByClaimDammV2Fee to sweep
#    anything into ITS OWN token vault instead of the wallet's regular ATA).
# ---------------------------------------------------------------------------
# Recipient 1 is the WALLET ITSELF, not a random pubkey — verified directly against the DFS
# on-chain program's source (programs/dynamic-fee-sharing/.../ix_fund_by_claiming_fee.rs):
# fund_by_claiming_fee requires `fee_vault.is_share_holder(signer)`, i.e. the transaction signer
# must be a REGISTERED userShare RECIPIENT of the vault — being the vault's owner/creator is a
# separate, unchecked concept here and is NOT sufficient on its own. assertVaultSupportsClaiming-
# FeeBridge (added alongside F1) checks this client-side now with an actionable error; this test
# satisfies it for real instead of just exercising the guard.
RECIPIENT_2="$(cd "$STUDIO_DIR" && node -e "$TWO_PUBKEYS_JS" | sed -n '1p')"

patch_literal "$FEE_SHARING_CONFIG" '"rpcUrl": "https://api.devnet.solana.com"' '"rpcUrl": "http://localhost:8899"'
patch_literal "$FEE_SHARING_CONFIG" '"address": "YOUR_RECIPIENT_ADDRESS_1"' "\"address\": \"${WALLET_PUBKEY}\""
patch_literal "$FEE_SHARING_CONFIG" '"address": "YOUR_RECIPIENT_ADDRESS_2"' "\"address\": \"${RECIPIENT_2}\""
patch_literal "$FEE_SHARING_CONFIG" '"dryRun": true' '"dryRun": false'
# Also verified directly against the same on-chain program source: fund_by_claiming_fee also
# requires `fee_vault.fee_vault_type == 1` (PDA-variant only) — a keypair-variant vault
# (useKeypairVault: true, the template default) is rejected outright regardless of signer.
patch_literal "$FEE_SHARING_CONFIG" '"useKeypairVault": true' '"useKeypairVault": false'

VAULT=""
if run_step "fee-sharing-create-vault --baseMint <wSOL>" \
  pnpm studio fee-sharing-create-vault --baseMint "$WSOL_MINT"; then
  VAULT="$(echo "$LAST_OUTPUT" | grep 'FEE VAULT ADDRESS:' | tail -1 | sed -E 's/.*FEE VAULT ADDRESS: *//' | tr -d '[:space:]')"
  if [[ -n "$VAULT" ]]; then
    echo "==> Fee vault (wSOL-denominated): ${VAULT}"
  else
    echo "WARNING: could not parse the fee vault address out of fee-sharing-create-vault's output."
  fi
fi

if [[ -z "$VAULT" ]]; then
  echo "ERROR: no fee vault — cannot continue the F1 proof without one."
  RESULTS+=("FAIL  fee-sharing-create-vault (no vault address captured)")
  FAILURES=$((FAILURES + 1))
  exit 1
fi

BEFORE_FUNDED="-1"
if run_step "fee-sharing-get-status --vault <VAULT> (baseline, before any funding)" \
  pnpm studio fee-sharing-get-status --vault "$VAULT"; then
  BEFORE_FUNDED="$(echo "$LAST_OUTPUT" | grep 'Total funded:' | tail -1 | sed -E 's/.*\(([0-9]+) base units\).*/\1/')"
fi
echo "==> Baseline totalFundedFee (base units): ${BEFORE_FUNDED:-<unparsed>}"

# ---------------------------------------------------------------------------
# 7. F1 EMPIRICAL PROOF, part 1 — BEFORE the position is transferred to the
#    vault: the OLD code's query target (wallet) finds the position; the NEW
#    code's query target (vault) finds nothing yet. This is exactly the
#    situation that made the OLD code's success condition (wallet-query
#    non-empty AND a result from it vault-owned) structurally impossible: the
#    set the old code searched (wallet-owned) and the set that could pass its
#    own ownership filter (vault-owned) are — by definition of one owner per
#    token account — always disjoint.
# ---------------------------------------------------------------------------
WALLET_BEFORE="$(query_position_count "$POOL" "$WALLET_PUBKEY" WALLET)"
VAULT_BEFORE="$(query_position_count "$POOL" "$VAULT" VAULT)"
echo "==> getUserPositionByPool(pool, WALLET) before transfer -> count=${WALLET_BEFORE}"
echo "==> getUserPositionByPool(pool, VAULT)   before transfer -> count=${VAULT_BEFORE}"
assert_gt "old code's query target (wallet) sees the position pre-transfer" 0 "$WALLET_BEFORE"
assert_eq "new code's query target (vault) sees nothing yet (not transferred)" "0" "$VAULT_BEFORE"

run_step_expect_fail "fee-sharing-fund-from-damm-v2 (before transfer — must refuse, naming the vault)" \
  "No DAMM v2 position owned by fee vault" \
  pnpm studio fee-sharing-fund-from-damm-v2 --vault "$VAULT" --poolAddress "$POOL"

# ---------------------------------------------------------------------------
# 8. The missing setup action (F1's second half): transfer the position NFT's
#    token-account ownership to the vault. Dry-run first (first-time state-
#    changing flow — same gate e2e-helper-smoke.sh exercises for Met Lock),
#    then for real.
# ---------------------------------------------------------------------------
patch_literal "$FEE_SHARING_CONFIG" '"dryRun": false' '"dryRun": true'
run_step "fee-sharing-transfer-damm-v2-position (dry-run)" \
  pnpm studio fee-sharing-transfer-damm-v2-position --vault "$VAULT" --poolAddress "$POOL"

patch_literal "$FEE_SHARING_CONFIG" '"dryRun": true' '"dryRun": false'
run_step "fee-sharing-transfer-damm-v2-position (real send)" \
  pnpm studio fee-sharing-transfer-damm-v2-position --vault "$VAULT" --poolAddress "$POOL"

# ---------------------------------------------------------------------------
# 9. F1 EMPIRICAL PROOF, part 2 — AFTER the transfer: the sets flip. This is
#    the direct proof that querying by VAULT (the fix) is what tracks real
#    on-chain ownership; querying by WALLET (the old code) no longer even
#    finds the position, let alone could satisfy its own vault-ownership
#    filter.
# ---------------------------------------------------------------------------
WALLET_AFTER="$(query_position_count "$POOL" "$WALLET_PUBKEY" WALLET)"
VAULT_AFTER="$(query_position_count "$POOL" "$VAULT" VAULT)"
echo "==> getUserPositionByPool(pool, WALLET) after transfer -> count=${WALLET_AFTER}"
echo "==> getUserPositionByPool(pool, VAULT)   after transfer -> count=${VAULT_AFTER}"
assert_eq "old code's query target (wallet) now sees NOTHING (ownership moved)" "0" "$WALLET_AFTER"
assert_gt "new code's query target (vault) now sees the position (the fix)" 0 "$VAULT_AFTER"

# ---------------------------------------------------------------------------
# 10. F1 headline: fee-sharing-fund-from-damm-v2 now reaches the SDK call.
#     Dry-run first, then for real, then prove the fee-sharing-get-status
#     delta.
# ---------------------------------------------------------------------------
patch_literal "$FEE_SHARING_CONFIG" '"dryRun": false' '"dryRun": true'
run_step "fee-sharing-fund-from-damm-v2 (dry-run, AFTER transfer — reaches the SDK call now)" \
  pnpm studio fee-sharing-fund-from-damm-v2 --vault "$VAULT" --poolAddress "$POOL"

patch_literal "$FEE_SHARING_CONFIG" '"dryRun": true' '"dryRun": false'
run_step "fee-sharing-fund-from-damm-v2 (real send, AFTER transfer)" \
  pnpm studio fee-sharing-fund-from-damm-v2 --vault "$VAULT" --poolAddress "$POOL"

AFTER_FUNDED="-1"
if run_step "fee-sharing-get-status --vault <VAULT> (after funding)" \
  pnpm studio fee-sharing-get-status --vault "$VAULT"; then
  AFTER_FUNDED="$(echo "$LAST_OUTPUT" | grep 'Total funded:' | tail -1 | sed -E 's/.*\(([0-9]+) base units\).*/\1/')"
fi
echo "==> totalFundedFee after fund-from-damm-v2 (base units): ${AFTER_FUNDED:-<unparsed>}"

if [[ "$BEFORE_FUNDED" =~ ^[0-9]+$ && "$AFTER_FUNDED" =~ ^[0-9]+$ ]]; then
  DELTA=$((AFTER_FUNDED - BEFORE_FUNDED))
  assert_gt "fee-sharing-get-status totalFundedFee delta from the real DAMM v2 fee sweep" 0 "$DELTA"
else
  echo "[FAIL] could not parse totalFundedFee before/after — see raw output above"
  RESULTS+=("FAIL  totalFundedFee delta (unparsed before/after)")
  FAILURES=$((FAILURES + 1))
fi

# ---------------------------------------------------------------------------
# 11. M4 smoke: fee-sharing-fund-from-damm-v2-reward's two pre-flight guards.
#     No studio action exists to initialize/fund a DAMM v2 reward slot, so a
#     real reward sweep isn't constructible here — both guards are smoke-
#     tested as expected-failure runs instead (dry-run doesn't change either
#     guard's behavior — validateRewardIndex and the initialized-check both
#     run before any transaction is built or simulated).
# ---------------------------------------------------------------------------
patch_literal "$FEE_SHARING_CONFIG" '"rewardIndex": 0' '"rewardIndex": 5'
run_step_expect_fail "fee-sharing-fund-from-damm-v2-reward (rewardIndex out of bounds)" \
  "rewardIndex must be in" \
  pnpm studio fee-sharing-fund-from-damm-v2-reward --vault "$VAULT" --poolAddress "$POOL"

patch_literal "$FEE_SHARING_CONFIG" '"rewardIndex": 5' '"rewardIndex": 0'
run_step_expect_fail "fee-sharing-fund-from-damm-v2-reward (in-bounds but uninitialized reward slot)" \
  "is not initialized on pool" \
  pnpm studio fee-sharing-fund-from-damm-v2-reward --vault "$VAULT" --poolAddress "$POOL"

# ---------------------------------------------------------------------------
# 12. Bonus guard coverage: assertVaultSupportsClaimingFeeBridge — the two
#     on-chain constraints discovered while proving F1 end-to-end (see the
#     code comment on assertVaultSupportsClaimingFeeBridge in lib/fee_sharing
#     for the exact program-source citations). Both are cheap to hit: neither
#     requires the test vault to own any position, since this check runs
#     before position discovery — a fresh throwaway vault of the "wrong"
#     shape is enough. Reuses $POOL only as a syntactically valid --poolAddress;
#     it is never reached.
# ---------------------------------------------------------------------------
BAD_RECIPIENTS="$(cd "$STUDIO_DIR" && node -e "$TWO_PUBKEYS_JS")"
BAD_RECIPIENT_1="$(echo "$BAD_RECIPIENTS" | sed -n '1p')"
BAD_RECIPIENT_2="$(echo "$BAD_RECIPIENTS" | sed -n '2p')"
patch_literal "$FEE_SHARING_CONFIG" "\"address\": \"${WALLET_PUBKEY}\"" "\"address\": \"${BAD_RECIPIENT_1}\""
patch_literal "$FEE_SHARING_CONFIG" "\"address\": \"${RECIPIENT_2}\"" "\"address\": \"${BAD_RECIPIENT_2}\""

# 12a. Keypair-variant vault (useKeypairVault: true) — must be rejected regardless of signer.
patch_literal "$FEE_SHARING_CONFIG" '"useKeypairVault": false' '"useKeypairVault": true'
KEYPAIR_VAULT=""
if run_step "fee-sharing-create-vault --baseMint <wSOL> (keypair-variant, for the guard test)" \
  pnpm studio fee-sharing-create-vault --baseMint "$WSOL_MINT"; then
  KEYPAIR_VAULT="$(echo "$LAST_OUTPUT" | grep 'FEE VAULT ADDRESS:' | tail -1 | sed -E 's/.*FEE VAULT ADDRESS: *//' | tr -d '[:space:]')"
fi
if [[ -n "$KEYPAIR_VAULT" ]]; then
  run_step_expect_fail "fee-sharing-fund-from-damm-v2 (keypair-variant vault must be rejected)" \
    "KEYPAIR-variant vault" \
    pnpm studio fee-sharing-fund-from-damm-v2 --vault "$KEYPAIR_VAULT" --poolAddress "$POOL"
else
  skip_step "fee-sharing-fund-from-damm-v2 (keypair-variant vault must be rejected)" \
    "no keypair-variant vault address captured"
fi

# 12b. PDA-variant vault, but this wallet is NOT one of its recipients — must be rejected too.
patch_literal "$FEE_SHARING_CONFIG" '"useKeypairVault": true' '"useKeypairVault": false'
NON_SHAREHOLDER_VAULT=""
if run_step "fee-sharing-create-vault --baseMint <wSOL> (PDA-variant, wallet NOT a recipient)" \
  pnpm studio fee-sharing-create-vault --baseMint "$WSOL_MINT"; then
  NON_SHAREHOLDER_VAULT="$(echo "$LAST_OUTPUT" | grep 'FEE VAULT ADDRESS:' | tail -1 | sed -E 's/.*FEE VAULT ADDRESS: *//' | tr -d '[:space:]')"
fi
if [[ -n "$NON_SHAREHOLDER_VAULT" ]]; then
  run_step_expect_fail "fee-sharing-fund-from-damm-v2 (non-shareholder wallet must be rejected)" \
    "not a registered shareholder" \
    pnpm studio fee-sharing-fund-from-damm-v2 --vault "$NON_SHAREHOLDER_VAULT" --poolAddress "$POOL"
else
  skip_step "fee-sharing-fund-from-damm-v2 (non-shareholder wallet must be rejected)" \
    "no non-shareholder vault address captured"
fi

echo ""
echo "==> Done. Created on localnet this run: baseMint=${MINT} pool=${POOL} feeVault=${VAULT}"
exit 0
