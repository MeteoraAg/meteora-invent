import {
  Cluster,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import { ActivationTypeConfig, DlmmConfig } from '../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import DLMM, { ActivationType, deriveCustomizablePermissionlessLbPair } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import {
  getQuoteDecimals,
  isPriceRoundingUp,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../helpers';
import { getMint } from '@solana/spl-token';
import { DEFAULT_SEND_TX_MAX_RETRIES, DLMM_PROGRAM_IDS } from '../utils/constants';

export function getDlmmActivationType(activationType: ActivationTypeConfig): ActivationType {
  if (activationType == ActivationTypeConfig.Slot) {
    return ActivationType.Slot;
  } else if (activationType == ActivationTypeConfig.Timestamp) {
    return ActivationType.Timestamp;
  } else {
    throw new Error(`Unsupported DLMM activation type: ${activationType}`);
  }
}

export async function createPermissionlessDlmmPool(
  config: DlmmConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  if (!config.dlmm) {
    throw new Error('Missing DLMM configuration');
  }
  console.log('\n> Initializing Permissionless DLMM pool...');

  const binStep = config.dlmm.binStep;
  const feeBps = config.dlmm.feeBps;
  const hasAlphaVault = config.dlmm.hasAlphaVault;
  const activationPoint = config.dlmm.activationPoint ? new BN(config.dlmm.activationPoint) : null;

  const activationType = getDlmmActivationType(config.dlmm.activationType);
  const creatorPoolOnOffControl = config.dlmm.creatorPoolOnOffControl;
  console.log(`- Using binStep = ${binStep}`);
  console.log(`- Using feeBps = ${feeBps}`);
  console.log(`- Using initialPrice = ${config.dlmm.initialPrice}`);
  console.log(`- Using activationType = ${config.dlmm.activationType}`);
  console.log(`- Using activationPoint = ${activationPoint}`);
  console.log(`- Using hasAlphaVault = ${hasAlphaVault}`);
  console.log(`- Using creatorPoolOnOffControl = ${creatorPoolOnOffControl}`);

  const quoteDecimals = await getQuoteDecimals(connection, config.quoteMint);
  const baseMintInfo = await connection.getAccountInfo(baseMint, connection.commitment);
  const baseMintAccount = await getMint(
    connection,
    baseMint,
    connection.commitment,
    baseMintInfo.owner
  );
  const baseDecimals = baseMintAccount.decimals;

  const initPrice = DLMM.getPricePerLamport(baseDecimals, quoteDecimals, config.dlmm.initialPrice);

  const activateBinId = DLMM.getBinIdFromPrice(
    initPrice,
    binStep,
    !isPriceRoundingUp(config.dlmm.priceRounding)
  );

  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);
  const initPoolTx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    new BN(binStep),
    baseMint,
    quoteMint,
    new BN(activateBinId.toString()),
    new BN(feeBps),
    activationType,
    hasAlphaVault,
    wallet.publicKey,
    activationPoint,
    creatorPoolOnOffControl,
    {
      cluster,
      programId: dlmmProgramId,
    }
  );

  modifyComputeUnitPriceIx(initPoolTx, config.computeUnitPriceMicroLamports);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);

  console.log(`\n> Pool address: ${poolKey}`);

  if (config.dryRun) {
    console.log(`\n> Simulating init pool tx...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [initPoolTx]);
  } else {
    console.log(`>> Sending init pool transaction...`);
    const initPoolTxHash = await sendAndConfirmTransaction(connection, initPoolTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    }).catch((e) => {
      console.error(e);
      throw e;
    });
    console.log(`>>> Pool initialized successfully with tx hash: ${initPoolTxHash}`);
  }
}

export async function seedLiquidityLfg(
  connection: Connection,
  payerKeypair: Keypair,
  baseKeypair: Keypair,
  operatorKeypair: Keypair,
  positionOwner: PublicKey,
  feeOwner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  seedAmount: BN,
  curvature: number,
  minPrice: number,
  maxPrice: number,
  lockReleasePoint: BN,
  seedTokenXToPositionOwner: boolean,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number | bigint,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);
  console.log(`- Using pool key ${poolKey.toString()}`);

  console.log(`- Using seedAmount in lamports = ${seedAmount}`);
  console.log(`- Using curvature = ${curvature}`);
  console.log(`- Using minPrice ${minPrice}`);
  console.log(`- Using maxPrice ${maxPrice}`);
  console.log(`- Using operator ${operatorKeypair.publicKey}`);
  console.log(`- Using positionOwner ${positionOwner}`);
  console.log(`- Using feeOwner ${feeOwner}`);
  console.log(`- Using lockReleasePoint ${lockReleasePoint}`);
  console.log(`- Using seedTokenXToPositionOwner ${seedTokenXToPositionOwner}`);

  if (!seedTokenXToPositionOwner) {
    console.log(
      `WARNING: You selected seedTokenXToPositionOwner = false, you should manually send 1 lamport of token X to the position owner account to prove ownership.`
    );
  }

  const dlmmInstance = await DLMM.create(connection, poolKey, opts);

  const { sendPositionOwnerTokenProveIxs, initializeBinArraysAndPositionIxs, addLiquidityIxs } =
    await dlmmInstance.seedLiquidity(
      positionOwner,
      seedAmount,
      curvature,
      minPrice,
      maxPrice,
      baseKeypair.publicKey,
      payerKeypair.publicKey,
      feeOwner,
      operatorKeypair.publicKey,
      lockReleasePoint,
      seedTokenXToPositionOwner
    );

  if (sendPositionOwnerTokenProveIxs.length > 0) {
    // run preflight ixs
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );
    const setCUPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports,
    });

    const signers = [payerKeypair];
    const tx = new Transaction({
      feePayer: payerKeypair.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(setCUPriceIx);

    tx.add(...sendPositionOwnerTokenProveIxs);

    if (dryRun) {
      throw new Error('dryRun is not supported for this script, please set dryRun config to false');
    }

    console.log(`>> Running preflight instructions...`);
    try {
      console.log(`>> Sending preflight transaction...`);
      const txHash = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
      console.log(`>>> Preflight successfully with tx hash: ${txHash}`);
    } catch (err) {
      console.error(err);
      throw new Error(err as string);
    }
  }

  console.log(`>> Running initializeBinArraysAndPosition instructions...`);
  // Initialize all bin array and position, transaction order can be in sequence or not
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );

    const transactions: Array<Promise<string>> = [];

    for (const groupIx of initializeBinArraysAndPositionIxs) {
      const tx = new Transaction({
        feePayer: payerKeypair.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...groupIx);

      const signers = [payerKeypair, baseKeypair, operatorKeypair];

      transactions.push(
        sendAndConfirmTransaction(connection, tx, signers, {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        })
      );
    }

    await Promise.all(transactions)
      .then((txs) => {
        txs.map(console.log);
      })
      .catch((e) => {
        console.error(e);
        throw e;
      });
  }
  console.log(`>>> Finished initializeBinArraysAndPosition instructions!`);

  console.log(`>> Running addLiquidity instructions...`);
  {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
      connection.commitment
    );

    // Deposit to positions created in above step. The add liquidity order can be in sequence or not.
    for (const groupIx of addLiquidityIxs) {
      const tx = new Transaction({
        feePayer: payerKeypair.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(...groupIx);

      const signers = [payerKeypair, operatorKeypair];

      await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });
    }
  }
  console.log(`>>> Finished addLiquidity instructions!`);
}

export async function seedLiquiditySingleBin(
  connection: Connection,
  payerKeypair: Keypair,
  baseKeypair: Keypair,
  operatorKeypair: Keypair,
  positionOwner: PublicKey,
  feeOwner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  seedAmount: BN,
  price: number,
  priceRounding: string,
  lockReleasePoint: BN,
  seedTokenXToPositionOwner: boolean,
  dryRun: boolean,
  computeUnitPriceMicroLamports: number | bigint,
  opts?: {
    cluster?: Cluster | 'localhost';
    programId?: PublicKey;
  }
) {
  if (priceRounding != 'up' && priceRounding != 'down') {
    throw new Error("Invalid selective rounding value. Must be 'up' or 'down'");
  }

  const cluster = opts?.cluster || 'mainnet-beta';
  const dlmmProgramId =
    opts?.programId ?? new PublicKey(DLMM_PROGRAM_IDS[cluster as keyof typeof DLMM_PROGRAM_IDS]);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(baseMint, quoteMint, dlmmProgramId);
  console.log(`- Using pool key ${poolKey.toString()}`);

  console.log(`- Using seedAmount in lamports = ${seedAmount}`);
  console.log(`- Using priceRounding = ${priceRounding}`);
  console.log(`- Using price ${price}`);
  console.log(`- Using operator ${operatorKeypair.publicKey}`);
  console.log(`- Using positionOwner ${positionOwner}`);
  console.log(`- Using feeOwner ${feeOwner}`);
  console.log(`- Using lockReleasePoint ${lockReleasePoint}`);
  console.log(`- Using seedTokenXToPositionOwner ${seedTokenXToPositionOwner}`);

  if (!seedTokenXToPositionOwner) {
    console.log(
      `WARNING: You selected seedTokenXToPositionOwner = false, you should manually send 1 lamport of token X to the position owner account to prove ownership.`
    );
  }

  const dlmmInstance = await DLMM.create(connection, poolKey, opts);
  const { instructions } = await dlmmInstance.seedLiquiditySingleBin(
    payerKeypair.publicKey,
    baseKeypair.publicKey,
    seedAmount,
    price,
    priceRounding == 'up',
    positionOwner,
    feeOwner,
    operatorKeypair.publicKey,
    lockReleasePoint,
    seedTokenXToPositionOwner
  );

  const setCUPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: computeUnitPriceMicroLamports,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    connection.commitment
  );

  const tx = new Transaction({
    feePayer: payerKeypair.publicKey,
    blockhash,
    lastValidBlockHeight,
  })
    .add(setCUPriceIx)
    .add(...instructions);

  if (dryRun) {
    console.log(`\n> Simulating seedLiquiditySingleBin transaction...`);
    await runSimulateTransaction(
      connection,
      [payerKeypair, baseKeypair, operatorKeypair],
      payerKeypair.publicKey,
      [tx]
    );
  } else {
    console.log(`>> Sending seedLiquiditySingleBin transaction...`);
    const txHash = await sendAndConfirmTransaction(
      connection,
      tx,
      [payerKeypair, baseKeypair, operatorKeypair],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error(err);
      throw err;
    });
    console.log(`>>> SeedLiquiditySingleBin successfully with tx hash: ${txHash}`);
  }
}
