# Meteora Studio

A collection of actions for interacting with Meteora's programs to innovate and create token
launches. Part of the **Meteora Invent** toolkit.

## 🏗️ Structure

Studio consists of 4 main pool types, each with dedicated actions and configurations:

- **DLMM** (Dynamic Liquidity Market Maker) - Dynamic fees and precise liquidity concentration
- **DAMM V2** (Dynamic AMM V2) - Enhanced constant product AMM with advanced features
- **DAMM V1** (Dynamic AMM V1) - Constant product AMM with lending integration
- **DBC** (Dynamic Bonding Curve) - Permissionless launch pool protocol

Studio also contains a collection of actions for interacting with other Meteora programs:

- **Alpha Vault** - A complementary anti-bot mechanism used together with a Launch Pool.

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 10.0.0

### Installation

From the root of the meteora-invent repository:

```bash
# Install all dependencies
pnpm install
```

### Configuration

1. Copy the `.env.example` file to `.env` and configure the environment variables:

```bash
cp studio/.env.example studio/.env
```

Add your private key and RPC URL to the `.env` file.

2. Optional: Start a Local Test Validator

_You can also run the studio actions on localnet - http://localhost:8899 with the following command_

```bash
pnpm studio start-test-validator
```

3. Generate a keypair from your private key:

```bash
# For devnet (airdrops 5 SOL)
pnpm generate-keypair --network devnet

# For localnet (airdrops 5 SOL)
# Ensure that you have already started the local validator with pnpm start-test-validator
pnpm generate-keypair --network localnet
```

4. Configure the config files in the `studio/config` directory:

- [DLMM Config](./config/dlmm_config.jsonc)
- [DAMM v2 Config](./config/damm_v2_config.jsonc)
- [DAMM v1 Config](./config/damm_v1_config.jsonc)
- [DBC Config](./config/dbc_config.jsonc)
- [Alpha Vault Config](./config/alpha_vault_config.jsonc)

**Note:** You can use the provided example configurations as a starting point. Make sure to replace
the placeholders with your actual values.

## ✅ Setup Checklist

Before running any action, verify each item:

- [ ] **Node.js ≥ 18** installed (`node --version`)
- [ ] **pnpm ≥ 10** installed (`pnpm --version`)
- [ ] Dependencies installed (`pnpm install` from repo root)
- [ ] `.env` file created from `.env.example` with your `PRIVATE_KEY`
- [ ] `keypair.json` generated (`pnpm generate-keypair --network devnet`)
- [ ] Config file updated — replaced ALL placeholder values:
  - `YOUR_FEE_CLAIMER_ADDRESS` → valid Solana address
  - `YOUR_LEFTOVER_RECEIVER_ADDRESS` → valid Solana address
  - `YOUR_CREATOR_ADDRESS` → valid Solana address
  - `TOKEN_NAME`, `TOKEN_SYMBOL`, `TOKEN_DESCRIPTION` → your token info
- [ ] `"dryRun": true` in config (default) — change to `false` only when ready to go live
- [ ] Sufficient SOL balance for fees (`solana balance --url devnet`)

## 🧪 Sample Devnet Addresses for Testing

> ⚠️ **These are for devnet testing only.** Do NOT use on mainnet.

When testing on devnet, you need valid Solana addresses for placeholder fields. You can use any
valid devnet wallet you control, or these well-known addresses:

| Field              | Purpose                                 | Sample Devnet Address      |
| ------------------ | --------------------------------------- | -------------------------- |
| `feeClaimer`       | Receives partner trading fees           | Use your own devnet wallet |
| `leftoverReceiver` | Receives leftover tokens post-migration | Use your own devnet wallet |
| `creator`          | Pool creator identity                   | Use your own devnet wallet |

**Quick way to get a test address:**

```bash
# Generate a new keypair for testing
solana-keygen new --no-bip39-passphrase --outfile /tmp/test-wallet.json
solana address --keypair /tmp/test-wallet.json
```

