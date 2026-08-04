import { Wallet } from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getOnChainTimestamp,
  Presale,
  PRESALE_PROGRAM_ID,
  PresaleProgress,
  WhitelistMode,
} from '@meteora-ag/presale';
import BN from 'bn.js';
import { PresaleConfig } from '../../utils/types';
import {
  getAmountInLamports,
  getAmountInTokens,
  modifyComputeUnitPriceIx,
  runSimulateTransaction,
} from '../../helpers';
import { DEFAULT_SEND_TX_MAX_RETRIES } from '../../utils/constants';

/**
 * 0-SOL fee-payer guard, matching the alpha_vault/participant.ts precedent — even a dry-run
 * simulation needs an existing fee payer account.
 */
export async function assertFunded(connection: Connection, payer: PublicKey): Promise<void> {
  const balance = await connection.getBalance(payer);
  if (balance === 0) {
    throw new Error(
      `Wallet ${payer.toString()} has 0 SOL — fund it first; even dry-run simulation requires an existing fee payer account`
    );
  }
}

/** registryIndex is serialized as a u8 on-chain (deriveEscrow seeds) — must fit 0-255. */
function assertValidRegistryIndex(registryIndex: number): void {
  if (!Number.isInteger(registryIndex) || registryIndex < 0 || registryIndex > 255) {
    throw new Error(
      `registryIndex must be an integer between 0 and 255 (it is serialized as a u8 on-chain); got ${registryIndex}`
    );
  }
}

/** Shared simulate-or-send tail used by every presale_vault write action. */
export async function simulateOrSend(
  connection: Connection,
  wallet: Wallet,
  dryRun: boolean,
  tx: Transaction,
  label: string
): Promise<void> {
  if (dryRun) {
    console.log(`\n> Simulating ${label} transaction...`);
    await runSimulateTransaction(connection, [wallet.payer], wallet.publicKey, [tx]);
    console.log(`> ${label} simulation successful`);
  } else {
    console.log(`\n>> Sending ${label} transaction...`);
    const txHash = await sendAndConfirmTransaction(connection, tx, [wallet.payer], {
      commitment: connection.commitment,
      maxRetries: DEFAULT_SEND_TX_MAX_RETRIES,
    });
    console.log(`>>> ${label} succeeded with tx hash: ${txHash}`);
  }
}

/**
 * Deposit into a presale. Reads config.presaleDeposit (amount in quote human units,
 * registryIndex). `Presale.deposit()` itself creates a missing buyer escrow as a bundled
 * pre-instruction in the SAME transaction for Permissionless/PermissionWithMerkleProof modes
 * — no separate create-escrow transaction is built or sent here:
 *  - permissionless: `deposit()` calls `getOrCreatePermissionlessEscrowIx` internally. That
 *    helper — and the on-chain `create_permissionless_escrow` instruction itself (IDL-verified:
 *    the escrow PDA's seeds hardcode registry index 0, not an instruction arg) — can only ever
 *    create a FIRST escrow at registry 0, so a first-time deposit targeting a nonzero
 *    registryIndex is refused pre-flight below with an actionable error instead of silently
 *    creating the wrong escrow and failing deep inside the deposit instruction.
 *  - permissioned_with_merkle_proof: `deposit()` auto-fetches the proof via the SDK's own
 *    internal helper; a failure (no proof/server published yet) is caught below and re-thrown
 *    with a clear, creator-managed-flow error.
 *  - permissioned_with_authority: errors clearly before ever calling `deposit()` — new escrows
 *    there can only be created by the presale's operator via a server-side partially-signed
 *    flow this CLI does not run.
 */
