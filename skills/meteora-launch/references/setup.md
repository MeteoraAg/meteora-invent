# Meteora Invent — Setup Guide

## Install the Toolkit

```bash
# Clone the official repo
git clone https://github.com/MeteoraAg/meteora-invent
cd meteora-invent

# Install dependencies
pnpm install
```

**Requirements:** Node.js >= 18, pnpm >= 10

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

## Get a Wallet

```bash
# Generate a fresh keypair (writes keypair.json)
pnpm studio generate-keypair

# On devnet — generate + airdrop 5 SOL
pnpm studio generate-keypair --network devnet --airdrop
```

To import an existing wallet instead: `cp studio/.env.example studio/.env`, set
`PRIVATE_KEY` (base58 or JSON byte array) in `studio/.env`, then run
`pnpm studio generate-keypair` — it converts the key into `keypair.json`.

## Local Testing (Optional)

```bash
# Start a local validator
pnpm studio start-test-validator

# Airdrop on localnet
pnpm studio airdrop-sol --network localnet --amount 10
```

## Verify Setup

```bash
# Dry-run a DBC config create (no cost, just validates)
# Set "dryRun": true in your config file first
pnpm studio dbc-create-config
```
