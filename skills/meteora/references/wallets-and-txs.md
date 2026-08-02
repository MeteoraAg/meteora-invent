# Wallets, RPC, and Transactions

Shared rules for every Meteora action. All four SDKs are **web3.js v1** — legacy
`Connection` / `Transaction` / `Keypair`. Do not use `@solana/kit` / web3.js v2.

## Keypairs

**ACT path (studio):** the signer is the file at `keypairFilePath` in the config
(default `./keypair.json`, resolved from `studio/` — written to `studio/keypair.json`).

```bash
cp -n studio/.env.example studio/.env      # set PRIVATE_KEY=<base58> in it (required!)
pnpm studio generate-keypair --network devnet --airdrop
# generate-keypair CONVERTS PRIVATE_KEY -> studio/keypair.json; it cannot create keys.
# New-wallet recipe (no secret echoed): studio-actions.md §generate-keypair
```

**BUILD path (scripts):** load from a file or env var — never inline:

```ts
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import fs from 'fs'

export function loadKeypair(): Keypair {
  if (process.env.KEYPAIR_PATH) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR_PATH, 'utf-8'))))
  }
  if (process.env.PRIVATE_KEY) {                       // base58 string
    return Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY))
  }
  throw new Error('Set KEYPAIR_PATH (JSON keypair file) or PRIVATE_KEY (base58)')
}
```

**Rules:** never print, log, echo, or commit a secret key; never write one into source
code or a chat reply; keypair files and `.env` stay gitignored. If the owner pastes a key
into chat, advise rotating it after the task.

## Networks & RPC

| Network | Public RPC | Use |
|---|---|---|
| devnet | `https://api.devnet.solana.com` | Default for first runs; free airdrops |
| mainnet-beta | `https://api.mainnet-beta.solana.com` | Rate-limited; fine for reads/tests only |
| localnet | `http://localhost:8899` | `pnpm studio start-test-validator` (Meteora programs preloaded) |

For mainnet writes use a paid RPC (Helius / QuickNode / Triton) — public mainnet RPC
drops transactions under load. All Meteora program IDs are identical on mainnet and devnet.

Balance check before any write: `solana balance <PUBKEY> -u devnet` (CLI, if installed) or
`await connection.getBalance(pubkey)` (lamports; divide by 1e9).

**Native SOL:** you do not need to pre-wrap SOL. The SDKs' transaction builders handle
wSOL for you — DBC and DLMM swaps wrap/unwrap inline (DLMM exposes `skipUnwrapSOL` /
`skipSolWrappingOperation` opt-outs), and CP-AMM creates the needed ATAs idempotently
(1.3.4+). If a simulation fails on a missing token account, read the logs — it's usually
the *output* token's ATA on a non-SOL leg, which the builders also create when needed.

## Priority fees & compute

- Studio: `computeUnitPriceMicroLamports` in every config (default template: `100000`).
- SDK: prepend compute-budget instructions:

```ts
import { ComputeBudgetProgram } from '@solana/web3.js'
tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }))
```

Some SDK builders already estimate CU (helpers like `getEstimatedComputeUnitIxWithBuffer`
exist in DLMM/CP-AMM); adding a unit *price* is still your job.

## Sign & send pattern (web3.js v1)

```ts
import { sendAndConfirmTransaction } from '@solana/web3.js'

const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
tx.recentBlockhash = blockhash
tx.feePayer = wallet.publicKey
const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
```

- **Check the return shape** before assuming one tx + one signer:
  `Transaction[]` (DLMM removes/claims, DAMM v1 pool creation) → send sequentially;
  `{ transaction, ...keypairs }` (DBC `migrateToDammV2`) and generated account keypairs
  (DBC config, DLMM position, CP-AMM position NFT) → **extra signers**.
- Simulate before sending real value: set blockhash + feePayer, **sign first**, then
  `await connection.simulateTransaction(tx)` and read the program logs
  (`scripts/lib/common.ts` shows the exact order).
- **Verify before signing** any transaction you didn't assemble instruction-by-instruction
  (SDK builders, and especially anything returned by a remote API): check it pays/sends
  what the owner approved — expected program IDs, destination/receiver, mint, and exact
  amount — and throw rather than sign on any mismatch.
- Expired blockhash / timeout → refetch blockhash, rebuild, resend; raise priority fee.

## Browser / wallet-adapter signing (frontends)

In a browser there is no `Keypair` — the user's wallet signs. Standard packages:
`@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`,
`@solana/wallet-adapter-base` (+ `@solana/wallet-adapter-wallets`). Pattern:

```tsx
import { useConnection, useWallet } from '@solana/wallet-adapter-react'

const { connection } = useConnection()
const { publicKey, sendTransaction } = useWallet()

// build tx with an SDK exactly as in the reference packs, using publicKey as owner/payer
tx.feePayer = publicKey!
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
const sig = await sendTransaction(tx, connection)   // wallet signs + sends
await connection.confirmTransaction(sig, 'confirmed')
```

Multi-signer builders (position NFT keypairs, DBC config keypairs) still work: call
`tx.partialSign(extraKeypair)` before `sendTransaction`. Keep the RPC URL server-side where
possible (Next.js API route proxy); a `NEXT_PUBLIC_` RPC var is visible to everyone.
web3.js v1 in browser bundles may need Buffer polyfills depending on the bundler.

## Amount units

- Studio JSONC configs: **human token units** (e.g. `"migrationQuoteThreshold": 10` = 10 SOL).
- SDKs: **`BN` base units (lamports)** — `new BN(amount * 10 ** decimals)` (use `Decimal`
  for non-integer math; avoid JS float precision on large amounts).
- Always restate the amount and unit to the owner before executing a write.

## Explorer verification

- Tx: `https://solscan.io/tx/<SIG>` · account: `https://solscan.io/account/<ADDR>`
  (append `?cluster=devnet` on devnet). Meteora UI: `https://app.meteora.ag`.
- Explorer links are for the human owner — they block non-browser fetchers. Verify
  programmatically with `connection.confirmTransaction(sig)` / `getTransaction(sig)`
  and by re-reading the affected accounts.