export async function deposit(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.presaleDeposit) {
    throw new Error('Missing presaleDeposit in configuration');
  }
  const { amount, registryIndex: registryIndexRaw } = config.presaleDeposit;
  if (!(amount > 0)) {
    throw new Error(`presaleDeposit.amount must be > 0 (got ${amount})`);
  }
  assertValidRegistryIndex(registryIndexRaw);
  const registryIndex = new BN(registryIndexRaw);

  console.log('\n> Initializing Presale deposit...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();
  const quoteDecimals = presale.quoteMint.decimals;

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Mode: ${w.getPresaleModeName()}`);
  console.log(`- Whitelist mode: ${w.getWhitelistModeName()}`);
  console.log(
    `- Progress: ${PresaleProgress[w.getPresaleProgressState()]} (${w.getPresaleProgressPercentage().toFixed(2)}%)`
  );

  if (!w.canDeposit()) {
    const reasons: string[] = [];
    const progress = w.getPresaleProgressState();
    if (progress !== PresaleProgress.Ongoing) {
      reasons.push(
        `the presale is not in its ongoing window right now (progress: ${PresaleProgress[progress]})`
      );
    }
    if (
      w.getPresaleModeName() !== 'Prorata' &&
      w.getTotalDepositRawAmount().gte(w.getPresaleMaximumRawCap())
    ) {
      reasons.push('the presale-wide maximum cap has already been reached');
    }
    if (reasons.length === 0) {
      reasons.push('unknown — re-check with presale-vault-get-status');
    }
    throw new Error(
      `Cannot deposit into presale ${vault.toString()} right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }

  const registry = w.getPresaleRegistry(registryIndex);
  if (!registry) {
    throw new Error(
      `registryIndex ${registryIndex.toString()} has no initialized tier on presale ${vault.toString()}.`
    );
  }
  console.log(
    `- Registry ${registryIndex.toString()} caps: min ${registry.getBuyerMinimumUiDepositCap()} / max ${registry.getBuyerMaximumUiDepositCap()} (quote units)`
  );

  const amountLamports = getAmountInLamports(amount, quoteDecimals);
  console.log(`- Depositing ${amount} (${amountLamports.toString()} base units)`);

  const escrows = await presale.getPresaleEscrowByOwner(wallet.publicKey);
  const existing = escrows.find(
    (escrow) => escrow.getEscrowAccount().registryIndex === registryIndex.toNumber()
  );

  if (existing) {
    const remaining = existing.getRemainingDepositAmount(w);
    if (amountLamports.gt(remaining)) {
      throw new Error(
        `Requested deposit ${amount} exceeds this wallet's remaining deposit quota of ` +
          `${getAmountInTokens(remaining, quoteDecimals)} on registry ${registryIndex.toString()} ` +
          `(individual cap ${existing.getIndividualDepositUiCap()}, already deposited ${existing.getDepositUiAmount()}).`
      );
    }
  } else if (amountLamports.gt(registry.getBuyerMaximumRawDepositCap())) {
    throw new Error(
      `Requested deposit ${amount} exceeds registry ${registryIndex.toString()}'s max deposit cap of ` +
        `${registry.getBuyerMaximumUiDepositCap()} (quote units).`
    );
  }
  if (amountLamports.lt(registry.getBuyerMinimumRawDepositCap())) {
    throw new Error(
      `Requested deposit ${amount} is below registry ${registryIndex.toString()}'s minimum deposit cap of ` +
        `${registry.getBuyerMinimumUiDepositCap()} (quote units).`
    );
  }

  const whitelistMode: WhitelistMode = presale.presaleAccount.whitelistMode;
  if (!existing) {
    console.log('- No escrow found yet for this wallet/registry.');

    if (whitelistMode === WhitelistMode.Permissionless) {
      // Program-level constraint (IDL-verified): create_permissionless_escrow's escrow PDA
      // hardcodes registry index 0 in its seeds — there is no instruction arg to target any
      // other registry. A brand-new permissionless escrow can therefore only ever be created
      // at registry 0, no matter what registryIndex this deposit is configured for.
      if (!registryIndex.isZero()) {
        throw new Error(
          `Presale ${vault.toString()} is permissionless and wallet ${wallet.publicKey.toString()} ` +
            `has no escrow yet on registry ${registryIndex.toString()}. A permissionless presale's ` +
            'FIRST escrow for a wallet can only ever be created at registry index 0 (a fixed ' +
            'on-chain constraint, not a config choice) — deposit into registry 0 first, or ask the ' +
            'presale creator whether this tier should instead use permissioned_with_merkle_proof ' +
            '/ permissioned_with_authority.'
        );
      }
      console.log(
        '- Whitelist mode is permissionless — presale.deposit() will create the registry-0 ' +
          'escrow as part of the same deposit transaction below.'
      );
    } else if (whitelistMode === WhitelistMode.PermissionWithMerkleProof) {
      console.log(
        '- Whitelist mode is permissioned_with_merkle_proof — presale.deposit() will attempt to ' +
          "auto-fetch the proof from the presale's permissioned-server metadata and bundle the " +
          'escrow creation into the same deposit transaction below.'
      );
    } else {
      throw new Error(
        `Presale ${vault.toString()} is permissioned_with_authority — new escrows there can only ` +
          "be created by the presale's operator via a server-side partially-signed transaction " +
          "(the SDK's fetchPartialSignedInitEscrowAndDepositTransactionFromOperator flow), which " +
          `this CLI does not run. Ask the presale creator to create an escrow for ` +
          `${wallet.publicKey.toString()} before depositing.`
      );
    }
  }

  // presale.deposit() bundles escrow creation (when missing) as a pre-instruction in this SAME
  // transaction for Permissionless/PermissionWithMerkleProof — no separate create-escrow tx.
  let depositTx;
  try {
    depositTx = await presale.deposit({
      owner: wallet.publicKey,
      amount: amountLamports,
      registryIndex,
    });
  } catch (err) {
    if (!existing && whitelistMode === WhitelistMode.PermissionWithMerkleProof) {
      throw new Error(
        `Could not create a merkle-proof escrow automatically for ${wallet.publicKey.toString()} ` +
          `on presale ${vault.toString()}: ${err instanceof Error ? err.message : String(err)}\n` +
          'This presale is permissioned_with_merkle_proof — proof creation/publishing is ' +
          'creator-managed (the creator publishes a permissioned-server endpoint and a merkle ' +
          'root config). Ask the presale creator to confirm this wallet is whitelisted and that ' +
          'the proof server is live.'
      );
    }
    throw err;
  }
  modifyComputeUnitPriceIx(depositTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, depositTx, 'deposit');
}

