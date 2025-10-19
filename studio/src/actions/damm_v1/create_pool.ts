import { Connection, PublicKey } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  createTokenMint,
  getDammV1Config,
  parseCliArguments,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import { createDammV1Pool } from '../../lib/damm_v1';
import { AlphaVaultConfig } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { createAlphaVault } from '../../lib/alpha_vault';
import {
  createProgram,
  deriveCustomizablePermissionlessConstantProductPoolAddress,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils';

async function main() {
  const config = await getDammV1Config();

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

  if (config) {
    await createDammV1Pool(config, connection, wallet, baseMint, quoteMint);

    if (config.dammV1Config?.hasAlphaVault && config.alphaVault) {
      console.log('\n> Alpha vault is enabled, creating alpha vault...');

      const poolAddress = deriveCustomizablePermissionlessConstantProductPoolAddress(
        baseMint,
        quoteMint,
        createProgram(connection as any).ammProgram.programId
      );

      const alphaVaultConfig: AlphaVaultConfig = {
        ...config,
        quoteMint: quoteMint.toString(),
      };

      await createAlphaVault(connection, wallet, alphaVaultConfig, poolAddress, baseMint);

      console.log('\n>>> DAMM V1 pool and alpha vault created successfully! 🎉');
    }
  } else {
    throw new Error('Must provide DAMM V1 configuration');
  }
}

main();
