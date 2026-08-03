import { Connection, PublicKey, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import {
  DynamicFeeSharingClient,
  deriveFeeVaultPdaAddress,
  getTokenProgram,
  checkPositionOwnership,
} from '@meteora-ag/dynamic-fee-sharing-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import BN from 'bn.js';
import { FeeSharingConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import {
  DEFAULT_COMMITMENT_LEVEL,
  DEFAULT_SEND_TX_MAX_RETRIES,
  SOL_TOKEN_MINT,
} from '../../utils/constants';
import { loadFeeVault } from './status';

/**
 * 0-SOL fee-payer guard, shared by every write action below. Returns the balance (lamports) so
 * fund() can reuse it for the native-SOL wrap sufficiency check.
 */
async function assertFunded(connection: Connection, payer: PublicKey): Promise<number> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
  return balance;
}

/**
 * Create a Dynamic Fee Sharing vault for `baseMint` (the token whose fees will be shared).
 * Reads config.feeSharingCreate: `userShares` (2-5 recipients, `share` a relative integer
 * weight — NOT required to sum to 100, docs.md-verified min/max enforced here pre-flight) and
 * `useKeypairVault` (true = createFeeVault, a fresh `feeVault` KEYPAIR co-signs once and IS the
 * vault address; false = createFeeVaultPda, a fresh `base` keypair co-signs once and the vault
 * address is a PDA derived from base + tokenMint). Either way a brand-new keypair is generated
 * in-memory purely to co-sign this one transaction — only the resulting vault ADDRESS matters
 * afterward (logged prominently below), the keypair's secret is never needed again.
 */
export async function createVault(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey
) {
  if (!config.feeSharingCreate) {
    throw new Error('Missing feeSharingCreate in configuration');
  }
  const { userShares, useKeypairVault } = config.feeSharingCreate;

  if (!Array.isArray(userShares) || userShares.length === 0) {
    throw new Error('feeSharingCreate.userShares must be a non-empty array');
  }
  if (userShares.length < 2 || userShares.length > 5) {
    throw new Error(
      `feeSharingCreate.userShares has ${userShares.length} entries — the program requires at ` +
        'least 2 and at most 5 recipients per fee vault.'
    );
  }

  const userShare = userShares.map((entry, index) => {
    if (typeof entry.share !== 'number' || !Number.isInteger(entry.share) || entry.share <= 0) {
      throw new Error(
        `feeSharingCreate.userShares[${index}].share must be a positive integer (got ${entry.share}).`
      );
    }
    try {
      return { address: new PublicKey(entry.address), share: entry.share };
    } catch {
      throw new Error(
        `feeSharingCreate.userShares[${index}].address is not a valid public key: ${entry.address}`
      );
    }
  });

  console.log('\n> Initializing Dynamic Fee Sharing vault creation...');
  await assertFunded(connection, wallet.publicKey);

  const mintAccountInfo = await connection.getAccountInfo(baseMint);
  if (!mintAccountInfo) {
    throw new Error(`Base mint account not found: ${baseMint.toString()}`);
  }
  const tokenProgram = mintAccountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  console.log(`- Base mint ${baseMint.toString()}`);
  console.log(
    `- Token program: ${tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token'}`
  );
  console.log(`- Recipients (${userShare.length}):`);
  for (const entry of userShare) {
    console.log(`  - ${entry.address.toString()} : share ${entry.share}`);
  }

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);

  const coSigner = Keypair.generate();
  const vaultAddress = useKeypairVault
    ? coSigner.publicKey
    : deriveFeeVaultPdaAddress(coSigner.publicKey, baseMint);

  console.log(
    `- Vault variant: ${useKeypairVault ? 'KEYPAIR (fresh feeVault keypair co-signs once)' : 'PDA (fresh base keypair co-signs once)'}`
  );

  const createTx = useKeypairVault
    ? await client.createFeeVault({
        feeVault: vaultAddress,
        tokenMint: baseMint,
        tokenProgram,
        owner: wallet.publicKey,
        payer: wallet.publicKey,
        userShare,
      })
    : await client.createFeeVaultPda({
        base: coSigner.publicKey,
        tokenMint: baseMint,
        tokenProgram,
        owner: wallet.publicKey,
        payer: wallet.publicKey,
        userShare,
      });

  modifyComputeUnitPriceIx(createTx, config.computeUnitPriceMicroLamports ?? 0);

  console.log(`\n>>> FEE VAULT ADDRESS: ${vaultAddress.toString()}`);
  if (config.dryRun) {
    console.log(
      '>>> DRY RUN — this address is a placeholder from a throwaway keypair. A NEW address will'
    );
    console.log('>>> be generated and printed when you run with dryRun=false. Do NOT save it.\n');
  } else {
    console.log('>>> Save this — every other fee-sharing-* action needs it via --vault.\n');
  }

  if (config.dryRun) {
    console.log('> Simulating fee vault creation transaction...');
    await runSimulateTransaction(connection, [wallet.payer, coSigner], wallet.publicKey, [
      createTx,
    ]);
    console.log('> Fee vault creation simulation successful');
  } else {
    console.log('>> Sending fee vault creation transaction...');
    const txHash = await sendAndConfirmTransaction(connection, createTx, [wallet.payer, coSigner], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Fee vault created successfully with tx hash: ${txHash}`);
    console.log(`>>> FEE VAULT ADDRESS: ${vaultAddress.toString()}`);
  }
}

/**
 * Directly fund a fee vault from the wallet's own token account. Reads config.feeSharingFund.
 * amount (the vault's tokenMint human units, converted via the mint's own decimals). wSOL
 * note (verified against the SDK's compiled `fundFeeVault`): when the vault's tokenMint is
 * native SOL's wrapped mint, the SDK wraps the requested amount of SOL for you internally — no
 * pre-funded wSOL account is needed, only enough actual SOL lamports in the wallet.
 */
export async function fund(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.feeSharingFund) {
    throw new Error('Missing feeSharingFund in configuration');
  }
  const { amount } = config.feeSharingFund;

  console.log('\n> Initializing Dynamic Fee Sharing fund...');
  const payerBalance = await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  const tokenProgram = getTokenProgram(feeVaultState.tokenFlag);
  const mint = await getMint(
    connection,
    feeVaultState.tokenMint,
    connection.commitment,
    tokenProgram
  );
  const decimals = mint.decimals;

  console.log(`- Vault ${vault.toString()}`);
  console.log(`- Token mint ${feeVaultState.tokenMint.toString()} (${decimals} decimals)`);

  const amountLamports = getAmountInLamports(amount, decimals);
  const isNativeSol = feeVaultState.tokenMint.equals(SOL_TOKEN_MINT);

  if (isNativeSol) {
    console.log(
      '- Token mint is native SOL (wSOL) — fundFeeVault wraps the requested amount of SOL for ' +
        'you internally; no pre-funded wSOL account is needed.'
    );
    if (payerBalance < Number(amountLamports.toString())) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} has ${payerBalance} lamports of SOL but funding ` +
          `${amount} SOL needs ${amountLamports.toString()} lamports to wrap, plus a little more ` +
          'for rent and fees — fund the wallet with more SOL first.'
      );
    }
  } else {
    const funderATA = getAssociatedTokenAddressSync(
      feeVaultState.tokenMint,
      wallet.publicKey,
      true,
      tokenProgram
    );
    let funderBalance = new BN(0);
    try {
      const account = await getAccount(connection, funderATA, connection.commitment, tokenProgram);
      funderBalance = new BN(account.amount.toString());
    } catch (error) {
      if (
        !(error instanceof TokenAccountNotFoundError) &&
        !(error instanceof TokenInvalidAccountOwnerError)
      ) {
        throw error;
      }
    }
    if (funderBalance.lt(amountLamports)) {
      throw new Error(
        `Wallet ${wallet.publicKey.toString()} holds ${getAmountInTokens(funderBalance, decimals)} of mint ` +
          `${feeVaultState.tokenMint.toString()} but funding needs ${amount} — fund the wallet's token account first.`
      );
    }
  }

  console.log(`- Funding ${amount} (${amountLamports.toString()} base units)`);

  const fundTx = await client.fundFeeVault({
    fundAmount: amountLamports,
    feeVault: vault,
    funder: wallet.publicKey,
    feeVaultState,
  });
  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund simulation successful');
  } else {
    console.log('\n>> Sending fund transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded successfully with tx hash: ${txHash}`);
  }
}

