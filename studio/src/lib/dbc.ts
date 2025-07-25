import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import { DbcConfig } from '../utils/types';
import { Wallet } from '@coral-xyz/anchor';
import { modifyComputeUnitPriceIx, runSimulateTransaction } from '../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../utils/constants';
import {
  buildCurve,
  buildCurveWithLiquidityWeights,
  buildCurveWithMarketCap,
  buildCurveWithTwoSegments,
  ConfigParameters,
  DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk';

export async function createDbcPool(
  config: DbcConfig,
  connection: Connection,
  wallet: Wallet,
  quoteMint: PublicKey,
  baseMint: Keypair
) {
  if (!config) {
    throw new Error('Missing dbc configuration');
  }
  console.log('\n> Initializing DBC config...');

  let curveConfig: ConfigParameters | null = null;

  if (config.dbc.buildCurveMode === 0) {
    curveConfig = buildCurve(config.dbc);
  } else if (config.dbc.buildCurveMode === 1) {
    curveConfig = buildCurveWithMarketCap(config.dbc);
  } else if (config.dbc.buildCurveMode === 2) {
    curveConfig = buildCurveWithTwoSegments(config.dbc);
  } else if (config.dbc.buildCurveMode === 3) {
    curveConfig = buildCurveWithLiquidityWeights(config.dbc);
  } else {
    throw new Error(`Unsupported DBC build curve mode: ${(config.dbc as any).buildCurveMode}`);
  }

  if (!curveConfig) {
    throw new Error('Failed to build curve config');
  }

  const dbcInstance = new DynamicBondingCurveClient(connection, 'confirmed');

  const configKeypair = Keypair.generate();
  console.log(`> Generated config keypair: ${configKeypair.publicKey.toString()}`);

  // Create and send the config transaction first
  const createConfigTx = await dbcInstance.partner.createConfig({
    config: configKeypair.publicKey,
    quoteMint,
    feeClaimer: new PublicKey(config.dbc.feeClaimer),
    leftoverReceiver: new PublicKey(config.dbc.leftoverReceiver),
    payer: wallet.publicKey,
    ...curveConfig,
  });

  modifyComputeUnitPriceIx(createConfigTx as any, config.computeUnitPriceMicroLamports);

  if (config.dryRun) {
    console.log(`> Simulating create config tx...`);
    await runSimulateTransaction(connection, [wallet.payer, configKeypair], wallet.publicKey, [
      createConfigTx,
    ]);
    console.log(`> Config simulation successful`);

    console.log(
      `> Simulating create pool tx (note: this may fail in dry-run mode due to missing config state)...`
    );
    try {
      const createPoolTx = await dbcInstance.pool.createPool({
        baseMint: baseMint.publicKey,
        config: configKeypair.publicKey,
        name: config.dbc.createPool.name,
        symbol: config.dbc.createPool.symbol,
        uri: config.dbc.createPool.uri,
        payer: wallet.publicKey,
        poolCreator: wallet.publicKey,
      });

      modifyComputeUnitPriceIx(createPoolTx as any, config.computeUnitPriceMicroLamports);

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

    console.log(`>> Creating pool transaction...`);
    const createPoolTx = await dbcInstance.pool.createPool({
      baseMint: baseMint.publicKey,
      config: configKeypair.publicKey,
      name: config.dbc.createPool.name,
      symbol: config.dbc.createPool.symbol,
      uri: config.dbc.createPool.uri,
      payer: wallet.publicKey,
      poolCreator: wallet.publicKey,
    });

    modifyComputeUnitPriceIx(createPoolTx as any, config.computeUnitPriceMicroLamports);

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
    console.log(`>>> Base mint public key: ${baseMint.publicKey.toString()}`);
  }
}
