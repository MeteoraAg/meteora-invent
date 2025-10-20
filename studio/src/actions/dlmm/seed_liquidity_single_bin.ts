import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  getAmountInLamports,
  safeParseKeypairFromFile,
  getDlmmConfig,
  parseCliArguments,
} from '../../helpers';
import { LBCLMM_PROGRAM_IDS, deriveCustomizablePermissionlessLbPair } from '@meteora-ag/dlmm';
import BN from 'bn.js';
import { unpackMint } from '@solana/spl-token';
import { DEFAULT_COMMITMENT_LEVEL } from '../../utils/constants';
import { seedLiquiditySingleBin } from '../../lib/dlmm';

async function main() {
  const config = await getDlmmConfig();

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const DLMM_PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta']);

  const { baseMint } = parseCliArguments();
  if (!baseMint) {
    throw new Error('Please provide --baseMint flag to do this action');
  }

  const baseMintAccount = await connection.getAccountInfo(new PublicKey(baseMint));
  if (!baseMintAccount) {
    throw new Error(`Base mint account not found: ${baseMint}`);
  }

  const baseMintState = unpackMint(new PublicKey(baseMint), baseMintAccount, baseMintAccount.owner);
  const baseDecimals = baseMintState.decimals;

  if (!config.quoteMint) {
    throw new Error('Missing quoteMint in configuration');
  }
  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  const [poolKey] = deriveCustomizablePermissionlessLbPair(
    new PublicKey(baseMint),
    quoteMint,
    DLMM_PROGRAM_ID
  );
  console.log(`- Using pool key ${poolKey.toString()}`);

  if (!config.singleBinSeedLiquidity) {
    throw new Error(`Missing DLMM Single bin seed liquidity in configuration`);
  }

  const seedAmount = getAmountInLamports(config.singleBinSeedLiquidity.seedAmount, baseDecimals);
  const priceRounding = config.singleBinSeedLiquidity.priceRounding;
  if (priceRounding != 'up' && priceRounding != 'down') {
    throw new Error("Invalid selective rounding value. Must be 'up' or 'down'");
  }
  const baseKeypair = Keypair.generate();
  const operatorKeypair = await safeParseKeypairFromFile(
    config.singleBinSeedLiquidity.operatorKeypairFilepath
  );
  const price = config.singleBinSeedLiquidity.price;
  const positionOwner = new PublicKey(config.singleBinSeedLiquidity.positionOwner);
  const feeOwner = new PublicKey(config.singleBinSeedLiquidity.feeOwner);
  const lockReleasePoint = new BN(config.singleBinSeedLiquidity.lockReleasePoint);
  const seedTokenXToPositionOwner = config.singleBinSeedLiquidity.seedTokenXToPositionOwner;

  await seedLiquiditySingleBin(
    connection,
    keypair,
    baseKeypair,
    operatorKeypair,
    positionOwner,
    feeOwner,
    new PublicKey(baseMint),
    quoteMint,
    seedAmount,
    price,
    priceRounding,
    lockReleasePoint,
    seedTokenXToPositionOwner,
    config.dryRun,
    config.computeUnitPriceMicroLamports ?? 0
  );
}

main();