/**
 * Fund a fee vault by sweeping fees straight out of a DAMM v2 position (`fundByClaimDammV2Fee`).
 * Resolves the wallet's position(s) on `poolAddress` via `cpAmm.getUserPositionByPool` (same
 * lookup `damm_v2` actions use), then picks the first one whose position-NFT account is already
 * owned by the fee vault — verified via the SDK's own `checkPositionOwnership` helper, since
 * DAMM v2 position NFTs are always Token-2022 (matches the SDK's internal call for this exact
 * bridge). Ownership must already have been transferred to the vault (the SDK's
 * `setTokenAccountOwnerTx` helper, a one-time manual step outside this action's scope) — if no
 * candidate position qualifies, this throws a clear, actionable error instead of attempting a
 * doomed transaction.
 */
export async function fundFromDammV2(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  poolAddress: PublicKey
) {
  console.log('\n> Initializing Dynamic Fee Sharing fund-from-DAMM-v2...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  await loadFeeVault(client, vault);

  const cpAmm = new CpAmm(connection);
  const userPositions = await cpAmm.getUserPositionByPool(poolAddress, wallet.publicKey);
  if (userPositions.length === 0) {
    throw new Error(
      `No DAMM v2 position found for wallet ${wallet.publicKey.toString()} on pool ${poolAddress.toString()}.`
    );
  }

  console.log(`- Pool ${poolAddress.toString()}`);
  console.log(`- Found ${userPositions.length} position(s) for this wallet on the pool`);

  let chosen: (typeof userPositions)[number] | undefined;
  for (const position of userPositions) {
    const isOwnedByVault = await checkPositionOwnership(
      connection,
      DEFAULT_COMMITMENT_LEVEL,
      position.positionNftAccount,
      vault,
      TOKEN_2022_PROGRAM_ID
    );
    if (isOwnedByVault) {
      chosen = position;
      break;
    }
  }

  if (!chosen) {
    throw new Error(
      `None of this wallet's DAMM v2 position NFTs on pool ${poolAddress.toString()} are owned ` +
        `by fee vault ${vault.toString()} yet. Transfer the position NFT account's owner to the ` +
        "fee vault first (the SDK's setTokenAccountOwnerTx helper) before running " +
        `fee-sharing-fund-from-damm-v2. Candidate position(s) checked: ` +
        userPositions.map((p) => p.position.toString()).join(', ')
    );
  }

  console.log(
    `- Position ${chosen.position.toString()} (NFT account ${chosen.positionNftAccount.toString()}) ` +
      'is owned by the fee vault — sweeping its fees in'
  );

  const fundTx = await client.fundByClaimDammV2Fee({
    signer: wallet.publicKey,
    owner: wallet.publicKey,
    feeVault: vault,
    dammV2Pool: poolAddress,
    dammV2Position: chosen.position,
    dammV2PositionNftAccount: chosen.positionNftAccount,
  });
  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund-from-DAMM-v2 transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund-from-DAMM-v2 simulation successful');
  } else {
    console.log('\n>> Sending fund-from-DAMM-v2 transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded from DAMM v2 successfully with tx hash: ${txHash}`);
  }
}

/**
 * Fund a fee vault by sweeping fees out of a DBC pool. Reads config.feeSharingFundDbc: `role`
 * ("creator" | "partner") x `source` ("tradingFee" | "surplus" | "migrationFee") routes to the
 * matching bridge — ALWAYS the `2`-suffixed trading-fee variants
 * (`fundByClaimDbcCreatorTradingFee2` / `fundByClaimDbcPartnerTradingFee2`), never the
 * unsuffixed ones. The DBC pool is resolved from `baseMint` via
 * `DynamicBondingCurveClient.state.getPoolByBaseMint`, mirroring `lib/dbc`. The fee vault must
 * already be set as the pool config's creator (role "creator") or feeClaimer (role "partner")
 * — the SDK itself validates this and throws a clear `InvalidCreator` / `InvalidFeeClaimer`
 * error otherwise.
 */
export async function fundFromDbc(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey,
  baseMint: PublicKey
) {
  if (!config.feeSharingFundDbc) {
    throw new Error('Missing feeSharingFundDbc in configuration');
  }
  const { role, source } = config.feeSharingFundDbc;
  if (role !== 'creator' && role !== 'partner') {
    throw new Error(`feeSharingFundDbc.role must be "creator" or "partner" (got "${role}")`);
  }
  if (source !== 'tradingFee' && source !== 'surplus' && source !== 'migrationFee') {
    throw new Error(
      `feeSharingFundDbc.source must be "tradingFee", "surplus", or "migrationFee" (got "${source}")`
    );
  }

  console.log('\n> Initializing Dynamic Fee Sharing fund-from-DBC...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  await loadFeeVault(client, vault);

  const dbcClient = new DynamicBondingCurveClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const pool = await dbcClient.state.getPoolByBaseMint(baseMint);
  if (!pool) {
    throw new Error(`No DBC pool found for base mint ${baseMint.toString()}`);
  }
  const virtualPool = pool.publicKey;
  const poolConfig = pool.account.poolState.config;

  console.log(`- DBC pool ${virtualPool.toString()}`);
  console.log(`- DBC pool config ${poolConfig.toString()}`);
  console.log(`- Role: ${role} | Source: ${source}`);

  let fundTx;
  if (source === 'tradingFee') {
    fundTx =
      role === 'creator'
        ? await client.fundByClaimDbcCreatorTradingFee2({
            signer: wallet.publicKey,
            creator: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          })
        : await client.fundByClaimDbcPartnerTradingFee2({
            signer: wallet.publicKey,
            feeClaimer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          });
  } else if (source === 'surplus') {
    fundTx =
      role === 'creator'
        ? await client.fundByWithdrawDbcCreatorSurplus({
            signer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          })
        : await client.fundByWithdrawDbcPartnerSurplus({
            signer: wallet.publicKey,
            feeVault: vault,
            poolConfig,
            virtualPool,
          });
  } else {
    fundTx = await client.fundByWithdrawDbcMigrationFee({
      signer: wallet.publicKey,
      isPartner: role === 'partner',
      feeVault: vault,
      poolConfig,
      virtualPool,
    });
  }

  modifyComputeUnitPriceIx(fundTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating fund-from-DBC transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [fundTx]);
    console.log('> Fund-from-DBC simulation successful');
  } else {
    console.log('\n>> Sending fund-from-DBC transaction...');
    const txHash = await sendAndConfirmTransaction(connection, fundTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Funded from DBC successfully with tx hash: ${txHash}`);
  }
}

/**
 * Claim the wallet's own share of a fee vault via `claimUserFee2` (receiver = the wallet; the
 * `2`-variant's receiver does not need to sign, unlike `claimUserFee`). Prints the wallet's
 * allocated/claimed/claimable amounts first and refuses to send a pointless transaction when
 * nothing is claimable yet.
 */
export async function claim(
  config: FeeSharingConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Dynamic Fee Sharing claim...');
  await assertFunded(connection, wallet.publicKey);

  const client = new DynamicFeeSharingClient(connection, DEFAULT_COMMITMENT_LEVEL);
  const feeVaultState = await loadFeeVault(client, vault);
  const tokenProgram = getTokenProgram(feeVaultState.tokenFlag);
  const mint = await getMint(
    connection,
    feeVaultState.tokenMint,
    connection.commitment,
    tokenProgram
  );
  const decimals = mint.decimals;

  console.log(`- Vault ${vault.toString()}`);

  const breakdown = await client.getFeeBreakdown(vault);
  const userRow = breakdown.userFees.find((user) => user.address.equals(wallet.publicKey));
  if (!userRow) {
    throw new Error(
      `Wallet ${wallet.publicKey.toString()} does not hold a share in fee vault ${vault.toString()}.`
    );
  }

  console.log(`- Total allocated: ${getAmountInTokens(userRow.totalFee, decimals)}`);
  console.log(`- Already claimed: ${getAmountInTokens(userRow.feeClaimed, decimals)}`);
  console.log(`- Claimable now:   ${getAmountInTokens(userRow.feeUnclaimed, decimals)}`);

  if (userRow.feeUnclaimed.lten(0)) {
    throw new Error(`Nothing to claim right now for wallet ${wallet.publicKey.toString()}.`);
  }

  const claimTx = await client.claimUserFee2({
    feeVault: vault,
    user: wallet.publicKey,
    payer: wallet.publicKey,
    receiver: wallet.publicKey,
  });
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);

  if (config.dryRun) {
    console.log('\n> Simulating claim transaction...');
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [claimTx]);
    console.log('> Claim simulation successful');
  } else {
    console.log('\n>> Sending claim transaction...');
    const txHash = await sendAndConfirmTransaction(connection, claimTx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> Claimed successfully with tx hash: ${txHash}`);
  }
}
