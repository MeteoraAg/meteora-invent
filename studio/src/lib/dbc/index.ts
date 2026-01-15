import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import { DbcConfig } from '../../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import {
  createDammV2Config,
  getQuoteDecimals,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES, LOCALNET_RPC_URL } from '../../utils/constants';
import {
  buildCurve,
  buildCurveWithLiquidityWeights,
  buildCurveWithMarketCap,
  buildCurveWithTwoSegments,
  ConfigParameters,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveBaseKeyForLocker,
  deriveDammV1MigrationMetadataAddress,
  deriveDbcPoolAuthority,
  deriveEscrow,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import { uploadTokenMetadata } from '../../helpers/metadata';

/**
 * Create a DBC config
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param quoteMint - The quote mint
 * @returns The public key of the DBC config
 */
export async function createDbcConfig(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  quoteMint: PublicKey
): Promise<PublicKey> {
  if (!config.dbcConfig) {
    throw new Error('Missing dbc configuration');
  }
  console.log('\n> Initializing DBC config...');

  let curveConfig: ConfigParameters | null = null;

  if (config.dbcConfig.buildCurveMode === 0) {
    curveConfig = buildCurve(config.dbcConfig);
  } else if (config.dbcConfig.buildCurveMode === 1) {
    curveConfig = buildCurveWithMarketCap(config.dbcConfig);
  } else if (config.dbcConfig.buildCurveMode === 2) {
    curveConfig = buildCurveWithTwoSegments(config.dbcConfig);
  } else if (config.dbcConfig.buildCurveMode === 3) {
    curveConfig = buildCurveWithLiquidityWeights(config.dbcConfig);
  } else {
    throw new Error(
      `Unsupported DBC build curve mode: ${(config.dbcConfig as any).buildCurveMode}`
    );
  }

  if (!curveConfig) {
    throw new Error('Failed to build curve config');
  }

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const configKeypair = Keypair.generate();
  console.log(`> Generated config keypair: ${configKeypair.publicKey.toString()}`);

  // Convert poolCreationFee from SOL to lamports
  const poolCreationFeeInLamports = config.dbcConfig.poolCreationFee
    ? new BN(Math.floor(config.dbcConfig.poolCreationFee * LAMPORTS_PER_SOL))
    : new BN(0);

  if (config.dbcConfig.poolCreationFee && config.dbcConfig.poolCreationFee > 0) {
    console.log(`> Pool creation fee: ${config.dbcConfig.poolCreationFee} SOL (${poolCreationFeeInLamports.toString()} lamports)`);
  }

  const createConfigTx = await dbcInstance.partner.createConfig({
    config: configKeypair.publicKey,
    quoteMint,
    feeClaimer: new PublicKey(config.dbcConfig.feeClaimer),
    leftoverReceiver: new PublicKey(config.dbcConfig.leftoverReceiver),
    payer: wallet.publicKey,
    ...curveConfig,
    poolCreationFee: poolCreationFeeInLamports,
  });

  modifyComputeUnitPriceIx(createConfigTx as any, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log(`> Simulating create config tx...`);
    await runSimulateTransaction(connection, [wallet.payer, configKeypair], wallet.publicKey, [
      createConfigTx,
    ]);
    console.log(`> Config simulation successful`);
  } else {
    console.log(`>> Sending create config transaction...`);
    const createConfigTxHash = await sendAndConfirmTransaction(
      connection,
      createConfigTx,
      [wallet.payer, configKeypair],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error('Failed to create config:', err);
      throw err;
    });

    console.log(`>>> Config created successfully with tx hash: ${createConfigTxHash}`);
    console.log(`>>> Config public key: ${configKeypair.publicKey.toString()}`);

    console.log(`> Waiting for config transaction to be finalized...`);
    await connection.confirmTransaction(createConfigTxHash, 'finalized');
    console.log(`>>> Config transaction finalized`);
  }

  return configKeypair.publicKey;
}

/**
 * Create a DBC pool
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param quoteMint - The quote mint
 * @param baseMint - The base mint
 */
