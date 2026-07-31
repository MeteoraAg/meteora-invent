import { PublicKey } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  createTokenMint,
  getDlmmConfig,
  parseCliArguments,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { createPermissionlessDlmmPool } from '../../lib/dlmm';
import { AlphaVaultConfig } from '../../utils/types';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DLMM_PROGRAM_IDS,
  LOCALNET_RPC_URL,
} from '../../utils/constants';
import { deriveCustomizablePermissionlessLbPair } from '@meteora-ag/dlmm';
import { createAlphaVault } from '../../lib/alpha_vault';
import { createCheckedConnection } from '../../helpers/connection';

async function main() {
  const config = await getDlmmConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = await createCheckedConnection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  let baseMint: PublicKey;
  const { baseMint: baseMintKey } = parseCliArguments();
  if (!baseMintKey) {
    if (!config.createBaseToken) {
      throw new Error(
        'Please either provide --baseMint flag in cli or createBaseToken in configuration to do this action'
      );
    }
    baseMint = await createTokenMint(connection, wallet, {
      dryRun: config.dryRun,
      computeUnitPriceMicroLamports: config.computeUnitPriceMicroLamports ?? 0,
      tokenConfig: config.createBaseToken,
    });
  } else {
    baseMint = new PublicKey(baseMintKey);
  }

  if (!config.quoteMint) {
    throw new Error('Missing quoteMint in configuration');
  }
  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  const opts =
    config.rpcUrl === LOCALNET_RPC_URL
      ? {
          cluster: 'localhost' as const,
          programId: new PublicKey(DLMM_PROGRAM_IDS.localhost),
        }
      : undefined;

  if (config.dlmmConfig) {
    await createPermissionlessDlmmPool(config, connection, wallet, baseMint, quoteMint, opts);

    if (config.dlmmConfig.hasAlphaVault && config.alphaVault) {
      console.log('\n> Alpha vault is enabled, creating alpha vault automatically...');

      const dlmmProgramId = opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS['mainnet-beta']);
      const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);

      const alphaVaultConfig: AlphaVaultConfig = {
        ...config,
        quoteMint: quoteMint.toString(),
      };

      await createAlphaVault(connection, wallet, alphaVaultConfig, poolKey, baseMint);

      console.log('\n>>> DLMM pool and alpha vault created successfully! 🎉');
    }
  } else {
    throw new Error('Must provide DLMM configuration');
  }
}

main();
