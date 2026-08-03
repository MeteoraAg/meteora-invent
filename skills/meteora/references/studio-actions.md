# Studio CLI — Full Action Reference (ACT path)

All 71 studio actions, verified against `studio/src/actions/` and `studio/src/helpers/cli.ts`.
Bootstrap: `studio-setup.md` (sibling file). Run everything from the meteora-invent repo root.

## How the CLI works (read this first)

1. **Each protocol has ONE fixed config file** — `studio/config/<protocol>_config.jsonc`.
   Actions always load that file; **there is no flag to pass a different config file**.
   To configure an action you EDIT the fixed file (commented templates identical to the
   real ones: `configs/` next to this file).
2. **Flags are selectors only.** The full set the parser accepts (anything else errors):
   `--network <mainnet-beta|devnet|localnet>`, `--baseMint <pubkey>`, `--poolAddress <pubkey>`,
   `--vault <pubkey>`, `--escrow <pubkey>`, `--farm <pubkey>`, `--limitOrder <pubkey>`,
   `--airdrop` (boolean), `--config <pubkey>` (ONE action only, see `dbc-create-pool`),
   `--help`.
3. Every config file shares the same base fields: `rpcUrl`, `dryRun`, `keypairFilePath`
   (resolved from `studio/`), `computeUnitPriceMicroLamports`, `quoteMint`. `dryRun`
   applies to every action reading that file — **flip it to `false` only for the action
   the owner just confirmed, and set it back to `true` immediately after** (a stale
   `false` is a live-execution hazard for the next action).
4. Amounts in config files are **human token units** unless the field's comment says
   otherwise (notable exceptions called out below).

## Settings actions

### `generate-keypair`
```bash
pnpm studio generate-keypair                              # convert PRIVATE_KEY -> studio/keypair.json
pnpm studio generate-keypair --network devnet --airdrop   # same + airdrop 5 SOL
```
Flags: `--network devnet|localnet` (only used together with `--airdrop`; mainnet-beta is
rejected), `--airdrop`. **Despite the name, this action does NOT generate a wallet — it
REQUIRES `PRIVATE_KEY` (base58) in `studio/.env` and throws otherwise.** It converts that
key into `studio/keypair.json`, which is what `keypairFilePath: "./keypair.json"` resolves
to. Need a brand-new wallet first? Create one without echoing the secret:

```bash
cd studio && cp -n .env.example .env
node -e "const {Keypair}=require('@solana/web3.js');const _b=require('bs58');const bs58=_b.default??_b;const fs=require('fs');const k=Keypair.generate();fs.appendFileSync('.env','\nPRIVATE_KEY='+bs58.encode(k.secretKey)+'\n');console.log('New wallet address: '+k.publicKey.toBase58())"
cd .. && pnpm studio generate-keypair --network devnet --airdrop
```
(or `solana-keygen new` if the Solana CLI is installed, then paste its base58 key into `studio/.env`).

### `airdrop-sol`
```bash
pnpm studio airdrop-sol --network devnet
```
Flags: `--network` (devnet or localnet) — **there is no `--amount` flag**; the airdrop amount
is fixed by the action. Requires `studio/keypair.json` to exist.

### `start-test-validator`
```bash
pnpm studio start-test-validator
```
Local validator at `http://localhost:8899` preloaded with all Meteora programs (DLMM, DAMM
v1/v2, DBC, Alpha Vault, Dynamic Vault, locker, metaplex, a transfer-hook fixture).

## DBC actions — config file: `studio/config/dbc_config.jsonc`

### `dbc-create-config`
```bash
pnpm studio dbc-create-config
```
Flags: none. Reads the `dbcConfig` block (curve mode + token + fee + migration +
liquidityDistribution + lockedVesting + `feeClaimer`/`leftoverReceiver`) and `quoteMint`.
**Output: the new config account pubkey is logged — save it; `dbc-create-pool --config <that pubkey>`
launches on it.** Setting `dbcConfig.transferHookProgram` (with `token.tokenType: 1`) creates
a transfer-hook config. Note: min base fee is 25 bps (protocol rule).

### `dbc-create-pool`
```bash
pnpm studio dbc-create-pool                       # creates a NEW config from dbcConfig, then the pool
pnpm studio dbc-create-pool --config <CONFIG_PUBKEY>   # launches on an EXISTING on-chain config
```
Flags: `--config <pubkey>` — **this is the on-chain DBC config account key, NOT a file path.**
Without it, the action creates a config from the `dbcConfig` block first, then the pool.
There is **no `--baseMint` flag**: the mint keypair is generated, or loaded from
`dbcPool.baseMintKeypairFilepath` if set. Reads the `dbcPool` block: `creator`, `name`,
`symbol`, `metadata` (either an existing `uri`, or `image` — URL or file path resolved from
`studio/` (e.g. `./data/image/x.jpg`) — + `description`/socials, uploaded to Irys).
When `uri` is set it takes precedence — the `image`/`description`/social fields may remain
in the file and are ignored (verified).
For transfer-hook configs set `dbcPool.transferHookProgram` to the same hook program.
Output: base mint, config pubkey, and tx hashes are logged — **the pool address is NOT
logged**; derive it with `dbc-get-status --baseMint <MINT>`. Note: in the combined
run (no `--config`), the dry-run's pool-leg simulation always fails with "config doesn't
exist" — expected, since the config isn't on-chain yet; the config-leg simulation is the
meaningful gate. ~0.05 SOL.

