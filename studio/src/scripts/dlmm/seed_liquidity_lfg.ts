import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAmountInLamports, safeParseKeypairFromFile, parseConfigFromCli } from '../../helpers';
import { BN } from 'bn.js';
import DLMM, { LBCLMM_PROGRAM_IDS, deriveCustomizablePermissionlessLbPair } from '@meteora-ag/dlmm';
import { unpackMint } from '@solana/spl-token';
import { DlmmConfig } from '../../utils/types';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { seedLiquidityLfg } from '../../lib/dlmm';

async function main() {
  const config: DlmmConfig = (await parseConfigFromCli()) as DlmmConfig;

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);

  if (!config.baseMint) {
    throw new Error('Missing baseMint in configuration');
  }
  const baseMint = new PublicKey(config.baseMint);
  const baseMintAccount = await connection.getAccountInfo(baseMint, connection.commitment);
  const baseMintState = unpackMint(baseMint, baseMintAccount, baseMintAccount.owner);
  const baseDecimals = baseMintState.decimals;

  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(
    baseMint,
    quoteMint,
    new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta'])
  );
  console.log(`- Using pool key ${poolKey.toString()}`);

  if (!config.lfgSeedLiquidity) {
    throw new Error(`Missing DLMM LFG seed liquidity in configuration`);
  }

  const pair = await DLMM.create(connection, poolKey, {
    cluster: 'mainnet-beta',
  });
  await pair.refetchStates();

  const seedAmount = getAmountInLamports(config.lfgSeedLiquidity.seedAmount, baseDecimals);
  const curvature = config.lfgSeedLiquidity.curvature;
  const minPrice = config.lfgSeedLiquidity.minPrice;
  const maxPrice = config.lfgSeedLiquidity.maxPrice;
  const baseKeypair = Keypair.generate();
  const operatorKeypair = await safeParseKeypairFromFile(
    config.lfgSeedLiquidity.operatorKeypairFilepath
  );
  const positionOwner = new PublicKey(config.lfgSeedLiquidity.positionOwner);
  const feeOwner = new PublicKey(config.lfgSeedLiquidity.feeOwner);
  const lockReleasePoint = new BN(config.lfgSeedLiquidity.lockReleasePoint);
  const seedTokenXToPositionOwner = config.lfgSeedLiquidity.seedTokenXToPositionOwner;

  await seedLiquidityLfg(
    connection,
    keypair,
    baseKeypair,
    operatorKeypair,
    positionOwner,
    feeOwner,
    baseMint,
    quoteMint,
    seedAmount,
    curvature,
    minPrice,
    maxPrice,
    lockReleasePoint,
    seedTokenXToPositionOwner,
    config.dryRun,
    config.computeUnitPriceMicroLamports
  );
}

main();