export async function createDbcPool(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  quoteMint: PublicKey,
  baseMint: Keypair,
  dbcConfigKey: PublicKey | null
) {
  if (!config.dbcConfig) {
    throw new Error('Missing dbc configuration');
  }
  if (!config.dbcPool) {
    throw new Error('Missing dbc pool configuration');
  }

  let configPublicKey: PublicKey;
  if (!dbcConfigKey) {
    configPublicKey = await createDbcConfig(config, connection, wallet, quoteMint);
  } else {
    configPublicKey = dbcConfigKey;
  }

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  let metadataUri: string;
  if (config.dbcPool.metadata.uri) {
    console.log('Using existing metadata URI:', config.dbcPool.metadata.uri);
    metadataUri = config.dbcPool.metadata.uri;
  } else {
    console.log('Uploading metadata to Irys...');
    if (!config.dbcPool.metadata.image) {
      throw new Error('Image is required for DBC pool metadata');
    }
    metadataUri = await uploadTokenMetadata(
      connection.rpcEndpoint,
      wallet.payer as Keypair,
      config.dbcPool.name,
      config.dbcPool.symbol,
      config.dbcPool.metadata.image,
      config.dbcPool.metadata.description || '',
      config.dbcPool.metadata.website || '',
      config.dbcPool.metadata.twitter || '',
      config.dbcPool.metadata.telegram || ''
    );
  }

  if (config.dryRun) {
    console.log(
      `> Simulating create pool tx (note: this may fail in dry-run mode due to missing config state)...`
    );
    try {
      const createPoolTx = await dbcInstance.pool.createPool({
        baseMint: baseMint.publicKey,
        config: configPublicKey,
        name: config.dbcPool.name,
        symbol: config.dbcPool.symbol,
        uri: metadataUri,
        payer: wallet.publicKey,
        poolCreator: new PublicKey(config.dbcPool.creator),
      });

      modifyComputeUnitPriceIx(createPoolTx as any, config.computeUnitPriceMicroLamports ?? 0);

      await runSimulateTransaction(connection, [wallet.payer, baseMint], wallet.publicKey, [
        createPoolTx,
      ]);
      console.log(`> Pool simulation successful`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.log(`> Pool simulation failed (expected in dry-run mode): ${errorMessage}`);
      console.log(`> This is normal since the config doesn't exist on-chain during dry-run`);
    }
  } else {
    console.log(`>> Creating pool transaction...`);
    const createPoolTx = await dbcInstance.pool.createPool({
      baseMint: baseMint.publicKey,
      config: configPublicKey,
      name: config.dbcPool.name,
      symbol: config.dbcPool.symbol,
      uri: metadataUri,
      payer: wallet.publicKey,
      poolCreator: wallet.publicKey,
    });

    modifyComputeUnitPriceIx(createPoolTx as any, config.computeUnitPriceMicroLamports ?? 0);

    console.log(`>> Sending create pool transaction...`);
    const createPoolTxHash = await sendAndConfirmTransaction(
      connection,
      createPoolTx,
      [wallet.payer, baseMint],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    ).catch((err) => {
      console.error('Failed to create pool:', err);
      throw err;
    });

    console.log(`>>> Pool created successfully with tx hash: ${createPoolTxHash}`);
  }
}

/**
 * Claim trading fee from a DBC pool
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function claimTradingFee(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  console.log('\n> Initializing DBC claim trading fee...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const poolState = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!poolState) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const dbcConfigAddress = poolState.account.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  const poolAddress = poolState.publicKey;
  const creator = poolState.account.creator;
  const partner = poolConfig.feeClaimer;
  const feeMetrics = await dbcInstance.state.getPoolFeeMetrics(poolAddress);

  const isCreator = creator.toString() === wallet.publicKey.toString();
  console.log(`> Is creator: ${isCreator}`);
  const isPartner = partner.toString() === wallet.publicKey.toString();
  console.log(`> Is partner: ${isPartner}`);

  if (!isCreator && !isPartner) {
    console.log('> User is neither the creator nor the launchpad fee claimer');
    return;
  }

  const transactions: Transaction[] = [];

  if (isCreator) {
    const claimCreatorTradingFeeTx = await dbcInstance.creator.claimCreatorTradingFee({
      creator: wallet.publicKey,
      pool: poolAddress,
      maxBaseAmount: feeMetrics.current.creatorBaseFee,
      maxQuoteAmount: feeMetrics.current.creatorQuoteFee,
      payer: wallet.publicKey,
    });
    modifyComputeUnitPriceIx(claimCreatorTradingFeeTx, config.computeUnitPriceMicroLamports ?? 0);
    transactions.push(claimCreatorTradingFeeTx);
  } else {
    console.log('> This is not the creator of the pool');
  }

  if (isPartner) {
    const claimPartnerTradingFeeTx = await dbcInstance.partner.claimPartnerTradingFee({
      feeClaimer: wallet.publicKey,
      pool: poolAddress,
      maxBaseAmount: feeMetrics.current.partnerBaseFee,
      maxQuoteAmount: feeMetrics.current.partnerQuoteFee,
      payer: wallet.publicKey,
    });
    modifyComputeUnitPriceIx(claimPartnerTradingFeeTx, config.computeUnitPriceMicroLamports ?? 0);
    transactions.push(claimPartnerTradingFeeTx);
  } else {
    console.log('> This is not the launchpad fee claimer');
  }

  if (transactions.length === 0) {
    console.log('> No trading fees to claim');
    return;
  }

  if (config.dryRun) {
    console.log('> Simulating claim trading fee tx...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, transactions);
    console.log('> Claim trading fee simulation successful');
    return;
  }

  try {
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      if (!transaction) {
        throw new Error(`Transaction at index ${i} is undefined`);
      }
      const txType = i === 0 && isCreator ? 'creator' : 'partner';

      console.log(`> Sending ${txType} trading fee claim transaction...`);

      const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });

      console.log(`> ${txType} trading fee claimed successfully with tx hash: ${txHash}`);
    }
  } catch (error) {
    console.error('Failed to claim trading fee:', error);
    throw error;
  }
}

/**
 * Swap on DBC pools (Buy or Sell)
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function swap(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.dbcSwap) {
    throw new Error('Missing dbc swap parameters');
  }

  console.log('\n> Initializing DBC swap...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const poolState = await dbcInstance.state.getPoolByBaseMint(new PublicKey(baseMint));
  if (!poolState) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const poolAddress = poolState.publicKey;

  const dbcConfigAddress = poolState.account.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  const quoteMintDecimals = await getQuoteDecimals(connection, poolConfig.quoteMint.toString());
  const amountIn = new BN(config.dbcSwap.amountIn * 10 ** quoteMintDecimals);

  let currentPoint;
  if (poolConfig.activationType === 0) {
    currentPoint = await connection.getSlot();
  } else {
    const currentSlot = await connection.getSlot();
    currentPoint = await connection.getBlockTime(currentSlot);
  }

  if (currentPoint === null) {
    throw new Error('Failed to get current point (block time)');
  }

  const quote = await dbcInstance.pool.swapQuote({
    virtualPool: poolState.account,
    config: poolConfig,
    swapBaseForQuote: config.dbcSwap.swapBaseForQuote,
    amountIn,
    hasReferral: config.dbcSwap.referralTokenAccount !== '',
    currentPoint: new BN(currentPoint),
  });

  const swapTx = await dbcInstance.pool.swap({
    amountIn,
    minimumAmountOut: quote.minimumAmountOut,
    owner: wallet.publicKey,
    pool: poolAddress,
    swapBaseForQuote: config.dbcSwap.swapBaseForQuote,
    referralTokenAccount: config.dbcSwap.referralTokenAccount
      ? new PublicKey(config.dbcSwap.referralTokenAccount)
      : null,
  });

  modifyComputeUnitPriceIx(swapTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('> Simulating swap tx...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [swapTx]);
    console.log('> Swap tx simulation successful');
    return;
  }

  try {
    const txHash = await sendAndConfirmTransaction(connection, swapTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });

    console.log(`> Swap tx successful with tx hash: ${txHash}`);
  } catch (error) {
    console.error('Failed to swap:', error);
    throw error;
  }
}

/**
 * Migrate DBC pool to DAMM V1 pool
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function migrateDammV1(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  console.log('\n> Initializing migration from DBC to DAMM v1...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const poolState = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!poolState) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const dbcConfigAddress = poolState.account.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  console.log('> Pool Quote Reserve:', poolState.account.quoteReserve.toString());
  console.log('> Pool Migration Quote Threshold:', poolConfig.migrationQuoteThreshold.toString());

  if (poolState.account.quoteReserve.lt(poolConfig.migrationQuoteThreshold)) {
    throw new Error(
      'Unable to migrate DBC to DAMM V1: Pool quote reserve is less than migration quote threshold'
    );
  }

  const migrationFeeOption = poolConfig.migrationFeeOption;
  const dammConfigAddress = DAMM_V1_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!dammConfigAddress) {
    throw new Error(`No DAMM config address found for migration fee option: ${migrationFeeOption}`);
  }

  const poolAddress = poolState.publicKey;

  const transactions: Transaction[] = [];

  // check if migration metadata exists
  console.log('> Checking if migration metadata exists...');
  const migrationMetadata = deriveDammV1MigrationMetadataAddress(poolAddress);
  console.log('> Migration metadata address:', migrationMetadata.toString());

  const metadataAccount = await connection.getAccountInfo(migrationMetadata);
  if (!metadataAccount) {
    console.log('Creating migration metadata...');
    const createMetadataTx = await dbcInstance.migration.createDammV1MigrationMetadata({
      payer: wallet.publicKey,
      virtualPool: poolAddress,
      config: dbcConfigAddress,
    });
    modifyComputeUnitPriceIx(createMetadataTx, config.computeUnitPriceMicroLamports ?? 0);
    transactions.push(createMetadataTx);
  } else {
    console.log('Migration metadata already exists');
  }

  // check if locked vesting exists
  if (poolConfig.lockedVestingConfig.amountPerPeriod.gt(new BN(0))) {
    // check if locker already exists
    const base = deriveBaseKeyForLocker(poolAddress);
    const escrow = deriveEscrow(base);
    const escrowAccount = await connection.getAccountInfo(escrow);

    if (!escrowAccount) {
      console.log('> Locker not found, creating locker...');
      const createLockerTx = await dbcInstance.migration.createLocker({
        virtualPool: poolAddress,
        payer: wallet.publicKey,
      });
      modifyComputeUnitPriceIx(createLockerTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(createLockerTx);
    } else {
      console.log('> Locker already exists, skipping creation');
    }
  } else {
    console.log('> No locked vesting found, skipping locker creation');
  }

  // migrate to DAMM V1
  console.log('Migrating to DAMM V1...');
  if (poolState.account.isMigrated === 0) {
    const migrateTx = await dbcInstance.migration.migrateToDammV1({
      payer: wallet.publicKey,
      virtualPool: poolAddress,
      dammConfig: dammConfigAddress,
    });
    transactions.push(migrateTx);
  } else {
    console.log('> Pool already migrated to DAMM V1');
  }

  // execute metadata creation, locker creation, migration first
  if (transactions.length > 0) {
    if (config.dryRun) {
      console.log('> Simulating migration transactions...');
      for (let i = 0; i < transactions.length; i++) {
        const transaction = transactions[i];
        if (!transaction) {
          throw new Error(`Transaction at index ${i} is undefined`);
        }
        console.log(`> Simulating transaction [${i + 1}/${transactions.length}]...`);
        await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [transaction]);
      }
      console.log('> Initial migration simulation successful');
    } else {
      try {
        for (let i = 0; i < transactions.length; i++) {
          const transaction = transactions[i];
          if (!transaction) {
            throw new Error(`Transaction at index ${i} is undefined`);
          }

          console.log(`> Sending migration transaction [${i + 1}/${transactions.length}]...`);

          const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
            commitment: connection.commitment,
            maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
          });

          console.log(`> Migration transaction [${i + 1}] successful with tx hash: ${txHash}`);
        }
      } catch (error) {
        console.error('Failed to execute migration transactions:', error);
        throw error;
      }
    }
  }

  // clear the transactions array for LP claim/lock transactions
  transactions.length = 0;

  // fetch the migration metadata after it has been created
  let dammv1MigrationMetadata;
  try {
    dammv1MigrationMetadata = await dbcInstance.state.getDammV1MigrationMetadata(poolAddress);
  } catch (error) {
    if (config.dryRun) {
      console.log('> Cannot fetch migration metadata in dry-run mode (expected)');
      console.log('> Skipping LP claim/lock operations in dry-run mode');
      return;
    }
    throw new Error(`DAMM v1 migration metadata not found for ${poolAddress.toString()}: ${error}`);
  }

  // check if creator and partner are the same address
  const creator = poolState.account.creator;
  const partner = poolConfig.feeClaimer;
  const isCreatorSameAsPartner = creator.toString() === partner.toString();

  if (isCreatorSameAsPartner) {
    console.log(
      '> Creator and partner are the same address, will handle LP locking carefully to avoid conflicts'
    );
  }

  if (!dammv1MigrationMetadata) {
    if (config.dryRun) {
      console.log('> Migration metadata not available in dry-run mode');
      console.log('> Skipping LP claim/lock operations in dry-run mode');
      return;
    }
    throw new Error(`DAMM v1 migration metadata not found for ${poolAddress.toString()}`);
  }

  if (config.dryRun && poolState.account.isMigrated === 0) {
    console.log('> Pool not actually migrated in dry-run mode, skipping LP operations');
    return;
  }

  // if creator and partner are the same, combine the amounts and do a single claim
  const transactionLabels: string[] = [];
  if (isCreatorSameAsPartner) {
    const totalClaimableLp = dammv1MigrationMetadata.creatorLp.add(
      dammv1MigrationMetadata.partnerLp
    );
    const hasClaimableLp = totalClaimableLp.gt(new BN(0));
    const bothNotClaimed =
      dammv1MigrationMetadata.creatorClaimStatus === 0 &&
      dammv1MigrationMetadata.partnerClaimStatus === 0;

    if (hasClaimableLp && bothNotClaimed) {
      console.log('> Claiming combined Creator+Partner DAMM V1 LP tokens...');
      const claimCreatorLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: false, // Use creator (false) for the combined claim
      });
      modifyComputeUnitPriceIx(claimCreatorLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(claimCreatorLpTx);
      transactionLabels.push('Combined Creator+Partner LP claim');
    } else if (!hasClaimableLp) {
      console.log('> There are no LP tokens to claim for creator+partner');
    } else {
      console.log('> LP tokens already claimed for creator+partner');
    }
  } else {
    if (
      dammv1MigrationMetadata.creatorClaimStatus === 0 &&
      dammv1MigrationMetadata.creatorLp.gt(new BN(0))
    ) {
      console.log('> Claiming Creator DAMM V1 LP tokens...');
      const claimCreatorLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: false,
      });
      modifyComputeUnitPriceIx(claimCreatorLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(claimCreatorLpTx);
      transactionLabels.push('Creator LP claim');
    } else {
      console.log('> There is no creator LP tokens to claim');
    }

    if (
      dammv1MigrationMetadata.partnerClaimStatus === 0 &&
      dammv1MigrationMetadata.partnerLp.gt(new BN(0))
    ) {
      console.log('> Claiming Partner DAMM V1 LP tokens...');
      const claimPartnerLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: true,
      });
      modifyComputeUnitPriceIx(claimPartnerLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(claimPartnerLpTx);
      transactionLabels.push('Partner LP claim');
    } else {
      console.log('> There is no partner LP tokens to claim');
    }
  }

  // if creator and partner are the same, combine the amounts and do a single lock
  if (isCreatorSameAsPartner) {
    const totalLockedLp = dammv1MigrationMetadata.creatorLockedLp.add(
      dammv1MigrationMetadata.partnerLockedLp
    );
    const hasLockedLp = totalLockedLp.gt(new BN(0));
    const bothNotLocked =
      dammv1MigrationMetadata.creatorLockedStatus === 0 &&
      dammv1MigrationMetadata.partnerLockedStatus === 0;

    if (hasLockedLp && bothNotLocked) {
      console.log('> Locking combined Creator+Partner DAMM V1 LP tokens...');
      const lockCreatorLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: false, // Use creator (false) for the combined lock
      });
      modifyComputeUnitPriceIx(lockCreatorLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(lockCreatorLpTx);
      transactionLabels.push('Combined Creator+Partner LP lock');
    } else if (!hasLockedLp) {
      console.log('> There are no LP tokens to lock for creator+partner');
    } else {
      console.log('> LP tokens already locked for creator+partner');
    }
  } else {
    if (
      dammv1MigrationMetadata.creatorLockedStatus === 0 &&
      dammv1MigrationMetadata.creatorLockedLp.gt(new BN(0))
    ) {
      console.log('> Locking Creator DAMM V1 LP tokens...');
      const lockCreatorLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: false,
      });
      modifyComputeUnitPriceIx(lockCreatorLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(lockCreatorLpTx);
      transactionLabels.push('Creator LP lock');
    } else {
      console.log('> There is no creator LP tokens to lock');
    }

    if (
      dammv1MigrationMetadata.partnerLockedStatus === 0 &&
      dammv1MigrationMetadata.partnerLockedLp.gt(new BN(0))
    ) {
      console.log('> Locking Partner DAMM V1 LP tokens...');
      const lockPartnerLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        virtualPool: poolAddress,
        dammConfig: dammConfigAddress,
        isPartner: true,
      });

      modifyComputeUnitPriceIx(lockPartnerLpTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(lockPartnerLpTx);
      transactionLabels.push('Partner LP lock');
    } else {
      console.log('> There is no partner LP tokens to lock');
    }
  }

  // execute LP claim/lock transactions if any
  if (transactions.length === 0) {
    console.log('> No LP claim/lock transactions to execute');
    return;
  }

  if (config.dryRun) {
    console.log('> Simulating LP claim/lock transactions...');
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      if (!transaction) {
        throw new Error(`Transaction at index ${i} is undefined`);
      }
      const label = transactionLabels[i] || `Transaction ${i + 1}`;
      console.log(`> Simulating ${label}...`);
      await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [transaction]);
    }
    console.log('> LP claim/lock simulation successful');
    return;
  }

  try {
    for (let i = 0; i < transactions.length; i++) {
      const transaction = transactions[i];
      if (!transaction) {
        throw new Error(`Transaction at index ${i} is undefined`);
      }
      const label = transactionLabels[i] || `Transaction ${i + 1}`;

      console.log(`> Sending ${label}...`);

      const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      });

      console.log(`> ${label} successful with tx hash: ${txHash}`);
    }
  } catch (error) {
    console.error('Failed to execute LP claim/lock transactions:', error);
    throw error;
  }
}

/**
 * Migrate DBC pool to DAMM V2 pool
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 */
export async function migrateDammV2(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  console.log('\n> Initializing migration from DBC to DAMM v2...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const poolState = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!poolState) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const dbcConfigAddress = poolState.account.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  console.log('> Pool Quote Reserve:', poolState.account.quoteReserve.toString());
  console.log('> Pool Migration Quote Threshold:', poolConfig.migrationQuoteThreshold.toString());

  if (poolState.account.quoteReserve.lt(poolConfig.migrationQuoteThreshold)) {
    throw new Error(
      'Unable to migrate DBC to DAMM V2: Pool quote reserve is less than migration quote threshold'
    );
  }

  const migrationFeeOption = poolConfig.migrationFeeOption;
  let dammConfigAddress = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (config.rpcUrl === LOCALNET_RPC_URL) {
    const poolAuthority = deriveDbcPoolAuthority();
    dammConfigAddress = await createDammV2Config(
      connection,
      wallet.payer as Keypair,
      poolAuthority,
      migrationFeeOption
    );
  }
  if (!dammConfigAddress) {
    throw new Error(
      `No DAMM V2 config address found for migration fee option: ${migrationFeeOption}`
    );
  }

  const poolAddress = poolState.publicKey;

  const transactions: Transaction[] = [];

  // check if locked vesting exists
  if (poolConfig.lockedVestingConfig.amountPerPeriod.gt(new BN(0))) {
    // check if locker already exists
    const base = deriveBaseKeyForLocker(poolAddress);
    const escrow = deriveEscrow(base);
    const escrowAccount = await connection.getAccountInfo(escrow);

    if (!escrowAccount) {
      console.log('> Locker not found, creating locker...');
      const createLockerTx = await dbcInstance.migration.createLocker({
        virtualPool: poolAddress,
        payer: wallet.publicKey,
      });
      modifyComputeUnitPriceIx(createLockerTx, config.computeUnitPriceMicroLamports ?? 0);
      transactions.push(createLockerTx);
    } else {
      console.log('> Locker already exists, skipping creation');
    }
  } else {
    console.log('> No locked vesting found, skipping locker creation');
  }

  // execute metadata creation and locker creation first
  if (transactions.length > 0) {
    if (config.dryRun) {
      console.log('> Simulating migration transactions...');
      for (let i = 0; i < transactions.length; i++) {
        const transaction = transactions[i];
        if (!transaction) {
          throw new Error(`Transaction at index ${i} is undefined`);
        }
        console.log(`> Simulating transaction [${i + 1}/${transactions.length}]...`);
        await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [transaction]);
      }
      console.log('> Initial migration simulation successful');
    } else {
      try {
        for (let i = 0; i < transactions.length; i++) {
          const transaction = transactions[i];
          if (!transaction) {
            throw new Error(`Transaction at index ${i} is undefined`);
          }

          console.log(`> Sending migration transaction [${i + 1}/${transactions.length}]...`);

          const txHash = await sendAndConfirmTransaction(connection, transaction, [wallet.payer], {
            commitment: connection.commitment,
            maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
          });

          console.log(`> Migration transaction [${i + 1}] successful with tx hash: ${txHash}`);
        }
      } catch (error) {
        console.error('Failed to execute migration transactions:', error);
        throw error;
      }
    }
  }

  // migrate to DAMM V2
  console.log('Migrating to DAMM V2...');
  if (poolState.account.isMigrated === 0) {
    const {
      transaction: migrateTx,
      firstPositionNftKeypair,
      secondPositionNftKeypair,
    } = await dbcInstance.migration.migrateToDammV2({
      payer: wallet.publicKey,
      virtualPool: poolAddress,
      dammConfig: dammConfigAddress,
    });

    modifyComputeUnitPriceIx(migrateTx, config.computeUnitPriceMicroLamports ?? 0);

    if (config.dryRun) {
      console.log('> Simulating migration to DAMM V2 transaction...');
      await runSimulateTransaction(
        connection,
        [wallet.payer, firstPositionNftKeypair, secondPositionNftKeypair],
        wallet.publicKey,
        [migrateTx]
      );
      console.log('> Migration simulation successful');
    } else {
      console.log('> Sending migration to DAMM V2 transaction...');
      const migrateTxHash = await sendAndConfirmTransaction(
        connection,
        migrateTx,
        [wallet.payer, firstPositionNftKeypair, secondPositionNftKeypair],
        {
          commitment: connection.commitment,
          maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
        }
      );
      console.log(`> Migration to DAMM V2 successful with tx hash: ${migrateTxHash}`);
    }
  } else {
    console.log('> Pool already migrated to DAMM V2');
  }

  console.log('> DAMM V2 migration process completed successfully');
}

/**
 * Transfer DBC pool creator
 * @param config - The DBC config
 * @param connection - The connection to the network
 * @param wallet - The wallet to use for the transaction
 * @param baseMint - The base mint
 * @returns The public key of the DBC config
 */
export async function transferDbcPoolCreator(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.dbcTransferPoolCreator) {
    throw new Error('Missing dbc transfer pool creator parameters');
  }

  console.log('\n> Initializing DBC pool creator transfer...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const poolState = await dbcInstance.state.getPoolByBaseMint(new PublicKey(baseMint));
  if (!poolState) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const poolAddress = poolState.publicKey;

  const transferPoolCreatorTx = await dbcInstance.creator.transferPoolCreator({
    virtualPool: poolAddress,
    creator: wallet.publicKey,
    newCreator: new PublicKey(config.dbcTransferPoolCreator.newCreator),
  });

  modifyComputeUnitPriceIx(transferPoolCreatorTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('> Simulating transfer pool creator tx...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      transferPoolCreatorTx,
    ]);
    console.log('> Transfer pool creator tx simulation successful');
    return;
  }

  try {
    const txHash = await sendAndConfirmTransaction(
      connection,
      transferPoolCreatorTx,
      [wallet.payer],
      {
        commitment: connection.commitment,
        maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
      }
    );

    console.log(`> Transfer pool creator tx successful with tx hash: ${txHash}`);
  } catch (error) {
    console.error('Failed to swap:', error);
    throw error;
  }
}
