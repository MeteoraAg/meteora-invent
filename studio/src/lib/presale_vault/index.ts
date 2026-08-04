import { Wallet } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { PresaleVaultConfig, PresaleVaultTypeConfig, PresaleConfig } from '../../utils/types';
import {
  Presale,
  derivePresale,
  PRESALE_PROGRAM_ID,
  Rounding,
  getOnChainTimestamp,
} from '@meteora-ag/presale';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { runSimulateTransaction } from '../../helpers/transaction';
import { getRounding } from '../../helpers/utils';
import { validatePresaleConfigFields } from '../../helpers/config-validation';

export async function createFcfsPresaleVault(
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: PresaleVaultConfig,
  dryRun: boolean
) {
  // Validate config before executing any actions
  validatePresaleConfigFields(params);
  console.log(`\n> Initializing FCFS Presale...`);
  console.log(`- Using baseMint: ${baseMint.toBase58()}`);
  console.log(`- Using quoteMint: ${quoteMint.toBase58()}`);

  console.log(`- Generating new base keypair`);
  const baseKeypair = Keypair.generate();
  console.log(`- Base public key: ${baseKeypair.publicKey.toBase58()}`);

  const presaleRegistriesArgs = params.presaleRegistries.map((registry) => ({
    presaleSupply: new BN(registry.presaleSupply),
    buyerMaximumDepositCap: new BN(registry.buyerMaximumDepositCap),
    buyerMinimumDepositCap: new BN(registry.buyerMinimumDepositCap),
    depositFeeBps: new BN(registry.depositFeeBps),
  }));

  console.log(`\n> Presale Registries (${presaleRegistriesArgs.length} tier(s)):`);
  presaleRegistriesArgs.forEach((registry, index) => {
    console.log(`  Tier ${index + 1}:`);
    console.log(`    - Supply: ${registry.presaleSupply.toString()}`);
    console.log(`    - Max deposit cap: ${registry.buyerMaximumDepositCap.toString()}`);
    console.log(`    - Min deposit cap: ${registry.buyerMinimumDepositCap.toString()}`);
    console.log(`    - Deposit fee (bps): ${registry.depositFeeBps.toString()}`);
  });

  const presaleArgs = {
    presaleMaximumCap: new BN(params.presaleArgs.presaleMaximumCap),
    presaleMinimumCap: new BN(params.presaleArgs.presaleMinimumCap),
    presaleStartTime: new BN(params.presaleArgs.presaleStartTime),
    presaleEndTime: new BN(params.presaleArgs.presaleEndTime),
    whitelistMode: params.presaleArgs.whitelistMode,
    unsoldTokenAction: params.presaleArgs.unsoldTokenAction,
    disableEarlierPresaleEndOnceCapReached:
      params.presaleArgs.disableEarlierPresaleEndOnceCapReached ?? false,
  };

  console.log(`\n> Presale Configuration:`);
  console.log(`  - Maximum cap: ${presaleArgs.presaleMaximumCap.toString()}`);
  console.log(`  - Minimum cap: ${presaleArgs.presaleMinimumCap.toString()}`);
  console.log(
    `  - Start time: ${presaleArgs.presaleStartTime.toString()} (${presaleArgs.presaleStartTime.toNumber() === 0 ? 'immediate' : new Date(presaleArgs.presaleStartTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - End time: ${presaleArgs.presaleEndTime.toString()} (${new Date(presaleArgs.presaleEndTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - Whitelist mode: ${presaleArgs.whitelistMode} (0=permissionless, 1=merkle_proof, 2=authority)`
  );
  console.log(`  - Unsold token action: ${presaleArgs.unsoldTokenAction} (0=refund, 1=burn)`);

  let lockedVestingArgs;
  if (params.lockedVestingArgs) {
    lockedVestingArgs = {
      lockDuration: new BN(params.lockedVestingArgs.lockDuration),
      vestDuration: new BN(params.lockedVestingArgs.vestDuration),
      immediateReleaseBps: new BN(params.lockedVestingArgs.immediateReleaseBps),
      // SDK examples default the immediate-release timing to the presale end
      immediateReleaseTimestamp:
        params.lockedVestingArgs.immediateReleaseTimestamp != null
          ? new BN(params.lockedVestingArgs.immediateReleaseTimestamp)
          : new BN(params.presaleArgs.presaleEndTime),
    };

    console.log(`\n> Locked Vesting Configuration:`);
    console.log(`  - Lock duration: ${lockedVestingArgs.lockDuration.toString()} seconds`);
    console.log(`  - Vest duration: ${lockedVestingArgs.vestDuration.toString()} seconds`);
    console.log(
      `  - Immediate release: ${lockedVestingArgs.immediateReleaseBps.toString()} bps (${lockedVestingArgs.immediateReleaseBps.toNumber() / 100}%)`
    );
  }

  console.log(`\n> Creating FCFS presale transaction...`);
  const initializeFcfsPresaleTx = await Presale.createFcfsPresale(connection, PRESALE_PROGRAM_ID, {
    baseMintPubkey: baseMint,
    quoteMintPubkey: quoteMint,
    basePubkey: baseKeypair.publicKey,
    creatorPubkey: wallet.publicKey,
    feePayerPubkey: wallet.publicKey,
    presaleRegistries: presaleRegistriesArgs,
    presaleArgs,
    lockedVestingArgs,
  });

  initializeFcfsPresaleTx.sign(wallet.payer, baseKeypair);

  if (dryRun) {
    console.log(`\n> Simulating presale initialization...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      initializeFcfsPresaleTx,
    ]);
  } else {
    console.log(`>> Sending presale initialization transaction...`);
    const txSig = await connection.sendRawTransaction(initializeFcfsPresaleTx.serialize());
    console.log(`>>> Transaction sent: ${txSig}`);

    console.log(`>>> Confirming transaction...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFcfsPresaleTx.lastValidBlockHeight!,
        blockhash: initializeFcfsPresaleTx.recentBlockhash!,
      },
      'confirmed'
    );

    console.log(`>>> Waiting for finalization...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFcfsPresaleTx.lastValidBlockHeight!,
        blockhash: initializeFcfsPresaleTx.recentBlockhash!,
      },
      'finalized'
    );

    const presaleAddress = derivePresale(
      baseMint,
      quoteMint,
      baseKeypair.publicKey,
      PRESALE_PROGRAM_ID
    );

    console.log(`\n✅ Presale initialized successfully!`);
    console.log(`   Transaction: ${txSig}`);
    console.log(`   Presale Address: ${presaleAddress.toBase58()}`);

    try {
      const presaleInstance = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
      console.log(`\n> Presale State:`);
      console.log(JSON.stringify(presaleInstance.presaleAccount, null, 2));
    } catch (err) {
      console.warn('Could not fetch presale state:', err);
    }
  }
}

export async function createProrataPresaleVault(
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: PresaleVaultConfig,
  dryRun: boolean
) {
  console.log(`\n> Initializing Prorata Presale...`);
  console.log(`- Using baseMint: ${baseMint.toBase58()}`);
  console.log(`- Using quoteMint: ${quoteMint.toBase58()}`);

  console.log(`- Generating new base keypair`);
  const baseKeypair = Keypair.generate();
  console.log(`- Base public key: ${baseKeypair.publicKey.toBase58()}`);

  const presaleRegistriesArgs = params.presaleRegistries.map((registry) => ({
    presaleSupply: new BN(registry.presaleSupply),
    buyerMaximumDepositCap: new BN(registry.buyerMaximumDepositCap),
    buyerMinimumDepositCap: new BN(registry.buyerMinimumDepositCap),
    depositFeeBps: new BN(registry.depositFeeBps),
  }));

  console.log(`\n> Presale Registries (${presaleRegistriesArgs.length} tier(s)):`);
  presaleRegistriesArgs.forEach((registry, index) => {
    console.log(`  Tier ${index + 1}:`);
    console.log(`    - Supply: ${registry.presaleSupply.toString()}`);
    console.log(`    - Max deposit cap: ${registry.buyerMaximumDepositCap.toString()}`);
    console.log(`    - Min deposit cap: ${registry.buyerMinimumDepositCap.toString()}`);
    console.log(`    - Deposit fee (bps): ${registry.depositFeeBps.toString()}`);
  });

  const presaleArgs = {
    presaleMaximumCap: new BN(params.presaleArgs.presaleMaximumCap),
    presaleMinimumCap: new BN(params.presaleArgs.presaleMinimumCap),
    presaleStartTime: new BN(params.presaleArgs.presaleStartTime),
    presaleEndTime: new BN(params.presaleArgs.presaleEndTime),
    whitelistMode: params.presaleArgs.whitelistMode,
    unsoldTokenAction: params.presaleArgs.unsoldTokenAction,
    disableEarlierPresaleEndOnceCapReached:
      params.presaleArgs.disableEarlierPresaleEndOnceCapReached ?? false,
  };

  console.log(`\n> Presale Configuration:`);
  console.log(`  - Maximum cap: ${presaleArgs.presaleMaximumCap.toString()}`);
  console.log(`  - Minimum cap: ${presaleArgs.presaleMinimumCap.toString()}`);
  console.log(
    `  - Start time: ${presaleArgs.presaleStartTime.toString()} (${presaleArgs.presaleStartTime.toNumber() === 0 ? 'immediate' : new Date(presaleArgs.presaleStartTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - End time: ${presaleArgs.presaleEndTime.toString()} (${new Date(presaleArgs.presaleEndTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - Whitelist mode: ${presaleArgs.whitelistMode} (0=permissionless, 1=merkle_proof, 2=authority)`
  );
  console.log(`  - Unsold token action: ${presaleArgs.unsoldTokenAction} (0=refund, 1=burn)`);

  let lockedVestingArgs;
  if (params.lockedVestingArgs) {
    lockedVestingArgs = {
      lockDuration: new BN(params.lockedVestingArgs.lockDuration),
      vestDuration: new BN(params.lockedVestingArgs.vestDuration),
      immediateReleaseBps: new BN(params.lockedVestingArgs.immediateReleaseBps),
      // SDK examples default the immediate-release timing to the presale end
      immediateReleaseTimestamp:
        params.lockedVestingArgs.immediateReleaseTimestamp != null
          ? new BN(params.lockedVestingArgs.immediateReleaseTimestamp)
          : new BN(params.presaleArgs.presaleEndTime),
    };

    console.log(`\n> Locked Vesting Configuration:`);
    console.log(`  - Lock duration: ${lockedVestingArgs.lockDuration.toString()} seconds`);
    console.log(`  - Vest duration: ${lockedVestingArgs.vestDuration.toString()} seconds`);
    console.log(
      `  - Immediate release: ${lockedVestingArgs.immediateReleaseBps.toString()} bps (${lockedVestingArgs.immediateReleaseBps.toNumber() / 100}%)`
    );
  }

  console.log(`\n> Creating Prorata presale transaction...`);
  const initializeProrataPresaleTx = await Presale.createProrataPresale(
    connection,
    PRESALE_PROGRAM_ID,
    {
      baseMintPubkey: baseMint,
      quoteMintPubkey: quoteMint,
      basePubkey: baseKeypair.publicKey,
      creatorPubkey: wallet.publicKey,
      feePayerPubkey: wallet.publicKey,
      presaleRegistries: presaleRegistriesArgs,
      presaleArgs,
      lockedVestingArgs,
    }
  );

  initializeProrataPresaleTx.sign(wallet.payer, baseKeypair);

  if (dryRun) {
    console.log(`\n> Simulating presale initialization...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      initializeProrataPresaleTx,
    ]);
  } else {
    console.log(`>> Sending presale initialization transaction...`);
    const txSig = await connection.sendRawTransaction(initializeProrataPresaleTx.serialize());
    console.log(`>>> Transaction sent: ${txSig}`);

    console.log(`>>> Confirming transaction...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeProrataPresaleTx.lastValidBlockHeight!,
        blockhash: initializeProrataPresaleTx.recentBlockhash!,
      },
      'confirmed'
    );

    console.log(`>>> Waiting for finalization...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeProrataPresaleTx.lastValidBlockHeight!,
        blockhash: initializeProrataPresaleTx.recentBlockhash!,
      },
      'finalized'
    );

    const presaleAddress = derivePresale(
      baseMint,
      quoteMint,
      baseKeypair.publicKey,
      PRESALE_PROGRAM_ID
    );

    console.log(`\n✅ Presale initialized successfully!`);
    console.log(`   Transaction: ${txSig}`);
    console.log(`   Presale Address: ${presaleAddress.toBase58()}`);

    try {
      const presaleInstance = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
      console.log(`\n> Presale State:`);
      console.log(JSON.stringify(presaleInstance.presaleAccount, null, 2));
    } catch (err) {
      console.warn('Could not fetch presale state:', err);
    }
  }
}

export async function createFixedPricePresaleVault(
  connection: Connection,
  wallet: Wallet,
  baseMint: PublicKey,
  quoteMint: PublicKey,
  params: PresaleVaultConfig,
  dryRun: boolean
) {
  console.log(`\n> Initializing Fixed Price Presale...`);
  console.log(`- Using baseMint: ${baseMint.toBase58()}`);
  console.log(`- Using quoteMint: ${quoteMint.toBase58()}`);

  if (params.fixedPricePresaleConfig?.price === undefined) {
    throw new Error('Price is required for fixed price presale');
  }

  const rounding = getRounding(params.fixedPricePresaleConfig?.rounding ?? 'down');
  const price = new Decimal(params.fixedPricePresaleConfig?.price ?? 0);

  console.log(`\n> Fixed Price Configuration:`);
  console.log(`  - Price: ${price.toString()}`);
  console.log(`  - Rounding: ${rounding} (${rounding === Rounding.Up ? 'up' : 'down'})`);

  console.log(`\n- Generating new base keypair`);
  const baseKeypair = Keypair.generate();
  console.log(`- Base public key: ${baseKeypair.publicKey.toBase58()}`);

  const presaleRegistriesArgs = params.presaleRegistries.map((registry) => ({
    presaleSupply: new BN(registry.presaleSupply),
    buyerMaximumDepositCap: new BN(registry.buyerMaximumDepositCap),
    buyerMinimumDepositCap: new BN(registry.buyerMinimumDepositCap),
    depositFeeBps: new BN(registry.depositFeeBps),
  }));

  console.log(`\n> Presale Registries (${presaleRegistriesArgs.length} tier(s)):`);
  presaleRegistriesArgs.forEach((registry, index) => {
    console.log(`  Tier ${index + 1}:`);
    console.log(`    - Supply: ${registry.presaleSupply.toString()}`);
    console.log(`    - Max deposit cap: ${registry.buyerMaximumDepositCap.toString()}`);
    console.log(`    - Min deposit cap: ${registry.buyerMinimumDepositCap.toString()}`);
    console.log(`    - Deposit fee (bps): ${registry.depositFeeBps.toString()}`);
  });

  const presaleArgs = {
    presaleMaximumCap: new BN(params.presaleArgs.presaleMaximumCap),
    presaleMinimumCap: new BN(params.presaleArgs.presaleMinimumCap),
    presaleStartTime: new BN(params.presaleArgs.presaleStartTime),
    presaleEndTime: new BN(params.presaleArgs.presaleEndTime),
    whitelistMode: params.presaleArgs.whitelistMode,
    unsoldTokenAction: params.presaleArgs.unsoldTokenAction,
    disableEarlierPresaleEndOnceCapReached:
      params.presaleArgs.disableEarlierPresaleEndOnceCapReached ?? false,
  };

  console.log(`\n> Presale Configuration:`);
  console.log(`  - Maximum cap: ${presaleArgs.presaleMaximumCap.toString()}`);
  console.log(`  - Minimum cap: ${presaleArgs.presaleMinimumCap.toString()}`);
  console.log(
    `  - Start time: ${presaleArgs.presaleStartTime.toString()} (${presaleArgs.presaleStartTime.toNumber() === 0 ? 'immediate' : new Date(presaleArgs.presaleStartTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - End time: ${presaleArgs.presaleEndTime.toString()} (${new Date(presaleArgs.presaleEndTime.toNumber() * 1000).toISOString()})`
  );
  console.log(
    `  - Whitelist mode: ${presaleArgs.whitelistMode} (0=permissionless, 1=merkle_proof, 2=authority)`
  );
  console.log(`  - Unsold token action: ${presaleArgs.unsoldTokenAction} (0=refund, 1=burn)`);

  let lockedVestingArgs;
  if (params.lockedVestingArgs) {
    lockedVestingArgs = {
      lockDuration: new BN(params.lockedVestingArgs.lockDuration),
      vestDuration: new BN(params.lockedVestingArgs.vestDuration),
      immediateReleaseBps: new BN(params.lockedVestingArgs.immediateReleaseBps),
      // SDK examples default the immediate-release timing to the presale end
      immediateReleaseTimestamp:
        params.lockedVestingArgs.immediateReleaseTimestamp != null
          ? new BN(params.lockedVestingArgs.immediateReleaseTimestamp)
          : new BN(params.presaleArgs.presaleEndTime),
    };

    console.log(`\n> Locked Vesting Configuration:`);
    console.log(`  - Lock duration: ${lockedVestingArgs.lockDuration.toString()} seconds`);
    console.log(`  - Vest duration: ${lockedVestingArgs.vestDuration.toString()} seconds`);
    console.log(
      `  - Immediate release: ${lockedVestingArgs.immediateReleaseBps.toString()} bps (${lockedVestingArgs.immediateReleaseBps.toNumber() / 100}%)`
    );
  }

  console.log(`\n> Creating Fixed Price presale transaction...`);
  const initializeFixedPricePresaleTx = await Presale.createFixedPricePresale(
    connection,
    PRESALE_PROGRAM_ID,
    {
      baseMintPubkey: baseMint,
      quoteMintPubkey: quoteMint,
      basePubkey: baseKeypair.publicKey,
      creatorPubkey: wallet.publicKey,
      feePayerPubkey: wallet.publicKey,
      presaleRegistries: presaleRegistriesArgs,
      presaleArgs,
      lockedVestingArgs,
    },
    {
      price,
      rounding,
      disableWithdraw: params.fixedPricePresaleConfig?.disableWithdraw ?? false,
    }
  );

  initializeFixedPricePresaleTx.sign(wallet.payer, baseKeypair);

  if (dryRun) {
    console.log(`\n> Simulating presale initialization...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [
      initializeFixedPricePresaleTx,
    ]);
  } else {
    console.log(`>> Sending presale initialization transaction...`);
    const txSig = await connection.sendRawTransaction(initializeFixedPricePresaleTx.serialize());
    console.log(`>>> Transaction sent: ${txSig}`);

    console.log(`>>> Confirming transaction...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFixedPricePresaleTx.lastValidBlockHeight!,
        blockhash: initializeFixedPricePresaleTx.recentBlockhash!,
      },
      'confirmed'
    );

    console.log(`>>> Waiting for finalization...`);
    await connection.confirmTransaction(
      {
        signature: txSig,
        lastValidBlockHeight: initializeFixedPricePresaleTx.lastValidBlockHeight!,
        blockhash: initializeFixedPricePresaleTx.recentBlockhash!,
      },
      'finalized'
    );

    const presaleAddress = derivePresale(
      baseMint,
      quoteMint,
      baseKeypair.publicKey,
      PRESALE_PROGRAM_ID
    );

    console.log(`\n✅ Presale initialized successfully!`);
    console.log(`   Transaction: ${txSig}`);
    console.log(`   Presale Address: ${presaleAddress.toBase58()}`);

    try {
      const presaleInstance = await Presale.create(connection, presaleAddress, PRESALE_PROGRAM_ID);
      console.log(`\n> Presale State:`);
      console.log(JSON.stringify(presaleInstance.presaleAccount, null, 2));
    } catch (err) {
      console.warn('Could not fetch presale state:', err);
    }
  }
}

export async function createPermissionedFixedPricePresaleVaultWithAuthority() {
  throw new Error('Not implemented yet');
}

export async function createPermissionedFixedPricePresaleVaultWithMerkleProof() {
  throw new Error('Not implemented yet');
}

/**
 * Guard `presaleArgs.presaleStartTime`/`presaleEndTime` against a configuration the presale
 * program can never actually run.
 *
 * Verified against @meteora-ag/presale@0.1.1's own `getPresaleProgressState` (the client-side
 * mirror of the on-chain state machine): a presale is `NotStarted` while
 * `now < presaleStartTime`, `Ongoing` while `now < presaleEndTime`, and otherwise
 * `Completed`/`Failed` — deposits only succeed in the `Ongoing` state, and the program itself
 * rejects a deposit against an already-ended presale on-chain with `PresaleEnded` (error 6016).
 * A `presaleEndTime` at or before the current time is therefore `Completed`/`Failed` from the
 * instant the vault is created: nobody can ever deposit into it. `presaleStartTime: 0` is the
 * SDK/program's own "start immediately" sentinel (documented in presale_vault_config.jsonc and
 * relied on elsewhere in this codebase, e.g. e2e-review-fixes-minors.sh) — it is intentionally
 * NOT flagged as "past" here, only `presaleEndTime` is checked against on-chain time.
 *
 * Also guards the two fields' relationship: if `presaleStartTime` is a real (nonzero) future
 * timestamp, `presaleEndTime` must be after it, or the state machine above jumps straight from
 * `NotStarted` to `Completed`/`Failed` and the presale is never `Ongoing` either — note the
 * program additionally enforces its own minimum presale duration between the effective start
 * and end (see e2e-review-fixes-minors.sh's Section A setup), so clearing this ordering check
 * alone does not guarantee on-chain acceptance; leave a comfortable margin.
 *
 * Uses the on-chain clock (`getOnChainTimestamp`), not the local wall clock — this program's
 * state machine is defined in terms of the validator's Clock sysvar, not the caller's machine.
 */
async function assertPresaleTimesAreValid(
  connection: Connection,
  presaleArgs: { presaleStartTime: BN; presaleEndTime: BN }
): Promise<void> {
  const nowSec = Number(await getOnChainTimestamp(connection));
  const presaleStartTime = Number(presaleArgs.presaleStartTime);
  const presaleEndTime = Number(presaleArgs.presaleEndTime);

  if (presaleEndTime <= nowSec) {
    const behindSeconds = nowSec - presaleEndTime;
    throw new Error(
      `presale_vault_config.jsonc presaleArgs.presaleEndTime is ${presaleEndTime} ` +
        `(${new Date(presaleEndTime * 1000).toISOString()}), which is ${behindSeconds} second(s) at or ` +
        `behind the current on-chain time (${nowSec}, ${new Date(nowSec * 1000).toISOString()}). Per the ` +
        "presale program's own state machine, a presale is Completed/Failed (never Ongoing) once " +
        'now >= presaleEndTime, so this vault would be unable to accept a single deposit from the moment ' +
        'it is created, and any deposit attempt is rejected on-chain with PresaleEnded (error 6016). Fix ' +
        'it by setting presaleEndTime to a value after the current on-chain time, e.g. ' +
        'Math.floor(Date.now() / 1000) + 86400 for 24h from now.'
    );
  }

  if (presaleStartTime !== 0 && presaleEndTime <= presaleStartTime) {
    throw new Error(
      `presale_vault_config.jsonc presaleArgs.presaleEndTime (${presaleEndTime}, ` +
        `${new Date(presaleEndTime * 1000).toISOString()}) must be after presaleArgs.presaleStartTime ` +
        `(${presaleStartTime}, ${new Date(presaleStartTime * 1000).toISOString()}) — otherwise the ` +
        'presale jumps directly from NotStarted to Completed/Failed and is never Ongoing, so nobody can ' +
        'ever deposit. Fix presaleEndTime (or set presaleStartTime to 0 to start immediately).'
    );
  }
}

export async function createPresaleVault(
  connection: Connection,
  wallet: Wallet,
  config: PresaleConfig,
  baseMint: PublicKey
) {
  if (!config.presaleVault) {
    throw new Error('Presale vault configuration is missing');
  }

  if (!config.quoteMint) {
    throw new Error('Quote mint configuration is missing');
  }

  await assertPresaleTimesAreValid(connection, config.presaleVault.presaleArgs);

  const quoteMint = new PublicKey(config.quoteMint);
  const presaleVaultType = config.presaleVaultType;

  console.log(`\n> Creating presale vault of type: ${presaleVaultType}`);

  switch (presaleVaultType) {
    case PresaleVaultTypeConfig.Fcfs:
      await createFcfsPresaleVault(
        connection,
        wallet,
        baseMint,
        quoteMint,
        config.presaleVault,
        config.dryRun
      );
      break;

    case PresaleVaultTypeConfig.Prorata:
      await createProrataPresaleVault(
        connection,
        wallet,
        baseMint,
        quoteMint,
        config.presaleVault,
        config.dryRun
      );
      break;

    case PresaleVaultTypeConfig.FixedPrice:
      await createFixedPricePresaleVault(
        connection,
        wallet,
        baseMint,
        quoteMint,
        config.presaleVault,
        config.dryRun
      );
      break;

    case PresaleVaultTypeConfig.PermissionedFixedPriceWithAuthority:
      await createPermissionedFixedPricePresaleVaultWithAuthority();
      break;

    case PresaleVaultTypeConfig.PermissionedFixedPriceWithMerkleProof:
      await createPermissionedFixedPricePresaleVaultWithMerkleProof();
      break;

    default:
      throw new Error(`Invalid presale vault type: ${presaleVaultType}`);
  }
}
