import { SOL_TOKEN_DECIMALS } from '../utils/constants';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import { Signer, PublicKey, Connection, Keypair } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { AllocationByAmount, LockLiquidityAllocation } from '../utils/types';
import {
  ActivationType,
  createDammV2Program,
  DAMM_V2_PROGRAM_ID,
  getDynamicFeeParams,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { MAX_SQRT_PRICE, MIN_SQRT_PRICE } from '@meteora-ag/cp-amm-sdk';

export function getAmountInLamports(amount: number | string, decimals: number): BN {
  const amountD = new Decimal(amount);
  const amountLamports = amountD.mul(new Decimal(10 ** decimals));
  return new BN(amountLamports.toString());
}

export function getSigners(
  signerOrMultisig: Signer | PublicKey,
  multiSigners: Signer[]
): [PublicKey, Signer[]] {
  return signerOrMultisig instanceof PublicKey
    ? [signerOrMultisig, multiSigners]
    : [signerOrMultisig.publicKey, [signerOrMultisig]];
}

export async function getQuoteDecimals(
  connection: Connection,
  quoteMint?: string
): Promise<number> {
  if (quoteMint) {
    const quoteMintInfo = await connection.getAccountInfo(new PublicKey(quoteMint));
    if (!quoteMintInfo) {
      throw new Error(`Quote mint account not found: ${quoteMint}`);
    }
    const mintAccount = await getMint(
      connection,
      new PublicKey(quoteMint),
      connection.commitment,
      quoteMintInfo.owner
    );
    const decimals = mintAccount.decimals;
    return decimals;
  }
  return SOL_TOKEN_DECIMALS;
}

export function getDecimalizedAmount(amountLamport: BN, decimals: number): BN {
  return amountLamport.div(new BN(10 ** decimals));
}

export function getAmountInTokens(amountLamport: BN, decimals: number): string {
  const amountDecimal = new Decimal(amountLamport.toString());
  const divisor = new Decimal(10 ** decimals);
  const formatted = amountDecimal.div(divisor);
  return formatted.toString();
}

export function fromAllocationsToAmount(
  lpAmount: BN,
  allocations: LockLiquidityAllocation[]
): AllocationByAmount[] {
  const sumPercentage = allocations.reduce((partialSum, a) => partialSum + a.percentage, 0);
  if (sumPercentage === 0) {
    throw Error('sumPercentage is zero');
  } else if (sumPercentage > 100) {
    throw Error('sumPercentage is greater than 100');
  }

  const amounts: AllocationByAmount[] = [];
  let sum = new BN(0);
  for (let i = 0; i < allocations.length - 1; i++) {
    const allocation = allocations[i];
    if (!allocation) {
      throw new Error(`Allocation at index ${i} is undefined`);
    }
    const amount = lpAmount.mul(new BN(allocation.percentage)).div(new BN(sumPercentage));
    sum = sum.add(amount);
    amounts.push({
      address: new PublicKey(allocation.address),
      amount,
      percentage: allocation.percentage,
    });
  }
  // the last wallet get remaining amount
  const lastAllocation = allocations[allocations.length - 1];
  if (!lastAllocation) {
    throw new Error(`Last allocation is undefined`);
  }
  amounts.push({
    address: new PublicKey(lastAllocation.address),
    amount: lpAmount.sub(sum),
    percentage: lastAllocation.percentage,
  });
  return amounts;
}

export function chunks<T>(array: T[], size: number): T[][] {
  return Array.apply(0, new Array(Math.ceil(array.length / size))).map((_, index) =>
    array.slice(index * size, (index + 1) * size)
  );
}

export async function getCurrentPoint(
  connection: Connection,
  activationType: ActivationType
): Promise<BN> {
  const currentSlot = await connection.getSlot();

  if (activationType === ActivationType.Slot) {
    return new BN(currentSlot);
  } else {
    const currentTime = await connection.getBlockTime(currentSlot);
    if (currentTime === null) {
      throw new Error('Failed to get block time');
    }
    return new BN(currentTime);
  }
}

export async function createDammV2Config(
  connection: Connection,
  payer: Keypair,
  poolCreatorAuthority: PublicKey,
  migrationFeeOption: number
): Promise<PublicKey> {
  const program = createDammV2Program(connection);

  let baseFeeBps = 100;
  let cliffFeeNumerator = new BN(10000000);
  if (migrationFeeOption === 0) {
    baseFeeBps = 25;
    cliffFeeNumerator = new BN(2500000);
  } else if (migrationFeeOption === 1) {
    cliffFeeNumerator = new BN(3000000);
    baseFeeBps = 30;
  } else if (migrationFeeOption === 2) {
    baseFeeBps = 100;
    cliffFeeNumerator = new BN(10000000);
  } else if (migrationFeeOption === 3) {
    baseFeeBps = 200;
    cliffFeeNumerator = new BN(20000000);
  } else if (migrationFeeOption === 4) {
    baseFeeBps = 400;
    cliffFeeNumerator = new BN(40000000);
  } else if (migrationFeeOption === 5) {
    baseFeeBps = 600;
    cliffFeeNumerator = new BN(60000000);
  }
  const dynamicFeeParams = getDynamicFeeParams(baseFeeBps);

  const [config] = PublicKey.findProgramAddressSync(
    [Buffer.from('config'), new BN(0).toBuffer('le', 8)],
    DAMM_V2_PROGRAM_ID
  );

  const configParameters = {
    poolFees: {
      baseFee: {
        cliffFeeNumerator,
        numberOfPeriod: 0,
        periodFrequency: new BN(0),
        reductionFactor: new BN(0),
        feeSchedulerMode: 0,
      },
      padding: [0, 0, 0],
      dynamicFee: dynamicFeeParams,
    },
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    vaultConfigKey: PublicKey.default,
    poolCreatorAuthority,
    collectFeeMode: 1,
    activationType: 0,
  };

  const transaction = await program.methods
    .createConfig(new BN(0), configParameters)
    .accountsPartial({
      config,
      admin: payer.publicKey,
    })
    .transaction();

  const { blockhash } = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(payer);
  await connection.sendRawTransaction(transaction.serialize());

  return config;
}