### `dbc-swap`
```bash
pnpm studio dbc-swap --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `dbcSwap`: `amountIn` (human units — quote token when
buying, base when selling), `slippageBps`, `swapBaseForQuote` (false = buy base),
`referralTokenAccount`. Transfer-hook pools are detected and routed automatically.

### `dbc-claim-trading-fee`
```bash
pnpm studio dbc-claim-trading-fee --baseMint <MINT>
```
Flags: `--baseMint` (required). Caller must be the pool creator and/or the config's
`feeClaimer` (partner) — the action detects the role and claims the matching share; logs
"No trading fees to claim" when empty. Hook pools use the `2` claim endpoints automatically.

### `dbc-migrate-to-damm-v1` / `dbc-migrate-to-damm-v2`
```bash
pnpm studio dbc-migrate-to-damm-v1 --baseMint <MINT>   # config migrationOption: 0
pnpm studio dbc-migrate-to-damm-v2 --baseMint <MINT>   # config migrationOption: 1
```
Flags: `--baseMint` (required). Preconditions: pool's `quoteReserve` ≥ its
`migrationQuoteThreshold` (check with `dbc-get-status --baseMint <MINT>`), and the config's
`migrationOption` must match the action. The action handles the intermediate steps
(locker for locked vesting, v1 metadata/LP lock+claim) per config. The migration is
permissionless to execute. Verify + find the graduated pool afterwards: `dbc.md`
§Post-graduation. **Post-migration withdrawals (leftover, surplus, migration fee) have no
studio action — BUILD path only (`dbc.md` §client.migration).** ~0.05 SOL.

### `dbc-transfer-pool-creator`
```bash
pnpm studio dbc-transfer-pool-creator --baseMint <MINT>
```
Flags: `--baseMint` (required). New creator comes from config block
`dbcTransferPoolCreator.newCreator` (there is no `--newCreator` flag).

### `dbc-get-status`
```bash
pnpm studio dbc-get-status --baseMint <MINT>
```
Flags: `--baseMint` (required). **Read-only.** Prints pool + config addresses, quote
reserve, migrated flag, graduation %, migration threshold (quote base units), and
unclaimed creator/partner fees.

## DLMM actions — config file: `studio/config/dlmm_config.jsonc`

### `dlmm-create-pool`
```bash
pnpm studio dlmm-create-pool --baseMint <MINT>
```
Flags: `--baseMint` — either pass it, or omit it and fill the `createBaseToken` block to
mint a new token (never both). Reads `dlmmConfig`: `binStep` (bps per bin), `feeBps`,
`initialPrice` (quote per 1 base token), `priceRounding` ("up"/"down"),
`activationType`/`activationPoint`, `creatorPoolOnOffControl`, `hasAlphaVault`, optional
`concreteFunctionType` (0 = limit orders enabled, default) and `collectFeeMode`.
**If `hasAlphaVault: true`, the action also creates the alpha vault automatically** from
this file's `alphaVault` block right after the pool. Output: pool address logged. ~0.05 SOL.
Bin-step heuristic (rule of thumb): stables 1–10, majors 10–25, mid-caps 25–100, new/volatile
tokens 80–400 — wider step = fewer bins per price range, cheaper txs, coarser pricing.

### `dlmm-seed-liquidity-lfg`
```bash
pnpm studio dlmm-seed-liquidity-lfg --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `lfgSeedLiquidity`: `minPrice`/`maxPrice` (range),
`curvature` (0–1, **1/k — LOWER = more concentrated toward maxPrice**), `seedAmount`
(string, **base-token units** to seed), `operatorKeypairFilepath`, `positionOwner`,
`feeOwner`, `lockReleasePoint` (0 = unlocked), `seedTokenXToPositionOwner` (send 1 lamport
of base to owner as on-chain proof — keep true). Seeding is one-sided (base token) along
the curve; wallet must hold the seed amount. Reference: https://ilm.jup.ag

### `dlmm-seed-liquidity-single-bin`
```bash
pnpm studio dlmm-seed-liquidity-single-bin --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `singleBinSeedLiquidity`: `price`, `priceRounding`,
`seedAmount` (string, base-token units), operator/owner fields as above.

### `dlmm-set-pool-status`
```bash
pnpm studio dlmm-set-pool-status --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `setDlmmPoolStatus.enabled` (true = trading on).
Signer must be the pool creator (pools created with `creatorPoolOnOffControl: true`).

### `dlmm-place-limit-order`
```bash
pnpm studio dlmm-place-limit-order --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `placeLimitOrder`: `side` ("bid" = buy with quote
below the active bin, "ask" = sell base above it), `bins[]` of `{ price, amount }` (amount
in human units — quote for bid, base for ask; max 50 bins). Prices are converted to bin IDs
via the pool's binStep — the resting price snaps to the bin; the dry run / rent quote shows
the resolved bins before you commit. Pool must have `concreteFunctionType: 0` (default).
**Output: the limit order account address is logged — save it for cancelling.**

### `dlmm-get-limit-orders`
```bash
pnpm studio dlmm-get-limit-orders --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Read-only: lists the wallet's open orders with per-bin
fill status (`NotFilled`/`PartialFilled`/`Fulfilled`), fees earned, withdrawable amounts.

### `dlmm-cancel-limit-order`
```bash
pnpm studio dlmm-cancel-limit-order --poolAddress <POOL> --limitOrder <ORDER>
pnpm studio dlmm-cancel-limit-order --poolAddress <POOL>    # with cancelLimitOrder.cancelAll: true
```
Flags: `--poolAddress` (required), `--limitOrder` (optional). Cancelling withdraws unfilled
deposits + filled proceeds + earned fees and closes the order account (rent refunded).
Note: fees accrued inside limit orders are ONLY recoverable this way — position fee claims
don't touch them.

### `dlmm-swap`
```bash
pnpm studio dlmm-swap --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `dlmmSwap`: `amountIn` (human units of the INPUT
token), `slippageBps`, `swapForY` (true = sell token X for Y, false = buy X with Y).
Quotes first (out, min-out, price impact logged), then simulates (`dryRun: true`) or sends.
Requires the wallet to hold the input amount; a 0-SOL wallet is rejected with a clear error.

### `dlmm-claim-fees`
```bash
pnpm studio dlmm-claim-fees --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Claims **swap fees + LM rewards** for all of the
wallet's positions on the pool (per-position unclaimed amounts logged first; may send
multiple transactions). Fees inside limit orders are NOT claimed here — cancel the order
to recover those.

### `dlmm-get-positions`
```bash
pnpm studio dlmm-get-positions --poolAddress <POOL>
```
Flags: `--poolAddress` (required). **Read-only.** Prints the active bin and, per position:
bin range, X/Y amounts (base units), unclaimed feeX/feeY.

## DAMM v2 actions — config file: `studio/config/damm_v2_config.jsonc`

