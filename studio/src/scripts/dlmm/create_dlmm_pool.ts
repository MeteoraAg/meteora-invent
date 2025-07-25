import { Connection, PublicKey } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  parseConfigFromCli,
  createTokenMint,
  getQuoteDecimals,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { createPermissionlessDlmmPool } from '../../lib/dlmm';
import {
  DlmmConfig,
  AlphaVaultTypeConfig,
  FcfsAlphaVaultConfig,
  ProrataAlphaVaultConfig,
} from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL, DLMM_PROGRAM_IDS } from '../../utils/constants';
import { deriveCustomizablePermissionlessLbPair } from '@meteora-ag/dlmm';
import {
  createFcfsAlphaVault,
  createProrataAlphaVault,
  toAlphaVaulSdkPoolType,
} from '../../lib/alpha_vault';

async function main() {
  const config: DlmmConfig = (await parseConfigFromCli()) as DlmmConfig;

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  let baseMint: PublicKey;
  const quoteMint = new PublicKey(config.quoteMint);

  // If we want to create a new token mint
  if (config.createBaseToken) {
    baseMint = await createTokenMint(connection, wallet, {
      dryRun: config.dryRun,
      mintTokenAmount: config.createBaseToken.mintBaseTokenAmount,
      decimals: config.createBaseToken.baseDecimals,
      computeUnitPriceMicroLamports: config.computeUnitPriceMicroLamports,
    });
  } else {
    if (!config.baseMint) {
      throw new Error('Missing baseMint in configuration');
    }
    baseMint = new PublicKey(config.baseMint);
  }

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  /// --------------------------------------------------------------------------
  if (config.dlmm) {
    // Create the DLMM pool first
    await createPermissionlessDlmmPool(config, connection, wallet, baseMint, quoteMint);

    // If alpha vault is enabled and config is provided, create the alpha vault automatically
    if (config.dlmm.hasAlphaVault && config.alphaVault) {
      console.log('\n> Alpha vault is enabled, creating alpha vault automatically...');

      // Derive the pool address
      const cluster = 'devnet'; // You can make this configurable if needed
      const dlmmProgramId = new PublicKey(
        DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]
      );
      const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);

      const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
      const poolType = toAlphaVaulSdkPoolType(config.alphaVault.poolType);

      // Create the appropriate type of alpha vault
      if (config.alphaVault.alphaVaultType === AlphaVaultTypeConfig.Fcfs) {
        await createFcfsAlphaVault(
          connection,
          wallet,
          poolType,
          poolKey,
          baseMint,
          quoteMint,
          quoteDecimals,
          config.alphaVault as FcfsAlphaVaultConfig,
          config.dryRun,
          config.computeUnitPriceMicroLamports
        );
      } else if (config.alphaVault.alphaVaultType === AlphaVaultTypeConfig.Prorata) {
        await createProrataAlphaVault(
          connection,
          wallet,
          poolType,
          poolKey,
          baseMint,
          quoteMint,
          quoteDecimals,
          config.alphaVault as ProrataAlphaVaultConfig,
          config.dryRun,
          config.computeUnitPriceMicroLamports
        );
      } else {
        throw new Error(`Unsupported alpha vault type: ${config.alphaVault.alphaVaultType}`);
      }

      console.log('\n>>> DLMM pool and alpha vault created successfully! 🎉');
    }
  } else {
    throw new Error('Must provide DLMM configuration');
  }
}

main();