/**
 * Withdraw a deposit during the presale's ongoing window. Reads config.presaleWithdraw
 * (amount, registryIndex). FCFS presales never allow this; fixed-price presales block it when
 * created with disableWithdraw: true (surfaced explicitly below); prorata presales always allow
 * it while ongoing.
 */
export async function withdraw(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.presaleWithdraw) {
    throw new Error('Missing presaleWithdraw in configuration');
  }
  const { amount, registryIndex: registryIndexRaw } = config.presaleWithdraw;
  if (!(amount > 0)) {
    throw new Error(`presaleWithdraw.amount must be > 0 (got ${amount})`);
  }
  assertValidRegistryIndex(registryIndexRaw);
  const registryIndex = new BN(registryIndexRaw);

  console.log('\n> Initializing Presale withdraw...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();
  const quoteDecimals = presale.quoteMint.decimals;

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Mode: ${w.getPresaleModeName()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);

  const escrows = await presale.getPresaleEscrowByOwner(wallet.publicKey);
  const escrow = escrows.find(
    (e) => e.getEscrowAccount().registryIndex === registryIndex.toNumber()
  );
  if (!escrow) {
    throw new Error(
      `No escrow found for wallet ${wallet.publicKey.toString()} on registry ${registryIndex.toString()} ` +
        `of presale ${vault.toString()} — deposit first.`
    );
  }
  console.log(
    `- Current deposit: ${getAmountInTokens(escrow.getDepositRawAmount(), quoteDecimals)}`
  );

  if (!w.canWithdraw()) {
    const reasons: string[] = [];
    const modeName = w.getPresaleModeName();
    const progress = w.getPresaleProgressState();
    if (modeName === 'Fcfs') {
      reasons.push('FCFS presales never allow withdrawing a deposit');
    } else if (progress !== PresaleProgress.Ongoing) {
      reasons.push(
        `the presale is not in its ongoing/deposit window right now (progress: ${PresaleProgress[progress]})`
      );
    } else if (modeName === 'FixedPrice') {
      // Ongoing + FixedPrice + still blocked: the SDK's own FixedPricePresaleHandler.canWithdraw()
      // has exactly one condition (`!disableWithdraw`), so this is the only remaining reason.
      reasons.push(
        'this fixed-price presale was created with fixedPricePresaleConfig.disableWithdraw: true'
      );
    }
    if (reasons.length === 0) {
      reasons.push('unknown — re-check with presale-vault-get-status');
    }
    throw new Error(
      `Cannot withdraw from presale ${vault.toString()} right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }

  const amountLamports = getAmountInLamports(amount, quoteDecimals);
  if (amountLamports.gt(escrow.getDepositRawAmount())) {
    throw new Error(
      `Requested withdrawal ${amount} exceeds the escrow's current deposit of ` +
        `${getAmountInTokens(escrow.getDepositRawAmount(), quoteDecimals)}.`
    );
  }
  console.log(`- Withdrawing ${amount} (${amountLamports.toString()} base units)`);

  const withdrawTx = await presale.withdraw({
    owner: wallet.publicKey,
    amount: amountLamports,
    registryIndex,
  });
  modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, withdrawTx, 'withdraw');
}