### `damm-v2-create-balanced-pool` / `damm-v2-create-one-sided-pool`
```bash
pnpm studio damm-v2-create-balanced-pool --baseMint <MINT>
pnpm studio damm-v2-create-one-sided-pool --baseMint <MINT>
```
Flags: `--baseMint` — or omit and fill `createBaseToken` (never both). Reads the
`dammV2Config` block (pool params incl. price/fees/activation — see the template's comments;
`hasAlphaVault: true` also creates the vault from this file's `alphaVault` block).
Balanced needs both tokens; one-sided needs base only. ~0.05 SOL.

### `damm-v2-add-liquidity`
```bash
pnpm studio damm-v2-add-liquidity --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `addLiquidity`: **`amountIn` (human units) +
`isTokenA`** (which side the amount denominates; the other side is derived from the deposit
quote). Targets the wallet's existing position in that pool (interactive selection if several).

### `damm-v2-remove-liquidity`
```bash
pnpm studio damm-v2-remove-liquidity --poolAddress <POOL>
```
Flags: `--poolAddress` (required). No config block — operates on the wallet's position(s)
in the pool (interactive selection; removes the position's available liquidity).

### `damm-v2-claim-position-fee`
```bash
pnpm studio damm-v2-claim-position-fee --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Claims accrued fees on the wallet's position(s).

### `damm-v2-split-position`
```bash
pnpm studio damm-v2-split-position --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `splitPosition`: `newPositionOwner` plus the seven
percentage fields `unlockedLiquidityPercentage`, `permanentLockedLiquidityPercentage`,
`innerVestingLiquidityPercentage`, `feeAPercentage`, `feeBPercentage`, `reward0Percentage`,
`reward1Percentage` — the share of each dimension transferred to the new owner's position
(there is no `splitLpAmount`; DAMM v2 has position NFTs, not LP tokens).

### `damm-v2-close-position`
```bash
pnpm studio damm-v2-close-position --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Claims fees, removes remaining liquidity, closes the
wallet's position (fails for locked positions).

### `damm-v2-refresh-vesting`
```bash
pnpm studio damm-v2-refresh-vesting --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Refreshes vesting state on the wallet's locked position(s).

### `damm-v2-swap`
```bash
pnpm studio damm-v2-swap --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `dammV2Swap`: `inputMint` (must be one of the
pool's two mints — validated), `amountIn` (human units), `slippage` (percent). Token-2022
aware. Quotes first, then simulates or sends per `dryRun`.

### `damm-v2-get-positions`
```bash
pnpm studio damm-v2-get-positions --poolAddress <POOL>
```
Flags: `--poolAddress` (required). **Read-only.** Prints per position: unlocked/vested/
permanent-locked liquidity and unclaimed tokenA/tokenB fees.

## DAMM v1 actions — config file: `studio/config/damm_v1_config.jsonc`

### `damm-v1-create-pool`
```bash
pnpm studio damm-v1-create-pool --baseMint <MINT>
```
Flags: `--baseMint` — or omit and fill `createBaseToken`. Reads `dammV1Config` (amounts,
fee, activation; see template comments). Fee note: this customizable path takes
`tradeFeeNumerator` over a 100,000 denominator (2500 = 2.5%); the fixed bps tiers
`[25, 100, 400, 600]` in `damm-v1.md` apply to config-based pools, not this path.
Legacy — prefer DAMM v2 for new pools. ~0.05 SOL.

### `damm-v1-lock-liquidity`
```bash
pnpm studio damm-v1-lock-liquidity --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `dammV1LockLiquidity.allocations[]` — each entry's
`percentage` is a share of **the wallet's current LP balance**, locked permanently into a
lock escrow owned by that entry's `address` (which then holds the fee-claim rights,
`damm-v1.md` §Lock escrow). Allocations need not sum to 100 — e.g. one entry at 80 locks
80% and leaves 20% liquid in the wallet. **Permanent locks are irreversible — dry-run and
restate the amounts before executing.**

### `damm-v1-create-stake2earn-farm`
```bash
pnpm studio damm-v1-create-stake2earn-farm --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `stake2EarnFarm` (top-list size, unlock duration,
start time). Creates an M3M3 fee farm on the pool. The staker lifecycle (stake, claim,
unstake, cancel/withdraw) and a status read live in the `stake2earn-*` actions below.

### `damm-v1-lock-liquidity-stake2earn`
```bash
pnpm studio damm-v1-lock-liquidity-stake2earn --baseMint <MINT>
```
Flags: `--baseMint` (required). Locks LP wired to the Stake2Earn fee farm — **run
`damm-v1-create-stake2earn-farm` first**; same `allocations[]` semantics as above.

### `damm-v1-swap`
```bash
pnpm studio damm-v1-swap --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `dammV1Swap`: `inputMint` (one of the pool's
mints — validated), `amountIn` (human units), `slippage` (percent). Quotes, then simulates
or sends per `dryRun`.

### `stake2earn-stake`
```bash
pnpm studio stake2earn-stake --poolAddress <POOL>
```
Flags: `--poolAddress` (required — the DAMM v1 pool, not the fee vault). Reads
`stake2EarnStake.amount` (stake-mint human units, converted via the mint's own decimals).
Fails clearly if no Stake2Earn farm exists yet on this pool (run
`damm-v1-create-stake2earn-farm` first). The SDK's own `stake()` creates the wallet's stake
escrow inline on first use — no separate init step needed.

### `stake2earn-claim-fee`
```bash
pnpm studio stake2earn-claim-fee --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `stake2EarnClaim.maxFee` (`null` = claim
everything pending, sent as `u64::MAX`; or a raw base-unit ceiling applied to both fees).
Prints pending fee A / fee B (in the pool's tokenA/tokenB decimals — they can differ) before
claiming, and refuses with a clear message instead of a no-op transaction when both are zero.

### `stake2earn-unstake`
```bash
pnpm studio stake2earn-unstake --poolAddress <POOL>
```
Flags: `--poolAddress` (required). Reads `stake2EarnUnstake.amount` (stake-mint human units;
must not exceed the wallet's current staked amount). **Generates a fresh `unstake` keypair
that co-signs this transaction — its public key is logged prominently ("SAVE THIS") and is
required by both `stake2earn-cancel-unstake` and `stake2earn-withdraw` afterwards** (set it as
`stake2EarnWithdraw.unstakeKey`). Unstaked tokens stay locked for the farm's
`unstakeLockDuration` seconds (see `stake2earn-get-status`) before `stake2earn-withdraw` can
release them — `stake2earn-cancel-unstake` can reverse the request at any point before that.

### `stake2earn-cancel-unstake` / `stake2earn-withdraw`
```bash
pnpm studio stake2earn-cancel-unstake --poolAddress <POOL>   # reads stake2EarnWithdraw.unstakeKey
pnpm studio stake2earn-withdraw --poolAddress <POOL>         # same config block
```
Flags: `--poolAddress` (required). Both read `stake2EarnWithdraw.unstakeKey` — the address
`stake2earn-unstake` printed. **When `unstakeKey` is left `null`, the action lists every open
unstake request for this wallet on this farm (address, amount, release time) and stops**,
instead of guessing which one to act on. `stake2earn-cancel-unstake` restores the tokens to
the stake escrow and can run any time before withdrawal. `stake2earn-withdraw` pre-checks the
farm's on-chain clock against the unstake's release time and fails with a clear "still locked
for ~N seconds" message if `unstakeLockDuration` hasn't elapsed yet — the on-chain program
would otherwise just revert.

### `stake2earn-get-status`
```bash
pnpm studio stake2earn-get-status --poolAddress <POOL>
```
Flags: `--poolAddress` (required). **Read-only** — keypair is optional (a missing/invalid
keypair file degrades to farm-only output, same as `alpha-vault-get-status`). Prints whether
the farm exists, total staked, top-staker list size and entry threshold
(`getTopStakerListEntryStakeAmount`), unstake lock duration, and seconds-to-full-unlock; with
a usable wallet, also that wallet's staked amount, top-list membership, pending fees, and every
open unstake request (address, amount, release time) via `getUnstakeByUser`.

## Alpha Vault actions — config file: `studio/config/alpha_vault_config.jsonc`

Creation (4 variants + merkle infra) plus the full depositor lifecycle — deposit, withdraw,
claim, refund, and the permissionless crank that buys from the pool — verified against
`@meteora-ag/alpha-vault@1.1.16`'s installed `.d.ts` + source.

### `alpha-vault-create`
```bash
pnpm studio alpha-vault-create --baseMint <MINT>
```
Flags: `--baseMint` (required). The pool is **derived** from baseMint + this file's
`quoteMint` + `alphaVault.poolType` (`dlmm` | `dynamic` (DAMM v1) | `damm2`) — customizable
pool PDAs are unique per token pair, so no pool address is needed. Reads `alphaVault`:
`alphaVaultType` (`fcfs` → `maxDepositCap` + `individualDepositingCap`; `prorata` →
`maxBuyingCap`; amounts in quote units), `depositingPoint` / `startVestingPoint` /
`endVestingPoint` (slots or seconds per the POOL's `activationType`; must be future;
ordering: depositing ≤ pool activation ≤ startVesting ≤ endVesting; start == end vesting =
no vesting), `escrowFee`, `whitelistMode` (`permissionless` |
`permissioned_with_merkle_proof` | `permissioned_with_authority`).
Only needed separately if the pool wasn't created with `hasAlphaVault: true` (DLMM/DAMM v2
pool creation can do it inline from their own config files).

### `alpha-vault-deposit`
```bash
pnpm studio alpha-vault-deposit --vault <VAULT>
pnpm studio alpha-vault-deposit --poolAddress <POOL>   # resolves the vault via memcmp on Vault.pool
```
Flags: `--vault` or `--poolAddress` (one required — `--poolAddress` scans
`getProgramAccounts` for a `Vault.pool` match and uses the first result). Reads
`alphaVaultDeposit.amount` (quote human units). For `permissioned_with_merkle_proof` vaults
the proof is fetched automatically from Meteora's proof API — a wallet with no usable proof
fails clearly instead of hitting an on-chain revert. Pre-checks `interactionState().canDeposit`
+ `availableQuota` first and reports exactly why a blocked deposit is blocked: wrong vault
phase, not whitelisted, or the deposit cap already reached.

### `alpha-vault-withdraw`
```bash
pnpm studio alpha-vault-withdraw --vault <VAULT>
```
Flags: `--vault` (required). Reads `alphaVaultWithdraw.amount` (quote human units).
Prorata-mode vaults only, and only while still in the depositing phase — guarded on
`canWithdraw` (FCFS vaults and vaults past the deposit window are rejected with the reason).

### `alpha-vault-claim`
```bash
pnpm studio alpha-vault-claim --vault <VAULT>
```
Flags: `--vault` (required). No amount to configure — claims everything currently vested
(`claimInfo.totalClaimable`), guarded so "nothing to claim yet" is reported clearly instead of
a revert. Set `alphaVaultClaim.closeEscrowWhenDone: true` to also close the escrow (reclaim
rent) afterwards — only takes effect on a real (non-dry-run) claim, and only once vesting has
ended with everything claimed.

### `alpha-vault-withdraw-remaining-quote`
```bash
pnpm studio alpha-vault-withdraw-remaining-quote --vault <VAULT>
```
Flags: `--vault` (required). No config block. Refunds an escrow's unused ("remaining")
deposit once the vault has finished buying from the pool — the prorata overflow refund;
guarded on `canWithdrawRemainingQuote` (also blocks a second withdrawal once already
refunded).

### `alpha-vault-crank-fill`
```bash
pnpm studio alpha-vault-crank-fill --vault <VAULT>
```
Flags: `--vault` (required). Permissionless — any funded wallet can crank. Loops
`fillVault(payer)` until it returns null (vault fully filled, or the pool ran out of the
liquidity it needed), refreshing vault state between sends so each iteration sees the latest
totals. **Under `dryRun` this only simulates the first transaction and stops** — cranking is
a multi-transaction sequence where each step depends on the previous one having actually
landed, so it cannot be simulated end to end.

### `alpha-vault-get-status`
```bash
pnpm studio alpha-vault-get-status --vault <VAULT>
pnpm studio alpha-vault-get-status --poolAddress <POOL>
```
Flags: `--vault` or `--poolAddress` (one required). **Read-only.** Prints pool/mode/phase,
whitelist mode, caps, and running totals (deposited, swapped, bought, refunded, claimed) from
the vault account. If a usable keypair exists at `keypairFilePath` it also prints that
wallet's `interactionState()` booleans (`canDeposit`/`canWithdraw`/`canClaim`/...) plus
deposit/claim numbers — no keypair is required otherwise (a missing/invalid keypair file
degrades to vault-only output instead of erroring).

## Presale Vault actions — config file: `studio/config/presale_vault_config.jsonc`

Creation (3 modes) plus the full buyer + creator lifecycle — deposit, withdraw, claim,
overflow/failed-raise refunds, raise withdrawal, and unsold-token handling — verified against
`@meteora-ag/presale@0.1.1`'s installed `.d.ts` + source.

### `presale-vault-create`
```bash
pnpm studio presale-vault-create --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `presaleVault`: `presaleRegistries[]` tiers
(`presaleSupply` in **raw base-token units — passed straight to BN, no decimal
conversion** (verified); buyer min/max deposit caps **in quote lamports**;
`depositFeeBps`), timing points, and mode (fcfs/prorata/fixed-price per template comments).
Creator options (SDK 0.1.1): `presaleArgs.disableEarlierPresaleEndOnceCapReached`
(default false), `lockedVestingArgs.immediateReleaseTimestamp` (0/omitted = at
`presaleEndTime`), and fixed-price `fixedPricePresaleConfig.disableWithdraw` (default false).

### `presale-vault-deposit`
```bash
pnpm studio presale-vault-deposit --vault <PRESALE>
```
Flags: `--vault` (required — the presale account pubkey, printed by `presale-vault-create`).
Reads `presaleDeposit`: `amount` (quote human units), `registryIndex` (default `0`;
**serialized as a u8 on-chain — must be an integer 0-255**). Ensures a buyer escrow exists
first: permissionless presales get one built and sent automatically; a
`permissioned_with_merkle_proof` presale auto-fetches the proof from the creator's
permissioned-server metadata (best-effort — fails with a clear "ask the creator" error if no
server/proof is published yet); `permissioned_with_authority` presales require the creator's
operator to create the escrow server-side, so this action errors clearly instead of guessing.
Guarded on the wrapper's `canDeposit()` plus the registry's min/max deposit caps.

### `presale-vault-withdraw`
```bash
pnpm studio presale-vault-withdraw --vault <PRESALE>
```
Flags: `--vault` (required). Reads `presaleWithdraw`: `amount`, `registryIndex`. Only while the
presale is still ongoing — **blocked entirely on FCFS presales, and on fixed-price presales
created with `disableWithdraw: true`** (surfaced by name in the refusal message); prorata
presales always allow it during the deposit window.

### `presale-vault-claim`
```bash
pnpm studio presale-vault-claim --vault <PRESALE>
```
Flags: `--vault` (required). Reads `presaleClaim.registryIndex`. Prints total allocated,
already-claimed, and pending-claimable-right-now (immediate release + linear vesting to date,
computed against the live on-chain clock via `getOnChainTimestamp`) before claiming. Guarded on
the wrapper's `canClaim()` (progress must be `Completed` and vesting must have started).

### `presale-vault-withdraw-remaining-quote`
```bash
pnpm studio presale-vault-withdraw-remaining-quote --vault <PRESALE>
```
Flags: `--vault` (required). No config block — sweeps every registry the wallet has an escrow
on and refunds whichever ones are eligible (prorata overflow once the presale is `Completed`, or
the full deposit back once it's `Failed`), skipping and reporting the rest.

### `presale-vault-creator-withdraw`
```bash
pnpm studio presale-vault-creator-withdraw --vault <PRESALE>
```
Flags: `--vault` (required, creator wallet only — checked client-side before sending). No
required config block; optional `presaleCreatorWithdraw.collectFee: true` also calls
`creatorCollectFee()` right after (logs a clear skip if not yet eligible). Withdraws raise
proceeds (quote token) once `Completed`, or the unsold base-token supply back once `Failed` —
guarded on `canCreatorWithdraw()`.

### `presale-vault-handle-unsold`
```bash
pnpm studio presale-vault-handle-unsold --vault <PRESALE>
```
Flags: `--vault` (required). No config block. Permissionless crank — burns or
refunds-to-creator the unsold base-token supply per the presale's `unsoldTokenAction`, once the
raise has resolved (`Completed` or `Failed`); errors if the action has already been performed.

### `presale-vault-get-status`
```bash
pnpm studio presale-vault-get-status --vault <PRESALE>
```
Flags: `--vault` (required). **Read-only** — keypair is optional (a missing/invalid keypair
file degrades to presale-only output, same as `alpha-vault-get-status`). Prints progress
state/%, mode, whitelist mode, totals, average token price, timings, every gate boolean, and a
per-registry table (supply, deposits, caps, fee, price); with a usable wallet, also each of its
escrows (deposited, claimable, pending, withdrawable-remaining-quote). **After the raise** —
once progress is `Completed`, prints next-step hints: the creator runs
`presale-vault-creator-withdraw` and then seeds a market with the raised quote + reserved
supply (`dlmm-create-pool`, `damm-v2-create-balanced-pool`, `damm-v1-create-pool`, or a DBC
config + pool for curve-style launches — no single composite action does this hand-off, by
design); buyers run `presale-vault-claim`.

## Met Lock actions — config file: `studio/config/lock_config.jsonc`

Standalone vesting/locking for any SPL or Token-2022 mint — program
`LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn`, not coupled to any pool; a natural follow-up
after any token launch ("lock the team allocation"). Verified against
`@meteora-ag/met-lock-sdk@1.0.1`'s source + installed `.d.ts` — its shipped `docs.md` has
known errors (see `other-products.md`), so these actions mirror the SDK repo's own
`createVestingEscrowV2.s.ts` / `claimV2.s.ts` scripts instead.

### `lock-create-vesting-escrow`
```bash
pnpm studio lock-create-vesting-escrow --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `lockCreateEscrow`: `recipient`, `vestingStartTime` /
`cliffTime` (unix **seconds**), `frequency` (seconds between unlock periods),
`cliffUnlockAmount` + `amountPerPeriod` (human token units, converted via the mint's
decimals), `numberOfPeriod`, `updateRecipientMode` / `cancelMode` (0-3: NONE / CREATOR_ONLY /
RECIPIENT_ONLY / CREATOR_RECIPIENT), `isSenderMultiSig`. Pre-checks the wallet's token
balance against `cliffUnlockAmount + amountPerPeriod * numberOfPeriod` before building the
transaction; Token-2022 mints are detected automatically (mint owner-program check).
**Generates a fresh `base` keypair that co-signs once** — signers are
`[sender=wallet, base, payer=wallet]` — and **the derived escrow address is logged
prominently: save it**, every other `lock-*` action needs it via `--escrow`. wSOL note: this
action does NOT wrap SOL for you — if `baseMint` is native SOL, the wallet's wSOL associated
token account must already hold enough wrapped SOL, or the balance pre-check fails with a
clear error (no silent auto-wrap). ~0.01 SOL.

### `lock-create-escrow-metadata`
```bash
pnpm studio lock-create-escrow-metadata --escrow <ESCROW>
```
Flags: `--escrow` (required). Reads `lockEscrowMetadata`: `name`, `description`,
`creatorEmail`, `recipientEmail`. Signers: `[creator=wallet, payer=wallet]` — the action
checks the wallet is the escrow's creator before sending, and logs the derived
escrow-metadata PDA.

### `lock-claim`
```bash
pnpm studio lock-claim --escrow <ESCROW>
```
Flags: `--escrow` (required). Reads `lockClaim.maxAmount` (human token units; **omit/null =
claim everything currently vested**, sent as u64::MAX under the hood — the program caps the
actual transfer at what has vested). Signers: `[payer=wallet, recipient=wallet]` — the action
checks the wallet is the escrow's recipient before sending.

### `lock-get-escrow`
```bash
pnpm studio lock-get-escrow --escrow <ESCROW>
```
Flags: `--escrow` (required). **Read-only, no keypair loaded.** Prints recipient, creator,
token mint + program, schedule (vesting start, cliff, frequency, periods), and computed
**total / claimed / claimable** amounts (linear-vesting math applied to the escrow's raw
fields — this isn't part of the SDK's own surface). The underlying `getEscrow()` call THROWS
on a missing account; this action catches it and reports a clean "no escrow found" error
instead of the raw exception.

### `lock-list-escrows`
```bash
pnpm studio lock-list-escrows
```
Flags: none. Reads `lockList.role` (`"recipient"` | `"creator"`). Loads the wallet (needed to
know whose escrows to list) but does **not** check its SOL balance — nothing is signed.
`program.account.vestingEscrow.all` with a memcmp filter: offset 8 for recipient, offset 72
for creator (both verified against the SDK repo's `sumCreatorLockVaultTotals.s.ts` script).
Lists raw base-unit total/claimed/claimable per escrow — run `lock-get-escrow --escrow
<ADDR>` for the decimal-formatted single view.

## Dynamic Vault actions — config file: `studio/config/dynamic_vault_config.jsonc`

The yield layer under DAMM v1 pool reserves — program
`24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi` (**Anchor 0.28, the oldest stack in the
studio**). Verified against `@meteora-ag/vault-sdk@2.3.1`'s installed `.d.ts` + compiled
source. All three actions key off **the token mint being deposited/withdrawn (`--baseMint`),
not a vault address** — there is one permissionless dynamic vault per mint, PDA-derived from
it; DAMM v1 pools already reference these same vaults internally as `pool.vaultA` /
`pool.vaultB`.

### `vault-deposit`
```bash
pnpm studio vault-deposit --baseMint <MINT>
```
Flags: `--baseMint` (required — the mint being deposited, e.g. wSOL or USDC; fails clearly if
no permissionless vault exists yet for this mint). Reads `dynamicVaultDeposit.amount` (baseMint
human units, converted via the mint's own decimals). wSOL note (verified against the installed
package's compiled `deposit()`): **when `baseMint` is native SOL's wrapped mint, the SDK wraps
the requested amount of SOL for you internally** — unlike `lock-create-vesting-escrow`, there
is no pre-funded-wSOL requirement, just enough actual SOL in the wallet to cover the wrap
amount plus rent/fees (checked up front with a clear error otherwise).

### `vault-withdraw`
```bash
pnpm studio vault-withdraw --baseMint <MINT>
```
Flags: `--baseMint` (required). Reads `dynamicVaultWithdraw.amount` — **in VAULT LP TOKEN
human units, NOT baseMint units.** The SDK's `withdraw(owner, baseTokenAmount)` is misleadingly
named: verified against the compiled source (it computes `amountToWithdraw = baseTokenAmount *
withdrawableAmount / totalSupply` — exactly the `getAmountByShare` formula) and the vault
program's IDL (the on-chain instruction's real args are `unmintAmount` + `minOutAmount`), the
amount burns **LP/vault shares**, not the underlying token. The LP mint always has the same
decimals as `baseMint` on-chain, so the human-unit scale looks identical, but 1 LP token does
not equal 1 baseMint token once the vault has earned yield. Guarded against withdrawing more LP
than the wallet's `getUserBalance` holds; **prints the equivalent underlying-token amount this
will actually redeem (via `getAmountByShare`) before every send** — run `vault-get-status`
first to see the wallet's LP balance and current virtual price if unsure. Auto-unwraps to SOL
on exit when `baseMint` is native SOL's wrapped mint.

### `vault-get-status`
```bash
pnpm studio vault-get-status --baseMint <MINT>
```
Flags: `--baseMint` (required). **Read-only** — keypair is optional (a missing/invalid
keypair file degrades to vault-only output, same as `alpha-vault-get-status`). Prints the vault
PDA, total LP supply, withdrawable amount (underlying tokens available right now, locked profit
already excluded), and the virtual price (withdrawable amount ÷ total LP supply); with a usable
wallet, also that wallet's LP balance and its current underlying redemption value.

## Dynamic Fee Sharing actions — config file: `studio/config/fee_sharing_config.jsonc`

Splits a fee stream among up to 5 fixed recipients — program
`dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh`. Verified against
`@meteora-ag/dynamic-fee-sharing-sdk@1.1.0`'s installed `.d.ts` + source (has a `docs.md`,
cross-checked against the shipped scripts). Vault creation co-signs with a fresh, ephemeral
keypair (the vault's own `feeVault` keypair, or a `base` keypair for the PDA variant) — used
once, and the resulting vault address is logged prominently (save it: every other
`fee-sharing-*` action needs it via `--vault`). The two `fund-from-*` bridge actions pull fees
straight out of an existing DAMM v2 position or DBC pool into the vault — no separate
"claim then transfer" step. DBC bridging always uses the `2`-suffixed trading-fee variants
(`fundByClaimDbcCreatorTradingFee2` / `fundByClaimDbcPartnerTradingFee2`), per the SDK's own
release notes.

### `fee-sharing-create-vault`
```bash
pnpm studio fee-sharing-create-vault --baseMint <MINT>
```
Flags: `--baseMint` (required — the token mint whose fees will be shared). Reads
`feeSharingCreate`: `userShares` (2-5 `{address, share}` entries — the program allows at most 5
recipients; `share` is a relative integer weight, NOT a percentage, and does not need to sum to
100), `useKeypairVault` (`true` = `createFeeVault`, a fresh **feeVault KEYPAIR co-signs once and
IS the vault address**; `false` = `createFeeVaultPda`, a fresh **base keypair co-signs once** and
the vault address is a PDA derived from base + tokenMint). Either way **the vault address is
logged prominently — save it**; the co-signing keypair's secret is discarded afterward (never
needed again). Token-2022 mints are detected automatically (mint owner-program check). ~0.01 SOL.

### `fee-sharing-fund`
```bash
pnpm studio fee-sharing-fund --vault <VAULT>
```
Flags: `--vault` (required). Reads `feeSharingFund.amount` (the vault's tokenMint human units,
converted via the mint's own decimals). Pre-checks the wallet's token balance first. wSOL note:
when the vault's tokenMint is native SOL's wrapped mint, the SDK wraps the requested amount of
SOL for you internally — no pre-funded wSOL account needed. ~0.002 SOL.

### `fee-sharing-fund-from-damm-v2`
```bash
pnpm studio fee-sharing-fund-from-damm-v2 --vault <VAULT> --poolAddress <POOL>
```
Flags: `--vault` + `--poolAddress` (both required). Resolves the wallet's position(s) on the
pool via `cpAmm.getUserPositionByPool` (same lookup `damm-v2-get-positions` uses), then picks
the first one whose position-NFT account is already owned by the fee vault
(`checkPositionOwnership`, Token-2022 — DAMM v2 position NFTs always are) and sweeps its fees
straight into the vault via `fundByClaimDammV2Fee`. **The position NFT must already have been
transferred to the fee vault** (the SDK's `setTokenAccountOwnerTx` helper — a one-time manual
step outside this action) or this fails with a clear pre-flight error instead of a doomed
transaction. ~0.001 SOL.

### `fee-sharing-fund-from-dbc`
```bash
pnpm studio fee-sharing-fund-from-dbc --vault <VAULT> --baseMint <MINT>
```
Flags: `--vault` + `--baseMint` (both required — `--baseMint` resolves the DBC pool via
`DynamicBondingCurveClient.state.getPoolByBaseMint`, same as `dbc-get-status`). Reads
`feeSharingFundDbc`: `role` (`"creator"` | `"partner"`) x `source` (`"tradingFee"` |
`"surplus"` | `"migrationFee"`) routes to the matching bridge — **always the `2`-suffixed
trading-fee variants** (`fundByClaimDbcCreatorTradingFee2` / `fundByClaimDbcPartnerTradingFee2`),
never the unsuffixed ones; `surplus` → `fundByWithdrawDbc{Creator,Partner}Surplus`;
`migrationFee` → `fundByWithdrawDbcMigrationFee` with `isPartner` set from `role`. The fee vault
must already be set as the DBC pool config's creator (role `"creator"`) or feeClaimer (role
`"partner"`) — the SDK validates this itself and throws a clear `InvalidCreator` /
`InvalidFeeClaimer` error otherwise. ~0.001 SOL.

### `fee-sharing-claim`
```bash
pnpm studio fee-sharing-claim --vault <VAULT>
```
Flags: `--vault` (required). Prints the wallet's allocated/claimed/claimable amounts first
(`getFeeBreakdown`) and refuses to send if nothing is claimable yet. Uses `claimUserFee2` with
`receiver` = the wallet — unlike `claimUserFee`, the receiver does not need to sign. ~0.001 SOL.

### `fee-sharing-get-status`
```bash
pnpm studio fee-sharing-get-status --vault <VAULT>
```
Flags: `--vault` (optional). **Read-only** — keypair is optional (a missing/invalid keypair
file degrades to vault-only output, same as `vault-get-status`). With `--vault`: prints the
vault header (owner, token mint, token vault, total share) plus `getFeeBreakdown` totals and a
per-user table (each user's total/claimed/unclaimed). Without `--vault` but with a usable
keypair: reverse-lookup via `getRecipientDfsVault` and list every vault the wallet holds a
share in.

## Quick Reference

| Action | Required flag | Config block(s) | ~Min SOL |
|---|---|---|---|
| `generate-keypair` | — (`--network`, `--airdrop` opt.) | — | 0 |
| `airdrop-sol` | `--network` | — | 0 |
| `start-test-validator` | — | — | 0 |
| `dbc-create-config` | — | `dbcConfig` | 0.01 |
| `dbc-create-pool` | — (`--config <config pubkey>` opt.) | `dbcPool` (+ `dbcConfig` if no `--config`) | 0.05 |
| `dbc-swap` | `--baseMint` | `dbcSwap` | 0.001 |
| `dbc-claim-trading-fee` | `--baseMint` | — | 0.001 |
| `dbc-migrate-to-damm-v1` | `--baseMint` | — | 0.05 |
| `dbc-migrate-to-damm-v2` | `--baseMint` | — | 0.05 |
| `dbc-transfer-pool-creator` | `--baseMint` | `dbcTransferPoolCreator` | 0.001 |
| `dbc-get-status` | `--baseMint` | — (read-only) | 0 |
| `dlmm-create-pool` | `--baseMint` or `createBaseToken` | `dlmmConfig` (+ `alphaVault` if enabled) | 0.05 |
| `dlmm-seed-liquidity-lfg` | `--baseMint` | `lfgSeedLiquidity` | 0.01 |
| `dlmm-seed-liquidity-single-bin` | `--baseMint` | `singleBinSeedLiquidity` | 0.01 |
| `dlmm-set-pool-status` | `--poolAddress` | `setDlmmPoolStatus` | 0.001 |
| `dlmm-place-limit-order` | `--poolAddress` | `placeLimitOrder` | 0.01 |
| `dlmm-get-limit-orders` | `--poolAddress` | — | 0 |
| `dlmm-cancel-limit-order` | `--poolAddress` (`--limitOrder` opt.) | `cancelLimitOrder` | 0.001 |
| `dlmm-swap` | `--poolAddress` | `dlmmSwap` | 0.001 |
| `dlmm-claim-fees` | `--poolAddress` | — | 0.001 |
| `dlmm-get-positions` | `--poolAddress` | — (read-only) | 0 |
| `damm-v2-create-balanced-pool` | `--baseMint` or `createBaseToken` | `dammV2Config` | 0.05 |
| `damm-v2-create-one-sided-pool` | `--baseMint` or `createBaseToken` | `dammV2Config` | 0.05 |
| `damm-v2-add-liquidity` | `--poolAddress` | `addLiquidity` | 0.01 |
| `damm-v2-remove-liquidity` | `--poolAddress` | — | 0.001 |
| `damm-v2-claim-position-fee` | `--poolAddress` | — | 0.001 |
| `damm-v2-split-position` | `--poolAddress` | `splitPosition` | 0.01 |
| `damm-v2-close-position` | `--poolAddress` | — | 0.001 |
| `damm-v2-refresh-vesting` | `--poolAddress` | — | 0.001 |
| `damm-v2-swap` | `--poolAddress` | `dammV2Swap` | 0.001 |
| `damm-v2-get-positions` | `--poolAddress` | — (read-only) | 0 |
| `damm-v1-create-pool` | `--baseMint` or `createBaseToken` | `dammV1Config` | 0.05 |
| `damm-v1-lock-liquidity` | `--baseMint` | `dammV1LockLiquidity` | 0.01 |
| `damm-v1-create-stake2earn-farm` | `--baseMint` | `stake2EarnFarm` | 0.05 |
| `damm-v1-lock-liquidity-stake2earn` | `--baseMint` | `dammV1LockLiquidity` + `stake2EarnFarm` | 0.01 |
| `damm-v1-swap` | `--poolAddress` | `dammV1Swap` | 0.001 |
| `stake2earn-stake` | `--poolAddress` | `stake2EarnStake` | 0.002 |
| `stake2earn-claim-fee` | `--poolAddress` | `stake2EarnClaim` | 0.001 |
| `stake2earn-unstake` | `--poolAddress` | `stake2EarnUnstake` | 0.001 |
| `stake2earn-cancel-unstake` | `--poolAddress` | `stake2EarnWithdraw` | 0.001 |
| `stake2earn-withdraw` | `--poolAddress` | `stake2EarnWithdraw` | 0.001 |
| `stake2earn-get-status` | `--poolAddress` | — (read-only) | 0 |
| `alpha-vault-create` | `--baseMint` | `alphaVault` | 0.05 |
| `alpha-vault-deposit` | `--vault` or `--poolAddress` | `alphaVaultDeposit` | 0.002 |
| `alpha-vault-withdraw` | `--vault` | `alphaVaultWithdraw` | 0.001 |
| `alpha-vault-claim` | `--vault` | — (`alphaVaultClaim` opt.) | 0.001 |
| `alpha-vault-withdraw-remaining-quote` | `--vault` | — | 0.001 |
| `alpha-vault-crank-fill` | `--vault` | — | 0.001 (per tx; may send several) |
| `alpha-vault-get-status` | `--vault` or `--poolAddress` | — (read-only) | 0 |
| `presale-vault-create` | `--baseMint` | `presaleVault` | 0.05 |
| `presale-vault-deposit` | `--vault` | `presaleDeposit` | 0.002 |
| `presale-vault-withdraw` | `--vault` | `presaleWithdraw` | 0.001 |
| `presale-vault-claim` | `--vault` | `presaleClaim` | 0.001 |
| `presale-vault-withdraw-remaining-quote` | `--vault` | — | 0.001 |
| `presale-vault-creator-withdraw` | `--vault` | — (`presaleCreatorWithdraw` opt.) | 0.001 |
| `presale-vault-handle-unsold` | `--vault` | — | 0.001 |
| `presale-vault-get-status` | `--vault` | — (read-only) | 0 |
| `lock-create-vesting-escrow` | `--baseMint` | `lockCreateEscrow` | 0.01 |
| `lock-create-escrow-metadata` | `--escrow` | `lockEscrowMetadata` | 0.002 |
| `lock-claim` | `--escrow` | `lockClaim` | 0.001 |
| `lock-get-escrow` | `--escrow` | — (read-only) | 0 |
| `lock-list-escrows` | — | `lockList` | 0 |
| `vault-deposit` | `--baseMint` | `dynamicVaultDeposit` | 0.002 |
| `vault-withdraw` | `--baseMint` | `dynamicVaultWithdraw` | 0.001 |
| `vault-get-status` | `--baseMint` | — (read-only) | 0 |
| `fee-sharing-create-vault` | `--baseMint` | `feeSharingCreate` | 0.01 |
| `fee-sharing-fund` | `--vault` | `feeSharingFund` | 0.002 |
| `fee-sharing-fund-from-damm-v2` | `--vault` + `--poolAddress` | — | 0.001 |
| `fee-sharing-fund-from-dbc` | `--vault` + `--baseMint` | `feeSharingFundDbc` | 0.001 |
| `fee-sharing-claim` | `--vault` | — | 0.001 |
| `fee-sharing-get-status` | `--vault` (optional) | — (read-only) | 0 |

Min-SOL values are rough rent+fee estimates; the `dryRun` simulation is the authoritative check.

> Not here by design: DLMM add-to-existing-position / rebalance, CP-AMM position
> management beyond the listed actions, and vault/presale user flows — BUILD-path tasks;
> see the protocol reference packs and `other-products.md`.
