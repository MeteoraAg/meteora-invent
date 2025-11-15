# Meteora Invent

A toolkit consisting of everything you need to invent innovative token launches on Meteora.

## Metsumi

Meet Metsumi, your personal launch assistant engineered to help you launch anything and do any
action on Meteora programs with just a few configurations and CLI commands.

![Metsumi](./assets/metsumi/metsumi-1.webp)

## 📋 Table of Contents

- [🚀 Getting Started](#-getting-started)
- [📦 Workspaces](#-workspaces)
  - [Studio](#studio-meteora-inventstudio)
  - [Scaffolds](#scaffolds)
- [🏗️ Structure](#%EF%B8%8F-structure)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 10.0.0

### Clone the repository

```bash
git clone https://github.com/MeteoraAg/meteora-invent.git
```

### Installation

```bash
# Install pnpm if you haven't already
npm install -g pnpm

# Install all dependencies
pnpm install
```

## 📦 Workspaces

---

### Studio (`@meteora-invent/studio`)

---

The studio workspace contains all the actions for interacting with Meteora's programs.

#### Setup

1. Copy the `.env.example` file to `.env` and configure the environment variables.

```bash
cp studio/.env.example studio/.env
```

2. (Optional) Start a Local Test Validator

_You can also run the studio actions on localnet - http://localhost:8899 with the following command_

```bash
pnpm studio start-test-validator
```

3. Generate a keypair from your private key:

```bash
pnpm studio generate-keypair

# For devnet (airdrops 5 SOL)
pnpm studio generate-keypair --network devnet --airdrop

# For localnet (airdrops 5 SOL)
# Ensure that you have already started the local validator with pnpm start-test-validator
pnpm studio generate-keypair --network localnet --airdrop
```

4. Configure the config files in the `studio/config` directory.

- Configure [DLMM](./studio/config/dlmm_config.jsonc)
- Configure [DAMM v2](./studio/config/damm_v2_config.jsonc)
- Configure [DAMM v1](./studio/config/damm_v1_config.jsonc)
- Configure [DBC](./studio/config/dbc_config.jsonc)
- Configure [Alpha Vault](./studio/config/alpha_vault_config.jsonc)

**Note:** You can use the provided example configurations as a starting point. Make sure to replace
the placeholders with your actual values.

5. (Optional) Airdrop SOL to your generated keypair if you need SOL to test on devnet or localnet:

```bash
# Airdrop 5 SOL on devnet
pnpm studio airdrop-sol --network devnet

# Airdrop 5 SOL on localnet
# Ensure that you have already started the local validator with pnpm start-test-validator
pnpm studio airdrop-sol --network localnet
```

---

#### DLMM Actions

##### Create a Customizable Permissionless DLMM Pool

Configure `dlmmConfig` in `dlmm_config.jsonc` file and run the following command to create the DLMM
pool.

_If you don't have a base mint, you can configure `createBaseToken` in the config file and run the
following command._

```bash
pnpm studio dlmm-create-pool
```

_If you already have a base mint created, you can provide it via the CLI with a `--baseMint` flag
and run the following command._

```bash
pnpm studio dlmm-create-pool --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Seed Liquidity (LFG)

Configure `lfgSeedLiquidity` in `dlmm_config.jsonc` file and run the following command to seed the
liquidity in the already deployed DLMM pool.

**Note:** You need to ensure that the deployed DLMM pool is not trading yet.

```bash
pnpm studio dlmm-seed-liquidity-lfg --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Seed Liquidity (Single Bin)

Configure `singleBinSeedLiquidity` in `dlmm_config.jsonc` file and run the following command to seed
the liquidity in a single bin in the already deployed DLMM pool.

**Note:** You need to ensure that the deployed DLMM pool is not trading yet.

```bash
pnpm studio dlmm-seed-liquidity-single-bin --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Set DLMM Pool Status

Configure `setDlmmPoolStatus` in `dlmm_config.jsonc` file and run the following command to set the
trading status of the DLMM pool. This command is used by the operator of the pool to either enable
or disable trading for the DLMM pool.

```bash
pnpm studio dlmm-set-pool-status --poolAddress <YOUR_POOL_ADDRESS>
```

---

#### DAMM v2 Actions

##### Create a Balanced Constant Product Pool

Configure `dammV2Config` in `damm_v2_config.jsonc` file and run the following command to create the
DAMM v2 pool.

_If you don't have a base mint, you can configure `createBaseToken` in the config file and run the
following command._

```bash
pnpm studio damm-v2-create-balanced-pool
```

_If you already have a base mint, you can provide it via the CLI with a `--baseMint` flag and run
the following command._

```bash
pnpm studio damm-v2-create-balanced-pool --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Create a One-Sided Pool

Configure `dammV2Config` in `damm_v2_config.jsonc` file and run the following command to create the
DAMM v2 one-sided pool.

_If you don't have a base mint, you can configure `createBaseToken` in the config file and run the
following command._

```bash
pnpm studio damm-v2-create-one-sided-pool
```

_If you already have a base mint, you can provide it via the CLI with a `--baseMint` flag and run
the following command._

```bash
pnpm studio damm-v2-create-one-sided-pool --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Split Position

Configure `splitPosition` in `damm_v2_config.jsonc` file and run the following command to split an
existing position in the already deployed DAMM v2 pool.

```bash
pnpm studio damm-v2-split-position --poolAddress <YOUR_POOL_ADDRESS>
```

##### Claim Position Fee

If you already have an existing position in a DAMM v2 pool with unclaimed fees, you can run the
following command to claim the fees.

```bash
pnpm studio damm-v2-claim-position-fee --poolAddress <YOUR_POOL_ADDRESS>
```

##### Add Liquidity

Configure `addLiquidity` in `damm_v2_config.jsonc` file and run the following command to add
liquidity to an existing position in the already deployed DAMM v2 pool.

```bash
pnpm studio damm-v2-add-liquidity --poolAddress <YOUR_POOL_ADDRESS>
```

##### Remove Liquidity

If you already have an existing position in a DAMM v2 pool with liquidity, you can run the following
command to remove the liquidity and close the position.

```bash
pnpm studio damm-v2-remove-liquidity --poolAddress <YOUR_POOL_ADDRESS>
```

##### Close Position

If you already have an existing position in a DAMM v2 pool without liquidity, you can run the
following command to close the position.

```bash
pnpm studio damm-v2-close-position --poolAddress <YOUR_POOL_ADDRESS>
```

---

#### DAMM v1 Actions

##### Create a Constant Product Pool

Configure `dammV1Config` in `damm_v1_config.jsonc` file and run the following command to create the
DAMM v1 pool.

_If you don't have a base mint, you can configure `createBaseToken` in the config file and run the
following command._

```bash
pnpm studio damm-v1-create-pool
```

_If you already have a base mint created, you can provide it via the CLI with a `--baseMint` flag
and run the following command._

```bash
pnpm studio damm-v1-create-pool --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Lock Liquidity

Configure `dammV1LockLiquidity` in `damm_v1_config.jsonc` file and run the following command to lock
the liquidity in the already deployed DAMM v1 pool.

```bash
pnpm studio damm-v1-lock-liquidity --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Create a Stake2Earn Farm

Configure `stake2EarnFarm` in `damm_v1_config.jsonc` file and run the following command to create
the Stake2Earn farm on top of the already deployed DAMM v1 pool.

```bash
pnpm studio damm-v1-create-stake2earn-farm --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Lock Liquidity (Stake2Earn)

Configure `dammV1LockLiquidity` in `damm_v1_config.jsonc` file and run the following command to lock
the liquidity in the already deployed DAMM v1 pool with the Stake2Earn farm.

```bash
pnpm studio damm-v1-lock-liquidity-stake2earn --baseMint <YOUR_BASE_MINT_ADDRESS>
```

---

#### DBC Actions

##### Create a DBC Config

Configure `dbcConfig` in `dbc_config.jsonc` file and run the following command to create the DBC
config key. This config key is used to create the DBC pool and contains all the settings for the
pre-graduation and post-graduation pools.

```bash
pnpm studio dbc-create-config
```

##### Create a DBC Pool

Configure `dbcPool` in `dbc_config.jsonc` file and run the following command to create the DBC pool.

_If you don't have a DBC config key, you can run the following command and the config key + pool
will be created together._

```bash
pnpm studio dbc-create-pool
```

_If you already have an existing DBC config key, you can provide it via the CLI with a `--config`
flag and run the following command._

```bash
pnpm studio dbc-create-pool --config <YOUR_DBC_CONFIG_KEY>
```

##### Claim Trading Fees

If you already have an existing DBC pool with accumulated fees, you can run the following command
with the `--baseMint` flag to claim the fees.

```bash
pnpm studio dbc-claim-trading-fee --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Migrate to DAMM v1

If you already have an existing DBC pool, with `poolState.quoteReserve` >
`poolConfig.migrationQuoteThreshold` (100% bonding curve progress), you can run the following
command with the `--baseMint` flag to migrate the DBC pool to DAMM v1.

```bash
pnpm studio dbc-migrate-to-damm-v1 --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Migrate to DAMM v2

If you already have an existing DBC pool, with `poolState.quoteReserve` >
`poolConfig.migrationQuoteThreshold` (100% bonding curve progress), you can run the following
command with the `--baseMint` flag to migrate the DBC pool to DAMM v2.

```bash
pnpm studio dbc-migrate-to-damm-v2 --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Swap (Buy/Sell)

Configure `dbcSwap` in `dbc_config.jsonc` file and run the following command to swap in the DBC
pool.

```bash
pnpm studio dbc-swap --baseMint <YOUR_BASE_MINT_ADDRESS>
```

##### Transfer Pool Creator

Configure `dbcTransferPoolCreator` in `dbc_config.jsonc` file and run the following command to
transfer the pool creator of the DBC pool.

```bash
pnpm studio dbc-transfer-pool-creator --baseMint <YOUR_BASE_MINT_ADDRESS>
```

---

#### Alpha Vault Actions

##### Create an Alpha Vault

Configure `alphaVault` in `alpha_vault_config.jsonc` file and run the following command to create
the alpha vault with an existing DAMM v1 or DAMM v2 or DLMM pool.

```bash
pnpm studio alpha-vault-create --baseMint <YOUR_BASE_MINT_ADDRESS>
```

---

#### Presale Vault Actions

##### Create a Presale Vault

Configure `presaleVault` in `presale_vault_config.jsonc` file and run the following command to
create the presale vault for a specific base token.

```bash
pnpm studio presale-vault-create --baseMint <YOUR_BASE_MINT_ADDRESS>
```

---

### Scaffolds

---

#### Fun Launch (`@meteora-invent/scaffold-fun-launch`)

A Next.js application template for creating a launchpad.

#### Getting Started

Copy the `.env.example` file to `.env` and configure the environment variables.

```bash
cp scaffolds/fun-launch/.env.example scaffolds/fun-launch/.env
```

#### Install Dependencies

```bash
pnpm install
```

#### Running the Scaffold

```bash
# Run the fun-launch scaffold in development
pnpm --filter @meteora-invent/scaffold/fun-launch dev

# Build the fun-launch scaffold
pnpm --filter @meteora-invent/scaffold/fun-launch build
```

## 🏗️ Structure

```
meteora-invent/
├── packages/          # Shared packages
│   └── config/
│       ├── eslint/
│       ├── prettier/
│       └── typescript/
├── scaffolds/         # Scaffolds - production-ready frontend application templates
│   └── fun-launch/
└── studio/            # Studio - a collection of actions for you to innovate and create
    ├── config
    │   ├── alpha_vault_config.jsonc
    │   ├── damm_v1_config.jsonc
    │   ├── damm_v2_config.jsonc
    │   ├── dbc_config.jsonc
    │   └── dlmm_config.jsonc
    ├── data
    │   ├── image
    │   │   └── test-token.jpg
    │   ├── kv_proof_example.json
    │   └── whitelist_wallet_example.csv
    ├── LLM.txt
    ├── package.json
    ├── README.md
    ├── src
    │   ├── actions
    │   │   ├── alpha_vault
    │   │   │   └── create_alpha_vault.ts
    │   │   ├── damm_v1
    │   │   │   ├── create_pool.ts
    │   │   │   ├── create_stake2earn_farm.ts
    │   │   │   ├── lock_liquidity_stake2earn.ts
    │   │   │   └── lock_liquidity.ts
    │   │   ├── damm_v2
    │   │   │   ├── add_liquidity.ts
    │   │   │   ├── claim_position_fee.ts
    │   │   │   ├── close_position.ts
    │   │   │   ├── create_balanced_pool.ts
    │   │   │   ├── create_one_sided_pool.ts
    │   │   │   ├── remove_liquidity.ts
    │   │   │   └── split_position.ts
    │   │   ├── dbc
    │   │   │   ├── claim_trading_fee.ts
    │   │   │   ├── create_config.ts
    │   │   │   ├── create_pool.ts
    │   │   │   ├── migrate_damm_v1.ts
    │   │   │   ├── migrate_damm_v2.ts
    │   │   │   ├── swap.ts
    │   │   │   └── transfer_pool_creator.ts
    │   │   ├── dlmm
    │   │   │   ├── create_pool.ts
    │   │   │   ├── seed_liquidity_lfg.ts
    │   │   │   ├── seed_liquidity_single_bin.ts
    │   │   │   └── set_pool_status.ts
    │   │   ├── presale_vault
    │   │   │   └── create_presale_vault.ts
    │   │   └── settings
    │   │       ├── airdrop_sol.ts
    │   │       └── generate_keypair.ts
    │   ├── helpers
    │   │   ├── accounts.ts
    │   │   ├── cli.ts
    │   │   ├── common.ts
    │   │   ├── config.ts
    │   │   ├── index.ts
    │   │   ├── metadata.ts
    │   │   ├── token.ts
    │   │   ├── transaction.ts
    │   │   ├── utils.ts
    │   │   └── validation.ts
    │   ├── lib
    │   │   ├── alpha_vault
    │   │   │   ├── merkle_tree
    │   │   │   │   ├── balance_tree.ts
    │   │   │   │   ├── index.ts
    │   │   │   │   └── merkle_tree.ts
    │   │   │   │   └── metadata.ts
    │   │   │   ├── index.ts
    │   │   │   └── utils.ts
    │   │   ├── damm_v1
    │   │   │   ├── index.ts
    │   │   │   └── stake2earn.ts
    │   │   ├── damm_v2
    │   │   │   └── index.ts
    │   │   ├── dbc
    │   │   │   └── index.ts
    │   │   └── dlmm
    │   │       └── index.ts
    │   ├── tests
    │   │   ├── artifacts
    │   │   │   ├── accounts
    │   │   │   │   └── 3ifhD4Ywaa8aBZAaQSqYgN4Q1kaFArioLU8uumJMaqkE.json
    │   │   │   ├── alpha_vault.so
    │   │   │   ├── cp_amm.so
    │   │   │   ├── dynamic_amm.so
    │   │   │   ├── dynamic_bonding_curve.so
    │   │   │   ├── dynamic_fee_sharing.so
    │   │   │   ├── dynamic_vault.so
    │   │   │   ├── lb_clmm.so
    │   │   │   ├── locker.so
    │   │   │   └── metaplex.so
    │   │   └── keys
    │   │       └── localnet
    │   │           └── admin-bossj3JvwiNK7pvjr149DqdtJxf2gdygbcmEPTkb2F1.json
    │   └── utils
    │       ├── constants.ts
    │       └── types.ts
```

## 🤝 Contributing

1. Create a feature branch
2. Make your changes
3. Run `pnpm format` and `pnpm lint`
4. Submit a pull request

## 📄 License

ISC