/**
 * Claim vested/bought tokens after the presale has completed. Reads config.presaleClaim
 * (registryIndex). Prints total-allocated / already-claimed / pending-claimable-now — the last
 * one needs the live on-chain clock (getOnChainTimestamp), a required argument in SDK 0.1.x.
 */
export async function claim(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  if (!config.presaleClaim) {
    throw new Error('Missing presaleClaim in configuration');
  }
  const { registryIndex: registryIndexRaw } = config.presaleClaim;
  assertValidRegistryIndex(registryIndexRaw);
  const registryIndex = new BN(registryIndexRaw);

  console.log('\n> Initializing Presale claim...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();
  const baseDecimals = presale.baseMint.decimals;

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);

  const escrows = await presale.getPresaleEscrowByOwner(wallet.publicKey);
  const escrow = escrows.find(
    (e) => e.getEscrowAccount().registryIndex === registryIndex.toNumber()
  );
  if (!escrow) {
    throw new Error(
      `No escrow found for wallet ${wallet.publicKey.toString()} on registry ${registryIndex.toString()} ` +
        `of presale ${vault.toString()} — nothing to claim.`
    );
  }

  const currentTimestamp = Number(await getOnChainTimestamp(connection));
  const totalClaimable = escrow.getTotalClaimableRawAmount(w);
  const claimed = escrow.getClaimedRawAmount();
  const pending = escrow.getPendingClaimableRawAmount(w, currentTimestamp);

  console.log(
    `- Total claimable (lifetime alloc): ${getAmountInTokens(totalClaimable, baseDecimals)}`
  );
  console.log(`- Already claimed:                  ${getAmountInTokens(claimed, baseDecimals)}`);
  console.log(`- Pending claimable now:             ${getAmountInTokens(pending, baseDecimals)}`);

  if (!w.canClaim()) {
    throw new Error(
      `Cannot claim from presale ${vault.toString()} right now — progress must be Completed and ` +
        `vesting must have started (progress: ${PresaleProgress[w.getPresaleProgressState()]}).`
    );
  }
  if (pending.lten(0)) {
    throw new Error(
      `Nothing to claim right now for wallet ${wallet.publicKey.toString()} on registry ` +
        `${registryIndex.toString()} (already fully claimed up to what has vested so far — check ` +
        'back after more time has vested).'
    );
  }

  const claimTx = await presale.claim({ owner: wallet.publicKey, registryIndex });
  modifyComputeUnitPriceIx(claimTx, config.computeUnitPriceMicroLamports ?? 0);
  await simulateOrSend(connection, wallet, config.dryRun, claimTx, 'claim');
}

/**
 * Withdraw unused ("remaining") deposit — prorata overflow refunds once Completed, or the full
 * deposit back once Failed. No config block: sweeps every registry the wallet has an escrow on
 * and processes whichever are eligible per the wrapper's own predicate.
 */
export async function withdrawRemainingQuote(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Presale withdraw-remaining-quote...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();
  const quoteDecimals = presale.quoteMint.decimals;

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);

  const escrows = await presale.getPresaleEscrowByOwner(wallet.publicKey);
  if (escrows.length === 0) {
    throw new Error(
      `No escrows found for wallet ${wallet.publicKey.toString()} on presale ${vault.toString()}.`
    );
  }

  let anyEligible = false;
  for (const escrow of escrows) {
    const registryIndex = new BN(escrow.getEscrowAccount().registryIndex);
    const eligible = escrow.canWithdrawRemainingQuoteAmount(w);
    const refundable = escrow.getWithdrawableRemainingQuoteAmount(w);

    console.log(
      `\n- Registry ${registryIndex.toString()}: refundable ${getAmountInTokens(refundable, quoteDecimals)} — ` +
        `${eligible ? 'eligible' : 'not eligible'}`
    );

    if (!eligible) {
      continue;
    }
    anyEligible = true;

    const withdrawTx = await presale.withdrawRemainingQuote({
      owner: wallet.publicKey,
      registryIndex,
    });
    modifyComputeUnitPriceIx(withdrawTx, config.computeUnitPriceMicroLamports ?? 0);
    await simulateOrSend(
      connection,
      wallet,
      config.dryRun,
      withdrawTx,
      `withdraw-remaining-quote (registry ${registryIndex.toString()})`
    );
  }

  if (!anyEligible) {
    throw new Error(
      `No escrow for wallet ${wallet.publicKey.toString()} on presale ${vault.toString()} currently ` +
        'has remaining quote to withdraw (either nothing overflowed, the presale has not resolved ' +
        'yet, or it has already been withdrawn). Re-check with presale-vault-get-status.'
    );
  }
}

