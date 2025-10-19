import {
  Cluster,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { DammV1Config, LockLiquidityAllocation } from '../../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import {
  fromAllocationsToAmount,
  getAmountInLamports,
  getQuoteDecimals,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { getMint } from '@solana/spl-token';
import { CustomizableParams } from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/types';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import BN from 'bn.js';
import {
  createProgram,
  deriveCustomizablePermissionlessConstantProductPoolAddress,
  getAssociatedTokenAccount,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils';
import { SEEDS } from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/constants';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

/**
 * Create a DammV1 pool permissionlessly
 * @param config - The configuration for the pool
 * @param connection - The connection to the cluster
 * @param wallet - The wallet to use for the transaction
 * @param baseMint - The mint for the base token
 * @param quoteMint - The mint for the quote token
 * @param opts - The options for the pool
 * @returns The pool address
 */
export async function createDammV1Pool(
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

  if (!config.quoteMint) {
    throw new Error('Quote mint is required');
  }
  if (!config.dammV1Config) {
    throw new Error('DAMM V1 configuration is required');
  }

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
  const baseMintAccount = await getMint(connection, baseMint, connection.commitment);
  const baseDecimals = baseMintAccount.decimals;

  const baseAmount = getAmountInLamports(config.dammV1Config.baseAmount, baseDecimals);
  const quoteAmount = getAmountInLamports(config.dammV1Config.quoteAmount, quoteDecimals);

  console.log(
    `- Using token A amount ${config.dammV1Config.baseAmount}, in lamports = ${baseAmount}`
  );
  console.log(
    `- Using token B amount ${config.dammV1Config.quoteAmount}, in lamports = ${quoteAmount}`
  );

  const customizeParam: CustomizableParams = {
    tradeFeeNumerator: config.dammV1Config.tradeFeeNumerator,
    activationType: config.dammV1Config.activationType,
    activationPoint: config.dammV1Config.activationPoint
      ? new BN(config.dammV1Config.activationPoint)
      : null,
    hasAlphaVault: config.dammV1Config.hasAlphaVault,
    padding: Array(90).fill(0),
  };

  console.log(`- Using tradeFeeNumerator = ${customizeParam.tradeFeeNumerator}`);
  console.log(`- Using activationType = ${config.dammV1Config.activationType}`);
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
      programId: opts?.programId?.toString(),
    }
  );
  modifyComputeUnitPriceIx(initPoolTx as any, config.computeUnitPriceMicroLamports ?? 0);
  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection as any).ammProgram.programId
  );

  console.log(`\n> Pool address: ${poolKey}`);

  if (config.dryRun) {
    console.log(`> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initPoolTx as any]);
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

/**
 * Lock liquidity for a DammV1 pool
 * @param connection - The connection to the cluster
 * @param payer - The payer for the transaction
 * @param baseMint - The mint for the base token
 * @param quoteMint - The mint for the quote token
 * @param allocations - The allocations for the liquidity
 * @param dryRun - Whether to simulate the transaction
 * @param computeUnitPriceMicroLamports - The compute unit price for the transaction
 * @returns The pool address
 */
export async function lockLiquidity(
  connection: Connection,
  payer: Keypair,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  allocations: LockLiquidityAllocation[],
  dryRun: boolean,
  computeUnitPriceMicroLamports: number
): Promise<void> {
  // Derive pool address
  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection as any).ammProgram.programId
  );
  console.log(`\n> Pool address: ${poolKey}`);

  if (allocations.length === 0) {
    throw new Error('Missing allocations in lockLiquidity configuration');
  }

  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.LP_MINT), poolKey.toBuffer()],
    createProgram(connection as any).ammProgram.programId
  );
  const payerPoolLp = getAssociatedTokenAccount(lpMint, payer.publicKey);
  const payerPoolLpBalance = (
    await connection.getTokenAccountBalance(payerPoolLp, connection.commitment)
  ).value.amount;
  console.log('> payerPoolLpBalance %s', payerPoolLpBalance.toString());

  const allocationByAmounts = fromAllocationsToAmount(new BN(payerPoolLpBalance), allocations);

  const pool = await AmmImpl.create(connection as any, poolKey);

  for (const allocation of allocationByAmounts) {
    console.log('\n> Lock liquidity %s', allocation.address.toString());
    const tx = await pool.lockLiquidity(allocation.address, allocation.amount, payer.publicKey);
    modifyComputeUnitPriceIx(tx as any, computeUnitPriceMicroLamports);

    if (dryRun) {
      console.log(
        `\n> Simulating lock liquidity tx for address ${allocation.address} with amount = ${allocation.amount}... / percentage = ${allocation.percentage}`
      );
      await runSimulateTransaction(connection, [payer], payer.publicKey, [tx as any]);
    } else {
      const txHash = await sendAndConfirmTransaction(connection, tx as any, [payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }).catch((err) => {
        console.error(err);
        throw err;
      });

      console.log(
        `>>> Lock liquidity successfully with tx hash: ${txHash} for address ${allocation.address} with amount ${allocation.amount}`
      );
    }
  }
}
