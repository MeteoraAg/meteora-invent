import { Cluster, Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { ActivationTypeConfig, DammV1Config } from '../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import {
  getAmountInLamports,
  getQuoteDecimals,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../helpers';
import { getMint } from '@solana/spl-token';
import {
  ActivationType,
  CustomizableParams,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/types';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import BN from 'bn.js';
import {
  createProgram,
  deriveCustomizablePermissionlessConstantProductPoolAddress,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../utils/constants';

export function getDynamicAmmActivationType(activationType: ActivationTypeConfig): ActivationType {
  if (activationType == ActivationTypeConfig.Slot) {
    return ActivationType.Slot;
  } else if (activationType == ActivationTypeConfig.Timestamp) {
    return ActivationType.Timestamp;
  } else {
    throw new Error(`Unsupported Dynamic AMM activation type: ${activationType}`);
  }
}

export async function createPermissionlessDammV1Pool(
  config: DammV1Config,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  opts?: {
    cluster?: Cluster;
    programId?: PublicKey;
  }
) {
  if (!config) {
    throw new Error('Missing dynamic amm configuration');
  }
  console.log('\n> Initializing Permissionless Dynamic AMM pool...');

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
  const baseMintAccount = await getMint(connection, baseMint, connection.commitment);
  const baseDecimals = baseMintAccount.decimals;

  const baseAmount = getAmountInLamports(config.dynamicAmm.baseAmount, baseDecimals);
  const quoteAmount = getAmountInLamports(config.dynamicAmm.quoteAmount, quoteDecimals);

  console.log(
    `- Using token A amount ${config.dynamicAmm.baseAmount}, in lamports = ${baseAmount}`
  );
  console.log(
    `- Using token B amount ${config.dynamicAmm.quoteAmount}, in lamports = ${quoteAmount}`
  );

  const activationType = getDynamicAmmActivationType(config.dynamicAmm.activationType);

  const customizeParam: CustomizableParams = {
    tradeFeeNumerator: config.dynamicAmm.tradeFeeNumerator,
    activationType: activationType,
    activationPoint: config.dynamicAmm.activationPoint
      ? new BN(config.dynamicAmm.activationPoint)
      : null,
    hasAlphaVault: config.dynamicAmm.hasAlphaVault,
    padding: Array(90).fill(0),
  };
  console.log(`- Using tradeFeeNumerator = ${customizeParam.tradeFeeNumerator}`);
  console.log(`- Using activationType = ${config.dynamicAmm.activationType}`);
  console.log(`- Using activationPoint = ${customizeParam.activationPoint}`);
  console.log(`- Using hasAlphaVault = ${customizeParam.hasAlphaVault}`);

  const initPoolTx = await AmmImpl.createCustomizablePermissionlessConstantProductPool(
    connection as any,
    wallet.publicKey,
    baseMint,
    quoteMint,
    baseAmount,
    quoteAmount,
    customizeParam,
    {
      cluster: opts?.cluster,
      programId: opts?.programId.toString(),
    }
  );
  modifyComputeUnitPriceIx(initPoolTx as any, config.computeUnitPriceMicroLamports);
  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection as any).ammProgram.programId
  );

  console.log(`\n> Pool address: ${poolKey}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    // @ts-expect-error: Keypair version difference
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initPoolTx]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(
      connection,
      initPoolTx as any,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}
