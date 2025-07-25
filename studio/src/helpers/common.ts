import { SOL_TOKEN_DECIMALS, SOL_TOKEN_MINT, USDC_TOKEN_MINT } from '../utils/constants';
import Decimal from 'decimal.js';
import BN from 'bn.js';
import { Signer, PublicKey, Connection } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export function getQuoteMint(quoteSymbol?: string, quoteMint?: string): PublicKey {
  if (quoteSymbol == null && quoteMint == null) {
    throw new Error(`Either quoteSymbol or quoteMint must be provided`);
  }
  if (quoteSymbol && quoteMint) {
    throw new Error(`Cannot provide quoteSymbol and quoteMint at the same time`);
  }

  if (quoteMint) {
    return new PublicKey(quoteMint);
  }

  if (quoteSymbol.toLowerCase() == 'sol') {
    return new PublicKey(SOL_TOKEN_MINT);
  } else if (quoteSymbol.toLowerCase() == 'usdc') {
    return new PublicKey(USDC_TOKEN_MINT);
  } else {
    throw new Error(`Unsupported quote symbol: ${quoteSymbol}`);
  }
}

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
