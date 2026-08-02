# Other Products — Alpha Vault, Presale, Stake2Earn, Zap, Dynamic Vault, Fee Sharing

> Compact SDK surfaces verified against the packages installed with the studio
> (read from each package's shipped `.d.ts`, 2026-08-02). Creation flows for alpha/presale
> vaults are ACT-path (`studio-actions.md`); this file covers the SDK surface — above all
> the **read/verify calls** the studio doesn't expose. All are web3.js v1.
> ⚠️ Anchor versions diverge (vault-sdk 0.28 · m3m3 0.29 · the rest 0.31) — never pass
> `Program`/`BN` objects across these SDK boundaries.

## Alpha Vault — `@meteora-ag/alpha-vault@1.1.16`

Program `vaU6kP7iNEGkbmPkLmZfGwiGxd4Mob24QQCie5R9kd2` (mainnet + devnet; **exported as a
string keyed by cluster, not PublicKey**). Enums: `PoolType { DLMM=0, DAMM=1, DAMMV2=2 }`,
`VaultMode { PRORATA=0, FCFS=1 }`, `VaultState { PREPARING..ENDED }`.

**Verify a vault (closes the ACT-path verification gap):**
```ts
import AlphaVault from '@meteora-ag/alpha-vault'
// Given only the POOL address there is no pure PDA derivation (the 'base' seed is the
// creator or config, not the pool). Find the vault by scanning:
const accounts = await connection.getProgramAccounts(new PublicKey(ALPHA_VAULT_PROGRAM_ID), {
  filters: [{ memcmp: { offset: 8, bytes: poolAddress.toBase58() } }],  // Vault.pool is the first field
})
const av = await AlphaVault.create(connection, accounts[0].pubkey)
// av.vault (state), av.mode (VaultMode), av.vaultState (lifecycle phase)
const escrow = await av.getEscrow(userPubkey)
const state = await av.interactionState(escrow)   // { depositInfo, claimInfo, availableQuota,
                                                  //   canDeposit, canClaim, canWithdraw, ... }
```
User ops (all → `Transaction`): `deposit(maxAmount, owner, merkleProof?)`, `withdraw`,
`withdrawRemainingQuote`, `claimToken`, `closeEscrow`. Crank: `fillVault(payer)`.
Gotcha: the package bundles a second Anchor 0.28 copy for its DLMM/DAMM v1 programs.

## Presale Vault — `@meteora-ag/presale@0.1.1`

Program `4Xgt6XKZiowAGNdPWngVAwpYbSwAmbBnRBPtCFXhrypc`. **Pre-1.0 — expect churn.**
Since 0.0.5 (changelog + source, verified): `presaleArgs` gained required
`disableEarlierPresaleEndOnceCapReached` (keep FCFS/fixed-price running until end time even
after the cap is hit) and `lockedVestingArgs` gained required `immediateReleaseTimestamp`
(when the immediate-release portion unlocks — the SDK's examples default it to
`presaleEndTime`); fixed-price creates take `disableWithdraw`. New helpers:
`getOnChainTimestamp(connection)`, `calculateLockAndVestDurationFromTimestamps(...)`,
`getRegistryRemainingDepositQuota` on the wrapper, and a max-presale-cap calculator;
`getPendingClaimable{Raw,Ui}Amount` now REQUIRE a `currentTimestamp` argument.

```ts
import { Presale, derivePresale } from '@meteora-ag/presale'
const presaleAddress = derivePresale(baseMint, quoteMint, base, PRESALE_PROGRAM_ID) // seeds ["presale", base, mint, quote]
const presale = await Presale.create(connection, presaleAddress)
const w = presale.getParsedPresale()          // PresaleWrapper:
// w.getPresaleProgressState()  -> NotStarted|Ongoing|Completed|Failed
// w.getPresaleProgressPercentage(), w.getTotalDepositUiAmount(), w.getAverageTokenPrice()
// w.canDeposit()/canWithdraw()/canClaim()/canCreatorWithdraw()
const escrows = await presale.getPresaleEscrowByOwner(buyer)  // per-buyer state
```
Buyer lifecycle (instance methods → `Transaction`): `createPermissionlessEscrow` →
`deposit({ owner, amount, registryIndex? })` → (after end) `claim({ owner, registryIndex })`
/ `withdrawRemainingQuote`. Creator: `creatorWithdraw`, `creatorCollectFee`,
`performUnsoldBaseTokenAction`. Gotcha: `registryIndex` is a BN serialized as **u8**.

## Stake2Earn (M3M3) — `@meteora-ag/m3m3@1.0.10`

Program `FEESngU3neckdwib9X3KWqdL7Mjmqk9XNp3uh5JbP4KP`. DAMM v1 pools only. **Anchor 0.29.**

```ts
import StakeForFee from '@meteora-ag/m3m3'
const s4f = await StakeForFee.create(connection, poolAddress)   // derives the fee vault from the pool
const { stakeEscrow, unclaimFee } = await s4f.getUserStakeAndClaimBalance(user)
// stakeEscrow.stakeAmount, .inTopList, unclaimFee.feeA/.feeB — the farm verification call
```
User ops: `initializeStakeEscrow(owner)` → `stake(maxAmount, owner)` →
`claimFee(owner, maxFee)` · `unstake(amount, unstakeKey, owner)` → `withdraw(unstakeKey, owner)`.
Admin: `StakeForFee.createFeeVault(...)` (what the studio's stake2earn actions wrap).

## Zap — `@meteora-ag/zap-sdk@1.3.2`

Program `zapvX9M3uf5pvy4wRPAbQgdQsM1xmuiFnkfHKPvwMiz`. Single-token in/out of DAMM v2 and
DLMM positions, optionally routing through Jupiter (**Jupiter API key required**).
`new Zap(connection, { jupiterApiUrl?, jupiterApiKey? })` — one config object (the README's
3-arg example is stale). Two-phase: `getZapInDammV2DirectPoolParams(...)` →
`buildZapInDammV2Transaction(...)`; same for DLMM (`...Dlmm...`); `zapOut*` variants; also
`rebalanceDlmmPosition(params)`. Build results are **multi-transaction bundles**
(`setupTransaction`, `swapTransactions[]`, `zapInTransaction`, `cleanUpTransaction`) — send in order.

## Dynamic Vault — `@meteora-ag/vault-sdk@2.3.1`

Program `24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi`. The yield layer under DAMM v1 pool
reserves. **Anchor 0.28, oldest stack.** `VaultImpl.create(connection, tokenMint)` (keys off
the TOKEN MINT, not a vault address) → `getUserBalance(owner)`, `getVaultSupply()`,
`getWithdrawableAmount()`; ops `deposit(owner, amount)` / `withdraw(owner, amount)`.
DAMM v1's `AmmImpl` already exposes these per-pool as `pool.vaultA` / `pool.vaultB`.

## Dynamic Fee Sharing — `@meteora-ag/dynamic-fee-sharing-sdk@1.1.0`

Program `dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh`. Splits fees among fixed recipients.
`new DynamicFeeSharingClient(connection, commitment)` →
`getFeeBreakdown(feeVault)` → `{ totalFundedFee, totalClaimedFee, totalUnclaimedFee, userFees[] }`;
`getRecipientDfsVault(recipient)` (reverse lookup). Create: `createFeeVault(params)`.
Funding bridges pull straight from other protocols: `fundByClaimDammV2Fee`,
`fundByClaimDbcCreatorTradingFee2` / `...PartnerTradingFee2` (use the `2` variants),
`fundByWithdrawDbcMigrationFee`. User claim: `claimUserFee2({ feeVault, user, payer, receiver })`.
Gotcha: ESM-first package (`"type": "module"` with a `.cjs` fallback).