/**
 * Close buyer escrow(s) on a presale, reclaiming their rent. No config block: sweeps every
 * registry the wallet has an escrow on and closes whichever ones the SDK's own
 * `EscrowWrapper.canClose()` says are eligible — mirrors the alpha-vault `closeEscrowWhenDone`
 * precedent (`alpha_vault/participant.ts`), but as its own standalone action since a presale
 * wallet can hold one escrow per registry (rather than a single vault-wide escrow). Per the
 * installed SDK: an Ongoing/Failed escrow is closable once its deposit (and any fee) is back to
 * zero; a Completed escrow is closable once everything allocated to it has been claimed (and,
 * for prorata presales, any remaining quote already withdrawn). Ineligible escrows are reported
 * with their state, not closed.
 */
export async function closeEscrow(
  config: PresaleConfig,
  connection: Connection,
  wallet: Wallet,
  vault: PublicKey
) {
  console.log('\n> Initializing Presale close-escrow...');
  await assertFunded(connection, wallet.publicKey);

  const presale = await Presale.create(connection, vault, PRESALE_PROGRAM_ID);
  const w = presale.getParsedPresale();

  console.log(`- Presale ${vault.toString()}`);
  console.log(`- Progress: ${PresaleProgress[w.getPresaleProgressState()]}`);

  const escrows = await presale.getPresaleEscrowByOwner(wallet.publicKey);
  if (escrows.length === 0) {
    throw new Error(
      `No escrows found for wallet ${wallet.publicKey.toString()} on presale ${vault.toString()} — ` +
        'nothing to close.'
    );
  }

  let anyClosed = false;
  for (const escrow of escrows) {
    const registryIndex = new BN(escrow.getEscrowAccount().registryIndex);
    const closable = escrow.canClose(w);

    console.log(
      `\n- Registry ${registryIndex.toString()}: deposit ${escrow.getDepositUiAmount()}, ` +
        `claimed ${escrow.getClaimedUiAmount()} — ${closable ? 'closable' : 'not yet closable'}`
    );

    if (!closable) {
      continue;
    }
    anyClosed = true;

    const closeTx = await presale.closeEscrow({
      owner: wallet.publicKey,
      registryIndex,
    });
    modifyComputeUnitPriceIx(closeTx, config.computeUnitPriceMicroLamports ?? 0);
    await simulateOrSend(
      connection,
      wallet,
      config.dryRun,
      closeTx,
      `close-escrow (registry ${registryIndex.toString()})`
    );
  }

  if (!anyClosed) {
    const progress = w.getPresaleProgressState();
    const reasons: string[] = [];
    if (progress === PresaleProgress.Ongoing) {
      reasons.push(
        'the presale is still ongoing and at least one escrow still holds a deposit or unpaid fee'
      );
    } else if (progress === PresaleProgress.Failed) {
      reasons.push(
        'at least one escrow still has an un-withdrawn deposit — withdraw it first with ' +
          'presale-vault-withdraw-remaining-quote'
      );
    } else if (progress === PresaleProgress.Completed) {
      reasons.push(
        'at least one escrow has not yet claimed everything allocated to it (claim first with ' +
          'presale-vault-claim), or — for prorata presales — has not withdrawn its remaining ' +
          'quote yet (presale-vault-withdraw-remaining-quote)'
      );
    } else {
      reasons.push(
        `presale progress is ${PresaleProgress[progress]} — escrows are not closable before the ` +
          'presale starts'
      );
    }
    throw new Error(
      `No escrow for wallet ${wallet.publicKey.toString()} on presale ${vault.toString()} is ` +
        `closable right now:\n` +
        reasons.map((reason) => `  - ${reason}`).join('\n')
    );
  }
}
