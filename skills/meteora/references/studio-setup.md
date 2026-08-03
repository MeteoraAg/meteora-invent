# Studio CLI — Setup Guide (ACT path)

## Install the Toolkit

The studio ships inside the meteora-invent monorepo. If you are already working inside a
meteora-invent checkout, skip the clone and just install:

```bash
# Clone the official repo (skip if already inside it)
git clone https://github.com/MeteoraAg/meteora-invent
cd meteora-invent

# Install dependencies
pnpm install
```

**Requirements:** Node.js >= 22.12 and pnpm >= 10 — the repo sets `engine-strict`, so
older Node versions fail at `pnpm install`.

## Configure Environment

RPC endpoint, keypair path, and dry-run mode all live in the protocol config files
(`studio/config/*.jsonc`), not in `.env`:

```jsonc
{
  "rpcUrl": "https://api.devnet.solana.com",
  "dryRun": true,
  "keypairFilePath": "./keypair.json",
  "computeUnitPriceMicroLamports": 100000
}
```

**RPC options:**
- Public mainnet: `https://api.mainnet-beta.solana.com`
- Public devnet: `https://api.devnet.solana.com`
- Premium (recommended): [Helius](https://www.helius.dev/), QuickNode, Triton

**Optional:** `JUPITER_API_KEY` (and `JUPITER_API_URL`) in `studio/.env` — only needed to raise the rate limit on `zap-in-dlmm`'s live Jupiter quotes; every other action ignores them.

## Get a Wallet

The studio signs with `studio/keypair.json`, produced by `generate-keypair` from a
`PRIVATE_KEY` (base58) in `studio/.env`. **`generate-keypair` requires that env var — it
converts keys, it does not create them.**

```bash
# Existing wallet: put its base58 private key in studio/.env
cp -n studio/.env.example studio/.env    # then set PRIVATE_KEY=... in it

# New wallet: create one without echoing the secret, appended straight into .env
cd studio && node -e "const {Keypair}=require('@solana/web3.js');const _b=require('bs58');const bs58=_b.default??_b;const fs=require('fs');const k=Keypair.generate();const env=fs.existsSync('.env')?fs.readFileSync('.env','utf8').split('\n').filter(l=>!l.startsWith('PRIVATE_KEY=')).join('\n').replace(/\n*$/,'\n'):'';fs.writeFileSync('.env',env+'PRIVATE_KEY='+bs58.encode(k.secretKey)+'\n');console.log('New wallet address: '+k.publicKey.toBase58())" && cd ..

# Convert to studio/keypair.json (+ optional devnet airdrop of 5 SOL)
pnpm studio generate-keypair --network devnet --airdrop
```

## Local Testing (Optional)

```bash
# Start a local validator
pnpm studio start-test-validator

# Airdrop on localnet
pnpm studio airdrop-sol --network localnet   # fixed 5 SOL per call; no --amount flag
```

The validator now preloads **all** Meteora programs — DLMM, DAMM v1, DAMM v2, DBC, Alpha
Vault, Dynamic Vault, Met Lock, and Dynamic Fee Sharing, plus **Presale**, **Stake2Earn
(M3M3)**, **Zap**, and **Pool Farms** — so every product's golden path is testable on
localnet without faucets.

Maintainers: `studio/src/tests/e2e-helper-smoke.sh` runs an automated, idempotent smoke test
of the Met Lock and Dynamic Fee Sharing golden paths end-to-end against this validator
(throwaway wallet + mint, dry-run then real send, PASS/FAIL per step) without touching any
existing `studio/.env` / `keypair.json` / config — see the script's header comment for exact
scope and why the other families aren't included.

## Verify Setup

```bash
# 1. Keypair exists and airdrop works (devnet)
pnpm studio airdrop-sol --network devnet

# 2. Optional end-to-end validation: fill studio/config/dbc_config.jsonc with real
#    values (placeholders like YOUR_FEE_CLAIMER_ADDRESS are not valid pubkeys and will
#    fail validation — that's expected until you set them), keep "dryRun": true, then:
pnpm studio dbc-create-config
```
