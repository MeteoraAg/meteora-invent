# Meteora One-Shot Scripts

Standalone scripts for the actions the studio CLI doesn't cover — no monorepo required.
SDK versions are **pinned exactly** to the versions the skill's references were verified
against. Every write **simulates by default**; add `--execute` to send for real.

## Setup

```bash
# copy this folder OUTSIDE the monorepo, then:
npm install                                          # Node >= 18 (plain npm — don't run inside the pnpm repo)
export RPC_URL=https://api.devnet.solana.com         # or your mainnet RPC
export KEYPAIR_PATH=/path/to/keypair.json            # or PRIVATE_KEY=<base58>
# optional: CU_PRICE_MICROLAMPORTS=100000            # priority fee (default 100000)
```

Read-only scripts (`positions.ts`, `dbc-status.ts`) need only `RPC_URL` — no keypair.
Need a throwaway JSON keypair for dry-run quotes (no funds, no secret echoed)?
`node -e "const {Keypair}=require('@solana/web3.js');const fs=require('fs');const k=Keypair.generate();fs.writeFileSync('throwaway.json',JSON.stringify(Array.from(k.secretKey)),{mode:0o600});console.log('address: '+k.publicKey.toBase58())"`
— note a 0-SOL signer still quotes fine, but the dry-run simulation will report
`err="AccountNotFound"` (fee payer doesn't exist on-chain). The QUOTE above that line is
valid; fund the wallet before `--execute`.

Run with `npx ts-node` (CommonJS), not `tsx` — tsx on recent Node versions mis-resolves
`@meteora-ag/dlmm` as ESM and crashes on import.

## Scripts and flags

| Script | Flags (required → optional) | Notes |
|---|---|---|
| `dlmm-swap.ts` | `--pool <DLMM pool>` `--amount <base units of INPUT token>` `--side buy\|sell` → `--slippage-bps <int, default 100>` `--execute` | `sell` = X→Y, `buy` = Y→X |
| `damm-v2-swap.ts` | `--pool <pool>` `--input-mint <mint>` `--amount <base units>` → `--slippage <PERCENT, default 0.5>` `--execute` | token-2022 aware; input mint must be one of the pool's two mints |
| `damm-v1-swap.ts` | `--pool <pool>` `--input-mint <mint>` `--amount <base units>` → `--slippage <PERCENT, default 0.5>` `--execute` | legacy pools |
| `positions.ts` | `--owner <wallet>` → `--protocol dlmm\|damm-v2\|all (default all)` `--pool <pool>` | read-only. **Without `--pool`, DLMM mode scans ALL pools** (heavy, counts only); pass `--pool` for bins/amounts/fees detail |
| `dlmm-claim-fees.ts` | `--pool <pool>` → `--rewards` (fees + LM rewards) `--execute` | fees inside limit orders are NOT claimed here — cancel the order to recover them |
| `dbc-status.ts` | `--mint <base mint>` | read-only; prints `quoteReserve`/`threshold` in **quote base units (lamports)**, graduation as % |

Units: every `--amount` is **base units (lamports) of the input token**. Slippage units
differ: DLMM uses **bps** (`--slippage-bps 100` = 1%), DAMM v1/v2 use **percent**
(`--slippage 0.5` = 0.5%).

Common mints: SOL `So11111111111111111111111111111111111111112` ·
USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.

Dependency note: this package intentionally mixes `dynamic-amm-sdk` (Anchor 0.29) with the
Anchor-0.31 SDKs — `damm-v1-swap.ts` casts at that SDK's boundary (same pattern the studio
uses). Don't pass objects between the DAMM v1 SDK and the others.

For flows not covered here (pool creation, launches, migrations, seeding, vaults) use the
studio CLI — see `../references/studio-actions.md`. For custom code, start from the
protocol reference packs in `../references/`.
