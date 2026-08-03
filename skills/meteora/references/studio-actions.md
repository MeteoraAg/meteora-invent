# Studio CLI — Full Action Reference (ACT path)

All 38 studio actions, verified against `studio/src/actions/` and `studio/src/helpers/cli.ts`.
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
start time). Creates an M3M3 fee farm on the pool. Farm operations beyond creation
(staking, claims) live in `@meteora-ag/m3m3` — not yet covered by this skill.

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

## Vault actions

### `alpha-vault-create` — config file: `studio/config/alpha_vault_config.jsonc`
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

### `presale-vault-create` — config file: `studio/config/presale_vault_config.jsonc`
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
Scope note: this skill covers vault **creation only** — buyer claims, raise withdrawal,
refunds, and tier-assignment mechanics are not yet covered; see
https://docs.meteora.ag/helper-products/presale-vault/what-is-presale-vault.md and dry-run
output before committing real funds.

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
| `alpha-vault-create` | `--baseMint` | `alphaVault` | 0.05 |
| `presale-vault-create` | `--baseMint` | `presaleVault` | 0.05 |

Min-SOL values are rough rent+fee estimates; the `dryRun` simulation is the authoritative check.

> Not here by design: DLMM add-to-existing-position / rebalance, CP-AMM position
> management beyond the listed actions, and vault/presale user flows — BUILD-path tasks;
> see the protocol reference packs and `other-products.md`.
