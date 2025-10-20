import { Connection, PublicKey } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { AlphaVaultConfig } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import {
  createTokenMint,
  getDammV2Config,
  parseCliArguments,
  safeParseKeypairFromFile,
} from '../../helpers';
import { createDammV2BalancedPool } from '../../lib/damm_v2';
import { createAlphaVault } from '../../lib/alpha_vault';
import { deriveCustomizablePoolAddress } from '@meteora-ag/cp-amm-sdk';

async function main() {
  const config = await getDammV2Config();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
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

  if (config.dammV2Config) {
    await createDammV2BalancedPool(config, connection, wallet, baseMint, quoteMint);

    if (config.dammV2Config.hasAlphaVault && config.alphaVault) {
      console.log('\n> Alpha vault is enabled, creating alpha vault automatically...');

      const poolAddress = deriveCustomizablePoolAddress(baseMint, quoteMint);

      const alphaVaultConfig: AlphaVaultConfig = {
        ...config,
        quoteMint: quoteMint.toString(),
      };

      await createAlphaVault(connection, wallet, alphaVaultConfig, poolAddress, baseMint);

      console.log('\n>>> DAMM V2 pool and alpha vault created successfully! 🎉');
    }
  } else {
    throw new Error('Must provide Dynamic V2 configuration');
  }
}

main();
