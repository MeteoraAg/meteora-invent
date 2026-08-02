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
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { validateDbcConfigFields, validateBaseConfig } from '../../helpers/config-validation';
import { DEFAULT_SEND_TX_MAX_RETRIES, LOCALNET_RPC_URL } from '../../utils/constants';
import {
  buildCurve,
  buildCurveWithCustomSqrtPrices,
  buildCurveWithLiquidityWeights,
  buildCurveWithMarketCap,
  buildCurveWithMidPrice,
  buildCurveWithTwoSegments,
  getSqrtPriceFromPrice,
  ConfigParameters,
  DAMM_V1_MIGRATION_FEE_ADDRESS,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveBaseKeyForLocker,
  deriveDammV1MigrationMetadataAddress,
  deriveDbcPoolAuthority,
  deriveEscrow,
  DynamicBondingCurveClient,
  TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { uploadTokenMetadata } from '../../helpers/metadata';

export async function createDbcConfig(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  quoteMint: PublicKey
): Promise<PublicKey> {
  // Validate config before executing any actions
  validateBaseConfig(config);
  if (!config.dbcConfig) {
    throw new Error(
      'Missing dbc configuration. Ensure "dbcConfig" is set in config/dbc_config.jsonc.'
    );
  }
  validateDbcConfigFields(config.dbcConfig as any);
  console.log('\n> Initializing DBC config...');

  let curveConfig: ConfigParameters | null = null;

  // Destructure out fields not needed by buildCurve* functions
  const { buildCurveMode, leftoverReceiver, feeClaimer, transferHookProgram, ...buildCurveParams } =
    config.dbcConfig;

  if (transferHookProgram && buildCurveParams.token?.tokenType !== TokenType.Token2022) {
    throw new Error(
      'transferHookProgram requires token.tokenType to be 1 (Token2022) in config/dbc_config.jsonc'
    );
  }

  if (buildCurveMode === 0) {
    curveConfig = buildCurve(buildCurveParams as any);
  } else if (buildCurveMode === 1) {
    curveConfig = buildCurveWithMarketCap(buildCurveParams as any);
  } else if (buildCurveMode === 2) {
    curveConfig = buildCurveWithTwoSegments(buildCurveParams as any);
  } else if (buildCurveMode === 3) {
    curveConfig = buildCurveWithLiquidityWeights(buildCurveParams as any);
  } else if (buildCurveMode === 4) {
    curveConfig = buildCurveWithMidPrice(buildCurveParams as any);
  } else if (buildCurveMode === 5) {
    const { prices, ...restParams } = buildCurveParams as any;
    if (!prices || !Array.isArray(prices) || prices.length < 2) {
      throw new Error(
        'prices array must have at least 2 elements for buildCurveWithCustomSqrtPrices'
      );
    }
    const tokenBaseDecimal = restParams.token?.tokenBaseDecimal ?? 6;
    const tokenQuoteDecimal = restParams.token?.tokenQuoteDecimal ?? 9;
    const sqrtPrices = prices.map((price: number) =>
      getSqrtPriceFromPrice(String(price), tokenBaseDecimal, tokenQuoteDecimal)
    );
    curveConfig = buildCurveWithCustomSqrtPrices({ ...restParams, sqrtPrices });
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

  const createConfigParams = {
    config: configKeypair.publicKey,
    quoteMint,
    feeClaimer: new PublicKey(feeClaimer),
    leftoverReceiver: new PublicKey(leftoverReceiver),
    payer: wallet.publicKey,
    ...curveConfig,
  };

  let createConfigTx: Transaction;
  if (transferHookProgram) {
    console.log(`> Creating config with transfer hook program: ${transferHookProgram}`);
    createConfigTx = await dbcInstance.partner.createConfigWithTransferHook({
      ...createConfigParams,
      transferHookProgram: new PublicKey(transferHookProgram),
    });
  } else {
    createConfigTx = await dbcInstance.partner.createConfig(createConfigParams);
  }

  modifyComputeUnitPriceIx(createConfigTx, config.computeUnitPriceMicroLamports ?? 0);

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
  // Validate config before executing any actions
  validateBaseConfig(config);
  if (!config.dbcConfig) {
    throw new Error(
      'Missing dbc configuration. Ensure "dbcConfig" is set in config/dbc_config.jsonc.'
    );
  }
  validateDbcConfigFields({ ...(config.dbcConfig as any), dbcPool: config.dbcPool });
  if (!config.dbcPool) {
    throw new Error(
      'Missing dbc pool configuration. Ensure "dbcPool" is set in config/dbc_config.jsonc.'
    );
  }

  let configPublicKey: PublicKey;
  if (!dbcConfigKey) {
    configPublicKey = await createDbcConfig(config, connection, wallet, quoteMint);
  } else {
    configPublicKey = dbcConfigKey;
  }

  // A pool on a transfer hook config must be created with the same hook program.
  // Fall back to the dbcConfig hook when the config was created in this run.
  const transferHookProgram =
    config.dbcPool.transferHookProgram ??
    (!dbcConfigKey ? config.dbcConfig?.transferHookProgram : null) ??
    null;

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const buildCreatePoolTx = async (metadataUri: string): Promise<Transaction> => {
    if (!config.dbcPool) {
      throw new Error('Missing dbc pool configuration');
    }
    const createPoolParams = {
      baseMint: baseMint.publicKey,
      config: configPublicKey,
      name: config.dbcPool.name,
      symbol: config.dbcPool.symbol,
      uri: metadataUri,
      payer: wallet.publicKey,
      poolCreator: new PublicKey(config.dbcPool.creator),
    };
    if (transferHookProgram) {
      console.log(`> Creating pool with transfer hook program: ${transferHookProgram}`);
      return dbcInstance.creator.createPoolWithTransferHook({
        ...createPoolParams,
        transferHookProgram: new PublicKey(transferHookProgram),
      });
    }
    return dbcInstance.creator.createPool(createPoolParams);
  };

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
      const createPoolTx = await buildCreatePoolTx(metadataUri);

      modifyComputeUnitPriceIx(createPoolTx, config.computeUnitPriceMicroLamports ?? 0);

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
    const createPoolTx = await buildCreatePoolTx(metadataUri);

    modifyComputeUnitPriceIx(createPoolTx, config.computeUnitPriceMicroLamports ?? 0);

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

  const virtualPool = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!virtualPool) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }
  const poolState = virtualPool.account.poolState;

  const dbcConfigAddress = poolState.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  console.log('> Pool Quote Reserve:', poolState.quoteReserve.toString());
  console.log('> Pool Migration Quote Threshold:', poolConfig.migrationQuoteThreshold.toString());

  if (poolState.quoteReserve.lt(poolConfig.migrationQuoteThreshold)) {
    throw new Error(
      'Unable to migrate DBC to DAMM V1: Pool quote reserve is less than migration quote threshold'
    );
  }

  const migrationFeeOption = poolConfig.migrationFeeOption;
  const dammConfigAddress = DAMM_V1_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (!dammConfigAddress) {
    throw new Error(`No DAMM config address found for migration fee option: ${migrationFeeOption}`);
  }

  const poolAddress = virtualPool.publicKey;

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
        pool: poolAddress,
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
  if (poolState.isMigrated === 0) {
    const migrateTx = await dbcInstance.migration.migrateToDammV1({
      payer: wallet.publicKey,
      pool: poolAddress,
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
  const creator = poolState.creator;
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

  if (config.dryRun && poolState.isMigrated === 0) {
    console.log('> Pool not actually migrated in dry-run mode, skipping LP operations');
    return;
  }

  // if creator and partner are the same, combine the amounts and do a single claim
  const transactionLabels: string[] = [];
  if (isCreatorSameAsPartner) {
    const totalClaimableLp = dammv1MigrationMetadata.creatorLiquidity.add(
      dammv1MigrationMetadata.partnerLiquidity
    );
    const hasClaimableLp = totalClaimableLp.gt(new BN(0));
    const bothNotClaimed =
      dammv1MigrationMetadata.creatorClaimStatus === 0 &&
      dammv1MigrationMetadata.partnerClaimStatus === 0;

    if (hasClaimableLp && bothNotClaimed) {
      console.log('> Claiming combined Creator+Partner DAMM V1 LP tokens...');
      const claimCreatorLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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
      dammv1MigrationMetadata.creatorLiquidity.gt(new BN(0))
    ) {
      console.log('> Claiming Creator DAMM V1 LP tokens...');
      const claimCreatorLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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
      dammv1MigrationMetadata.partnerLiquidity.gt(new BN(0))
    ) {
      console.log('> Claiming Partner DAMM V1 LP tokens...');
      const claimPartnerLpTx = await dbcInstance.migration.claimDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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
    const totalLockedLp = dammv1MigrationMetadata.creatorLockedLiquidity.add(
      dammv1MigrationMetadata.partnerLockedLiquidity
    );
    const hasLockedLp = totalLockedLp.gt(new BN(0));
    const bothNotLocked =
      dammv1MigrationMetadata.creatorLockedStatus === 0 &&
      dammv1MigrationMetadata.partnerLockedStatus === 0;

    if (hasLockedLp && bothNotLocked) {
      console.log('> Locking combined Creator+Partner DAMM V1 LP tokens...');
      const lockCreatorLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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
      dammv1MigrationMetadata.creatorLockedLiquidity.gt(new BN(0))
    ) {
      console.log('> Locking Creator DAMM V1 LP tokens...');
      const lockCreatorLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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
      dammv1MigrationMetadata.partnerLockedLiquidity.gt(new BN(0))
    ) {
      console.log('> Locking Partner DAMM V1 LP tokens...');
      const lockPartnerLpTx = await dbcInstance.migration.lockDammV1LpToken({
        payer: wallet.publicKey,
        pool: poolAddress,
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

  const virtualPool = await dbcInstance.state.getPoolByBaseMint(baseMint);
  if (!virtualPool) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }
  const poolState = virtualPool.account.poolState;

  const dbcConfigAddress = poolState.config;
  const poolConfig = await dbcInstance.state.getPoolConfig(dbcConfigAddress);
  if (!poolConfig) {
    throw new Error(`DBC Pool config not found for ${dbcConfigAddress.toString()}`);
  }

  console.log('> Pool Quote Reserve:', poolState.quoteReserve.toString());
  console.log('> Pool Migration Quote Threshold:', poolConfig.migrationQuoteThreshold.toString());

  if (poolState.quoteReserve.lt(poolConfig.migrationQuoteThreshold)) {
    throw new Error(
      'Unable to migrate DBC to DAMM V2: Pool quote reserve is less than migration quote threshold'
    );
  }

  const migrationFeeOption = poolConfig.migrationFeeOption;
  let dammConfigAddress = DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption];
  if (config.rpcUrl === LOCALNET_RPC_URL && dammConfigAddress) {
    // start-test-validator preloads the canonical migration configs; only create one when missing
    const canonicalConfigAccount = await connection.getAccountInfo(dammConfigAddress);
    if (!canonicalConfigAccount) {
      const poolAuthority = deriveDbcPoolAuthority();
      dammConfigAddress = await createDammV2Config(
        connection,
        wallet.payer as Keypair,
        poolAuthority,
        migrationFeeOption
      );
    }
  }
  if (!dammConfigAddress) {
    throw new Error(
      `No DAMM V2 config address found for migration fee option: ${migrationFeeOption}`
    );
  }

  const poolAddress = virtualPool.publicKey;

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
        pool: poolAddress,
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
  if (poolState.isMigrated === 0) {
    const {
      transaction: migrateTx,
      firstPositionNftKeypair,
      secondPositionNftKeypair,
    } = await dbcInstance.migration.migrateToDammV2({
      payer: wallet.publicKey,
      pool: poolAddress,
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

  validateBaseConfig(config);
  validateDbcConfigFields({ dbcTransferPoolCreator: config.dbcTransferPoolCreator });

  console.log('\n> Initializing DBC pool creator transfer...');

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const virtualPool = await dbcInstance.state.getPoolByBaseMint(new PublicKey(baseMint));
  if (!virtualPool) {
    throw new Error(`DBC Pool not found for ${baseMint.toString()}`);
  }

  const poolAddress = virtualPool.publicKey;

  const transferPoolCreatorTx = await dbcInstance.creator.transferPoolCreator({
    pool: poolAddress,
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
