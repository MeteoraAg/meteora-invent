import { Connection, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  safeParseKeypairFromFile,
  parseConfigFromCli,
  modifyComputeUnitPriceIx,
} from '../../helpers';
import { Wallet } from '@coral-xyz/anchor';
import BN from 'bn.js';
import AmmImpl from '@meteora-ag/dynamic-amm-sdk';
import { SEEDS } from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/constants';
import {
  deriveCustomizablePermissionlessConstantProductPoolAddress,
  createProgram,
  getAssociatedTokenAccount,
} from '@meteora-ag/dynamic-amm-sdk/dist/cjs/src/amm/utils';
import { deriveFeeVault } from '@meteora-ag/m3m3';
import { AllocationByAmount, LockLiquidityAllocation, DammV1Config } from '../../utils/types';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DEFAULT_SEND_TX_MAX_RETRIES,
  STAKE2EARN_PROGRAM_IDS,
} from '../../utils/constants';

async function main() {
  const config = (await parseConfigFromCli()) as DammV1Config;

  console.log(`> Using keypair file path ${config.keypairFilePath}`);
  const keypair = await safeParseKeypairFromFile(config.keypairFilePath);

  console.log('\n> Initializing with general configuration...');
  console.log(`- Using RPC URL ${config.rpcUrl}`);
  console.log(`- Dry run = ${config.dryRun}`);
  console.log(`- Using payer ${keypair.publicKey} to execute commands`);

  const connection = new Connection(config.rpcUrl, DEFAULT_COMMITMENT_LEVEL);
  const wallet = new Wallet(keypair);

  if (!config.baseMint) {
    throw new Error('Missing baseMint in configuration');
  }
  const baseMint = new PublicKey(config.baseMint);
  const quoteMint = new PublicKey(config.quoteMint);

  console.log(`- Using base token mint ${baseMint.toString()}`);
  console.log(`- Using quote token mint ${quoteMint.toString()}`);

  const poolKey = deriveCustomizablePermissionlessConstantProductPoolAddress(
    baseMint,
    quoteMint,
    createProgram(connection as any).ammProgram.programId
  );
  console.log(`- Pool address: ${poolKey}`);

  const stake2EarnProgramId = new PublicKey(STAKE2EARN_PROGRAM_IDS['mainnet-beta']);
  const stake2EarnVaultPubkey = deriveFeeVault(poolKey, stake2EarnProgramId);
  console.log(`- Stake2Earn fee vault ${stake2EarnVaultPubkey}`);

  if (!config.lockLiquidity) {
    throw new Error('Missing lockLiquidity configuration');
  }
  if (config.lockLiquidity.allocations.length == 0) {
    throw new Error('Missing allocations in lockLiquidity configuration');
  }

  const [lpMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(SEEDS.LP_MINT), poolKey.toBuffer()],
    createProgram(connection as any).ammProgram.programId
  );
  const payerPoolLp = getAssociatedTokenAccount(lpMint, wallet.publicKey);
  const payerPoolLpBalance = (
    await connection.getTokenAccountBalance(payerPoolLp, connection.commitment)
  ).value.amount;
  console.log('- payerPoolLpBalance %s', payerPoolLpBalance.toString());

  const allocationByAmounts = fromAllocationsToAmount(
    new BN(payerPoolLpBalance),
    config.lockLiquidity.allocations
  );

  // validate allocations should contains stake2earn fee farm address
  const allocationContainsFeeFarmAddress = config.lockLiquidity.allocations.some((allocation) =>
    new PublicKey(allocation.address).equals(stake2EarnVaultPubkey)
  );
  if (!allocationContainsFeeFarmAddress) {
    throw new Error('Lock liquidity allocations does not contain Stake2Earn fee farm address');
  }

  const pool = await AmmImpl.create(connection as any, poolKey);

  for (const allocation of allocationByAmounts) {
    console.log('\n> Lock liquidity %s', allocation.address.toString());
    const tx = await pool.lockLiquidity(allocation.address, allocation.amount, wallet.publicKey);
    modifyComputeUnitPriceIx(tx as any, config.computeUnitPriceMicroLamports);

    if (config.dryRun) {
      console.log(
        `\n> Simulating lock liquidty tx for address ${allocation.address} with amount = ${allocation.amount}... / percentage = ${allocation.percentage}`
      );
    } else {
      const txHash = await sendAndConfirmTransaction(connection, tx as any, [wallet.payer], {
        commitment: DEFAULT_COMMITMENT_LEVEL,
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

function fromAllocationsToAmount(
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
    const amount = lpAmount.mul(new BN(allocations[i].percentage)).div(new BN(sumPercentage));
    sum = sum.add(amount);
    amounts.push({
      address: new PublicKey(allocations[i].address),
      amount,
      percentage: allocations[i].percentage,
    });
  }
  // the last wallet get remaining amount
  amounts.push({
    address: new PublicKey(allocations[allocations.length - 1].address),
    amount: lpAmount.sub(sum),
    percentage: allocations[allocations.length - 1].percentage,
  });
  return amounts;
}

main();
