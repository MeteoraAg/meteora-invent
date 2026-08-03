import { Connection, PublicKey } from '@solana/web3.js';
import {
  getOnChainTimestamp,
  Presale,
  PRESALE_PROGRAM_ID,
  PresaleProgress,
} from '@meteora-ag/presale';

export interface PresaleSelector {
  vault?: PublicKey;
  baseMint?: PublicKey;
}

/**
 * Resolve a presale address from either an explicit --vault, or a --baseMint discovery scan.
 * Presale.getPresales() is a full getProgramAccounts scan of every presale account on the
 * program — there is no memcmp/PDA shortcut from just the base mint (the presale address is
 * derived from [baseMint, quoteMint, base], where `base` is a one-off keypair generated at
 * creation time and is not recoverable from the mint alone). Matches are filtered by the
 * decoded account's `baseMint` field — the same field getStatus() below reads off
 * `presale.presaleAccount` (verified against the installed @meteora-ag/presale .d.ts).
 */
export async function resolvePresaleAddress(
  connection: Connection,
  selector: PresaleSelector,
  presaleProgramId: PublicKey = PRESALE_PROGRAM_ID
): Promise<PublicKey> {
  if (selector.vault) {
    return selector.vault;
  }
  if (!selector.baseMint) {
    throw new Error('Please provide --vault or --baseMint flag to do this action.');
  }

  const presales = await Presale.getPresales(connection, presaleProgramId);
  const matches = presales.filter((p) => p.account.baseMint.equals(selector.baseMint!));

  if (matches.length === 0) {
    throw new Error(
      `No presale found for base mint ${selector.baseMint.toString()} (program ${presaleProgramId.toString()}).`
    );
  }

  if (matches.length > 1) {
    console.log(
      `\n> Found ${matches.length} presales for base mint ${selector.baseMint.toString()}:`
    );
    console.log('  pubkey | mode | progress');
    for (const match of matches) {
      const matchPresale = await Presale.create(connection, match.pubkey, presaleProgramId);
      const parsed = matchPresale.getParsedPresale();
      console.log(
        `  ${match.pubkey.toString()} | ${parsed.getPresaleModeName()} | ` +
          `${PresaleProgress[parsed.getPresaleProgressState()]} (${parsed.getPresaleProgressPercentage().toFixed(2)}%)`
      );
    }
    throw new Error(
      `Multiple presales found for base mint ${selector.baseMint.toString()} — re-run with --vault <address> to pick one from the list above.`
    );
  }

  return matches[0]!.pubkey;
}

/**
 * Print the full status of a presale (read-only, no keypair required): progress state/%, mode,
 * whitelist mode, totals, average token price, timings, every gate boolean, and a per-registry
 * table. When Completed, prints next-step hints for both sides of the hand-off. With a wallet,
 * also prints that wallet's per-escrow view (deposited/claimed/pending/withdrawable).
 *
 * Accepts either --vault (direct) or --baseMint (discovery, via resolvePresaleAddress). A
 * nonexistent --vault address is turned into a clean error instead of the raw
 * "Account does not exist or has no data" throw from the underlying Anchor fetch.
 */