Use the printed address in your config fields.

**Well-known safe addresses (devnet):**

- Solana System Program: `11111111111111111111111111111111`
- SOL (Wrapped): `So11111111111111111111111111111111111111112`
- USDC (devnet): `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

## 🔧 Troubleshooting

### "Non-base58 character" Error

This error means one of your config fields contains an invalid Solana address — usually an
un-replaced placeholder like `YOUR_FEE_CLAIMER_ADDRESS`.

**How to fix:**

1. Open the relevant config file (e.g. `config/dbc_config.jsonc`)
2. Search for values starting with `YOUR_`, `TOKEN_`, or `PLACEHOLDER`
3. Replace each with a valid 32-byte base58 Solana address

Fields that commonly need updating in `dbc_config.jsonc`:

- `dbcConfig.feeClaimer` — replace `YOUR_FEE_CLAIMER_ADDRESS`
- `dbcConfig.leftoverReceiver` — replace `YOUR_LEFTOVER_RECEIVER_ADDRESS`
- `dbcPool.creator` — replace `YOUR_CREATOR_ADDRESS`

### "Failed to connect to RPC endpoint" Error

1. Check your `rpcUrl` in the config file is correct
2. For localnet: start the validator first with `pnpm studio start-test-validator`
3. For devnet/mainnet: verify you have internet connectivity
4. Consider using a dedicated RPC provider instead of the public endpoint (rate limiting)

### Wallet / Keypair Issues

- If `keypair.json` is missing: run `pnpm generate-keypair --network devnet`
- If your wallet has no SOL: run `pnpm studio airdrop-sol --network devnet`
- For localnet: `pnpm studio airdrop-sol --network localnet`

### Dry-Run Mode

All config files default to `"dryRun": true` — transactions are simulated, not sent on-chain. This
is intentional for safety. When your simulation passes, set `"dryRun": false` to go live.

## 📋 Available Actions

### DLMM Actions

**Create a Customizable Permissionless DLMM Pool**

```bash
pnpm dlmm-create-pool --config ./config/dlmm_config.jsonc
```

**Seed Liquidity (LFG)**

```bash
pnpm dlmm-seed-liquidity-lfg --config ./config/dlmm_config.jsonc
```

**Seed Liquidity (Single Bin)**

```bash
pnpm dlmm-seed-liquidity-single-bin --config ./config/dlmm_config.jsonc
```

**Set DLMM Pool Status**

```bash
pnpm dlmm-set-pool-status --config ./config/dlmm_config.jsonc
```

**Place a Limit Order**

```bash
pnpm dlmm-place-limit-order --poolAddress <POOL_ADDRESS>
```

**List Open Limit Orders**

```bash
pnpm dlmm-get-limit-orders --poolAddress <POOL_ADDRESS>
```

**Cancel a Limit Order**

```bash
pnpm dlmm-cancel-limit-order --poolAddress <POOL_ADDRESS> --limitOrder <LIMIT_ORDER_ADDRESS>
```

### DAMM v2 Actions

**Create a Balanced Constant Product Pool**

```bash
pnpm damm-v2-create-balanced-pool --config ./config/damm_v2_config.jsonc
```

**Create a One-Sided Pool**

```bash
pnpm damm-v2-create-one-sided-pool --config ./config/damm_v2_config.jsonc
```

**Split Position**

```bash
pnpm damm-v2-split-position --config ./config/damm_v2_config.jsonc
```

**Claim Position Fee**

```bash
pnpm damm-v2-claim-position-fee --config ./config/damm_v2_config.jsonc
```

**Add Liquidity**

```bash
pnpm damm-v2-add-liquidity --config ./config/damm_v2_config.jsonc
```

**Remove Liquidity**

```bash
pnpm damm-v2-remove-liquidity --config ./config/damm_v2_config.jsonc
```

**Close Position**

```bash
pnpm damm-v2-close-position --config ./config/damm_v2_config.jsonc
```

### DAMM v1 Actions

**Create a Constant Product Pool**

```bash
pnpm damm-v1-create-pool --config ./config/damm_v1_config.jsonc
```

**Lock Liquidity**

```bash
pnpm damm-v1-lock-liquidity --config ./config/damm_v1_config.jsonc
```

**Create a Stake2Earn Farm**

```bash
pnpm damm-v1-create-stake2earn-farm --config ./config/damm_v1_config.jsonc
```

**Lock Liquidity (Stake2Earn)**

```bash
pnpm damm-v1-lock-liquidity-stake2earn --config ./config/damm_v1_config.jsonc
```

### DBC Actions

**Create a DBC Config**

```bash
pnpm dbc-create-config --config ./config/dbc_config.jsonc
```

**Create a DBC Pool**

```bash
pnpm dbc-create-pool --config ./config/dbc_config.jsonc
```

**Claim Trading Fees**

```bash
pnpm dbc-claim-trading-fee --config ./config/dbc_config.jsonc
```

**Migrate to DAMM v1**

```bash
pnpm dbc-migrate-to-damm-v1 --config ./config/dbc_config.jsonc
```

**Migrate to DAMM v2**

```bash
pnpm dbc-migrate-to-damm-v2 --config ./config/dbc_config.jsonc
```

**Swap (Buy/Sell)**

```bash
pnpm dbc-swap --config ./config/dbc_config.jsonc
```

### Alpha Vault Actions

**Create an Alpha Vault**

```bash
pnpm alpha-vault-create --config ./config/alpha_vault_config.jsonc
```

## 📖 Program Details

### Dynamic Bonding Curve (DBC)

The Dynamic Bonding Curve (DBC) program is a permissionless launch pool protocol that allows any
launch partners to enable their users to launch tokens with customizable virtual curves directly on
their platform (e.g. launchpad). This allows their users to create a new token and create a Dynamic
Bonding Curve pool where anyone can buy tokens based on that bonding curve.

### Dynamic AMM V1 (DAMM V1)

Constant product AMM that supports token prices from 0 to infinity. LPs can earn additional yield by
utilizing lending sources alongside traditional swap fees, enhancing their returns.

### Dynamic AMM V2 (DAMM V2)

Dynamic AMM v2 is a constant-product AMM program, with features that optimize transaction fees and
provide greater flexibility for liquidity providers, launchpads, and token launches. DAMM v2 comes
with SPL and Token 2022 token support, optional concentrated liquidity, position NFT, dynamic fee,
on-chain fee scheduler, new fee claiming mechanism and fee token selection, more flexible liquidity
locks, and an in-built farming mechanism. Unlike DAMM v1, DAMM v2 is not integrated with Dynamic
Vaults. DAMM v2 is a new program, and not an upgrade of the Dynamic AMM v1 program.

### Dynamic Liquidity Market Maker (DLMM)

DLMM (Dynamic Liquidity Market Maker) gives LPs access to dynamic fees to capitalize on volatility,
and precise liquidity concentration all in real-time, with the flexibility to select their preferred
volatility strategy.

### Alpha Vault

Alpha Vault is a complementary anti-bot mechanism used together with a Launch Pool that provides
early access for genuine supporters to deposit and purchase tokens before the pool starts trading,
thereby getting tokens at the earliest price and helping to safeguard the token launch against
sniper bots.

### Presale Vault

Presale Vault is a permissionless presale vault that allows anyone to create and participate in a
presale for a specific base token. It supports various presale types, including FCFS, Prorata, Fixed
Price with either a Permissioned or Permissionless setup.

## 🤝 Contributing

For contributing guidelines, please refer to the main [CONTRIBUTING.md](../CONTRIBUTING.md) file in
the root repository.

## 📄 License

This project is licensed under the ISC License - see the [LICENSE.md](../LICENSE.md) file for
details.