export async function getStatus(
  connection: Connection,
  selector: PresaleSelector,
  walletPubkey?: PublicKey
) {
  const presaleProgramId = PRESALE_PROGRAM_ID;
  const presaleAddress = await resolvePresaleAddress(connection, selector, presaleProgramId);

  let presale: Presale;
  try {
    presale = await Presale.create(connection, presaleAddress, presaleProgramId);
  } catch {
    throw new Error(
      `No presale vault at ${presaleAddress.toString()} — check the address, or discover one with --baseMint <mint>.`
    );
  }
  const w = presale.getParsedPresale();
  const account = presale.presaleAccount;

  console.log(`\n> Presale:           ${presaleAddress.toString()}`);
  console.log(`> Creator:           ${account.owner.toString()}`);
  console.log(`> Base mint:         ${account.baseMint.toString()}`);
  console.log(`> Quote mint:        ${account.quoteMint.toString()}`);
  console.log(`> Mode:              ${w.getPresaleModeName()}`);
  console.log(`> Whitelist mode:    ${w.getWhitelistModeName()}`);
  console.log(
    `> Progress:          ${PresaleProgress[w.getPresaleProgressState()]} (${w.getPresaleProgressPercentage().toFixed(2)}%)`
  );
  console.log(`> Total deposited:   ${w.getTotalDepositUiAmount()} (quote)`);
  console.log(`> Total sold:        ${w.getUiTotalBaseTokenSold()} (base)`);
  console.log(`> Minimum cap:       ${w.getPresaleMinimumUiCap()} (quote)`);
  console.log(`> Maximum cap:       ${w.getPresaleMaximumUiCap()} (quote)`);
  console.log(`> Average price:     ${w.getAverageTokenPrice()} (quote per base)`);
  console.log(
    `> Immediate release: ${w.getImmediateReleasePercentage()}% (${w.getImmediateReleaseUiAmount()} base)`
  );
  console.log(
    `> Unsold token action: ${account.unsoldTokenAction === 1 ? 'burn' : 'refund to creator'}` +
      `${account.isUnsoldTokenActionPerformed ? ' (already performed)' : ''}`
  );

  const timings = w.getTimings();
  console.log(`> Presale start:     ${timings.presaleStartTime} (unix seconds)`);
  console.log(`> Presale end:       ${timings.presaleEndTime} (unix seconds)`);
  console.log(`> Vesting start:     ${timings.vestingStartTime} (unix seconds)`);
  console.log(`> Vesting end:       ${timings.vestingEndTime} (unix seconds)`);
  console.log(`> Subject to early end once cap reached: ${timings.subjectToEarlyEnd}`);

  console.log(`\n> Gates:`);
  console.log(`> canDeposit:                ${w.canDeposit()}`);
  console.log(`> canWithdraw:               ${w.canWithdraw()}`);
  console.log(`> canWithdrawRemainingQuote: ${w.canWithdrawRemainingQuote()}`);
  console.log(`> canClaim:                  ${w.canClaim()}`);
  console.log(`> canCreatorWithdraw:        ${w.canCreatorWithdraw()}`);
  console.log(`> canCreatorCollectFee:      ${w.canCreatorCollectFee()}`);

  const registries = w.getAllPresaleRegistries();
  console.log(`\n> Registries (${registries.length}):`);
  for (const registry of registries) {
    console.log(`  [${registry.getRegistryIndex()}]`);
    console.log(`    Supply:        ${registry.getPresaleUiSupply()} (base)`);
    console.log(`    Total deposit: ${registry.getTotalDepositUiAmount()} (quote)`);
    console.log(`    Min cap:       ${registry.getBuyerMinimumUiDepositCap()} (quote)`);
    console.log(`    Max cap:       ${registry.getBuyerMaximumUiDepositCap()} (quote)`);
    console.log(`    Deposit fee:   ${registry.getDepositFeePercentage()}%`);
    console.log(`    Token price:   ${registry.getTokenPrice()}`);
    console.log(`    Total sold:    ${registry.getTotalBaseTokenSoldUiAmount()} (base)`);
  }

  if (w.getPresaleProgressState() === PresaleProgress.Completed) {
    console.log('\n> The raise is Completed — next steps:');
    console.log(
      `  Creator: pnpm studio presale-vault-creator-withdraw --vault ${presaleAddress.toString()}, ` +
        'then seed a market with the raised quote + reserved supply — pick one: dlmm-create-pool, ' +
        'damm-v2-create-balanced-pool, damm-v1-create-pool, or a DBC config + pool for curve-style launches.'
    );
    console.log(`  Buyers:  pnpm studio presale-vault-claim --vault ${presaleAddress.toString()}`);
  }

  if (!walletPubkey) {
    return;
  }

  console.log(`\n> Wallet: ${walletPubkey.toString()}`);
  const escrows = await presale.getPresaleEscrowByOwner(walletPubkey);
  if (escrows.length === 0) {
    console.log('> No escrow found for this wallet on this presale (it has not deposited yet).');
    return;
  }

  const currentTimestamp = Number(await getOnChainTimestamp(connection));
  for (const escrow of escrows) {
    const escrowAccount = escrow.getEscrowAccount();
    console.log(`\n  Registry ${escrowAccount.registryIndex}:`);
    console.log(`    Deposited:                    ${escrow.getDepositUiAmount()} (quote)`);
    console.log(`    Total claimable (lifetime):   ${escrow.getTotalClaimableUiAmount(w)} (base)`);
    console.log(`    Claimed so far:               ${escrow.getClaimedUiAmount()} (base)`);
    console.log(
      `    Pending claimable now:        ${escrow.getPendingClaimableUiAmount(w, currentTimestamp)} (base)`
    );
    console.log(
      `    Withdrawable remaining quote: ${escrow.getWithdrawableRemainingQuoteUiAmount(w)} (quote)`
    );
    console.log(`    Individual deposit cap:       ${escrow.getIndividualDepositUiCap()} (quote)`);
  }
}
