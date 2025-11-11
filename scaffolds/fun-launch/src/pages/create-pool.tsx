import { useMemo, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { z } from 'zod';
import Header from '../components/Header';

import { useForm } from '@tanstack/react-form';
import { Button } from '@/components/ui/button';
import { Keypair, Transaction } from '@solana/web3.js';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { toast } from 'sonner';

// Define the schema for form validation
const poolSchema = z.object({
  tokenName: z.string().min(3, 'Token name must be at least 3 characters'),
  tokenSymbol: z.string().min(1, 'Token symbol is required'),
  tokenLogo: z.instanceof(File, { message: 'Token logo is required' }).optional(),
  website: z.string().url({ message: 'Please enter a valid URL' }).optional().or(z.literal('')),
  twitter: z.string().url({ message: 'Please enter a valid URL' }).optional().or(z.literal('')),
});

interface FormValues {
  tokenName: string;
  tokenSymbol: string;
  tokenLogo: File | undefined;
  website?: string;
  twitter?: string;
}

export default function CreatePool() {
  const { publicKey, signTransaction } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const [isLoading, setIsLoading] = useState(false);
  const [poolCreated, setPoolCreated] = useState(false);
  const [tokenLogoPreview, setTokenLogoPreview] = useState<File | null>(null);

  const form = useForm({
    defaultValues: {
      tokenName: '',
      tokenSymbol: '',
      tokenLogo: undefined,
      website: '',
      twitter: '',
    } as FormValues,
    onSubmit: async ({ value }) => {
      try {
        setIsLoading(true);
        const { tokenLogo } = value;
        if (!tokenLogo) {
          toast.error('Token logo is required');
          return;
        }

        if (!signTransaction) {
          toast.error('Wallet not connected');
          return;
        }

        const reader = new FileReader();

        // Convert file to base64
        const base64File = await new Promise<string>((resolve) => {
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.readAsDataURL(tokenLogo);
        });

        const keyPair = Keypair.generate();

        // Step 1: Upload to R2 and get transaction
        const uploadResponse = await fetch('/api/upload', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            tokenLogo: base64File,
            mint: keyPair.publicKey.toBase58(),
            tokenName: value.tokenName,
            tokenSymbol: value.tokenSymbol,
            userWallet: address,
          }),
        });

        if (!uploadResponse.ok) {
          const error = await uploadResponse.json();
          throw new Error(error.error);
        }

        const { poolTx } = await uploadResponse.json();
        const transaction = Transaction.from(Buffer.from(poolTx, 'base64'));

        // Step 2: Sign with keypair first
        transaction.sign(keyPair);

        // Step 3: Then sign with user's wallet
        let signedTransaction;
        try {
          signedTransaction = await signTransaction(transaction);
        } catch (walletError: any) {
          // Handle wallet-specific errors
          if (walletError.message?.includes('User rejected') || walletError.message?.includes('rejected the request')) {
            toast.error('Transaction cancelled - You rejected the signature request');
          } else if (walletError.message?.includes('Transaction cancelled')) {
            toast.error('Transaction cancelled');
          } else {
            toast.error(`Wallet error: ${walletError.message || 'Failed to sign transaction'}`);
          }
          return;
        }

        // Step 4: Send signed transaction
        const sendResponse = await fetch('/api/send-transaction', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            signedTransaction: signedTransaction.serialize().toString('base64'),
          }),
        });

        if (!sendResponse.ok) {
          const error = await sendResponse.json();
          throw new Error(error.error || 'Failed to send transaction');
        }

        const { success } = await sendResponse.json();
        if (success) {
          toast.success('Token launched successfully! 🚀');
          setPoolCreated(true);
        }
      } catch (error: any) {
        console.error('Error creating pool:', error);

        // Provide user-friendly error messages
        if (error.message?.includes('Failed to upload image')) {
          toast.error('Failed to upload image. Please try again or use a different image.');
        } else if (error.message?.includes('Failed to upload metadata')) {
          toast.error('Failed to upload token metadata. Please try again.');
        } else if (error.message?.includes('Insufficient funds')) {
          toast.error('Insufficient SOL balance to create pool. Please add funds to your wallet.');
        } else if (error.message?.includes('blockhash')) {
          toast.error('Transaction expired. Please try again.');
        } else if (error.message?.includes('Network request failed')) {
          toast.error('Network error. Please check your connection and try again.');
        } else {
          toast.error(error.message || 'Failed to create pool. Please try again.');
        }
      } finally {
        setIsLoading(false);
      }
    },
    validators: {
      onSubmit: ({ value }) => {
        const result = poolSchema.safeParse(value);
        if (!result.success) {
          return result.error.formErrors.fieldErrors;
        }
        return undefined;
      },
    },
  });

  return (
    <>
      <Head>
        <title>Launch Token - TrenchFun</title>
        <meta
          name="description"
          content="Launch your token on TrenchFun with fair bonding curves and instant liquidity."
        />
      </Head>

      <div className="min-h-screen bg-black text-white relative">
        {/* Gradient background */}
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-20 left-1/3 w-96 h-96 bg-purple-500/10 rounded-full blur-3xl" />
          <div className="absolute bottom-20 right-1/3 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl" />
        </div>

        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="container mx-auto px-4 py-8 max-w-4xl relative z-10">
          {poolCreated && !isLoading ? (
            <PoolCreationSuccess />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
              className="space-y-6"
            >
              {/* Token Details Section */}
              <div className="bg-black/40 rounded-2xl p-8 backdrop-blur-md border border-purple-500/20 shadow-2xl shadow-purple-500/5">
                <div className="flex items-center gap-3 mb-8">
                  <div className="relative">
                    <div className="absolute inset-0 bg-purple-500 rounded-xl blur-md opacity-30" />
                    <div className="relative w-12 h-12 bg-gradient-to-br from-purple-500 to-blue-500 rounded-xl flex items-center justify-center">
                      <span className="iconify ph--coin-bold w-7 h-7 text-white" />
                    </div>
                  </div>
                  <h2 className="text-2xl font-bold text-white">Token Details</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div className="mb-4">
                      <label
                        htmlFor="tokenName"
                        className="block text-sm font-medium text-purple-200/80 mb-2"
                      >
                        Token Name*
                      </label>
                      {form.Field({
                        name: 'tokenName',
                        children: (field) => (
                          <input
                            id="tokenName"
                            name={field.name}
                            type="text"
                            className="w-full p-3 bg-black/40 border border-purple-500/30 rounded-lg text-white placeholder:text-gray-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-all"
                            placeholder="e.g. Trench Coin"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            required
                            minLength={3}
                          />
                        ),
                      })}
                    </div>

                    <div className="mb-4">
                      <label
                        htmlFor="tokenSymbol"
                        className="block text-sm font-medium text-purple-200/80 mb-2"
                      >
                        Token Symbol*
                      </label>
                      {form.Field({
                        name: 'tokenSymbol',
                        children: (field) => (
                          <input
                            id="tokenSymbol"
                            name={field.name}
                            type="text"
                            className="w-full p-3 bg-black/40 border border-purple-500/30 rounded-lg text-white placeholder:text-gray-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-all"
                            placeholder="e.g. TRNCH"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            required
                            maxLength={10}
                          />
                        ),
                      })}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="tokenLogo"
                      className="block text-sm font-medium text-purple-200/80 mb-2"
                    >
                      Token Logo*
                    </label>
                    {form.Field({
                      name: 'tokenLogo',
                      children: (field) => (
                        <>
                          {tokenLogoPreview ? (
                            <div className="relative border-2 border-dashed border-purple-500/30 rounded-lg p-8 text-center bg-black/20 group hover:border-purple-500/50 transition-all cursor-pointer">
                              {/* Remove button */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setTokenLogoPreview(null);
                                  field.handleChange(undefined);
                                }}
                                className="absolute -top-2 -right-2 w-7 h-7 bg-red-500/90 hover:bg-red-600 rounded-full flex items-center justify-center z-10 transition-colors shadow-lg"
                              >
                                <span className="iconify ph--x-bold w-4 h-4 text-white" />
                              </button>

                              {/* Image preview with overlay */}
                              <label htmlFor="tokenLogo" className="cursor-pointer block relative">
                                <img
                                  src={URL.createObjectURL(tokenLogoPreview)}
                                  alt="Token Logo Preview"
                                  className="w-full h-32 object-contain mb-2 rounded-lg"
                                />

                                {/* Hover overlay */}
                                <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex flex-col items-center justify-center gap-2">
                                  <span className="iconify ph--pencil-simple-bold w-6 h-6 text-purple-300" />
                                  <span className="text-purple-300 text-sm font-medium">Change Image</span>
                                </div>
                              </label>

                              <input
                                type="file"
                                id="tokenLogo"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    field.handleChange(file);
                                    setTokenLogoPreview(file);
                                  }
                                }}
                              />
                            </div>
                          ) : (
                            <div className="border-2 border-dashed border-purple-500/30 rounded-lg p-8 text-center bg-black/20 hover:border-purple-500/50 transition-all">
                              <span className="iconify w-6 h-6 mx-auto mb-2 text-purple-400 ph--upload-bold" />
                              <p className="text-gray-400 text-xs mb-2">PNG, JPG or SVG (max. 2MB)</p>
                              <input
                                type="file"
                                id="tokenLogo"
                                className="hidden"
                                onChange={(e) => {
                                  const file = e.target.files?.[0];
                                  if (file) {
                                    field.handleChange(file);
                                    setTokenLogoPreview(file);
                                  }
                                }}
                              />
                              <label
                                htmlFor="tokenLogo"
                                className="inline-block bg-purple-600/20 border border-purple-500/30 px-4 py-2 rounded-lg text-sm text-purple-200 hover:bg-purple-600/30 hover:border-purple-500/50 transition cursor-pointer"
                              >
                                Browse Files
                              </label>
                            </div>
                          )}
                        </>
                      ),
                    })}
                  </div>
                </div>
              </div>

              {/* Social Links Section */}
              <div className="bg-black/40 rounded-2xl p-8 backdrop-blur-md border border-purple-500/20 shadow-2xl shadow-purple-500/5">
                <div className="flex items-center gap-3 mb-6">
                  <div className="relative w-10 h-10 rounded-lg flex items-center justify-center overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 to-blue-500/20 blur-xl" />
                    <div className="relative bg-gradient-to-br from-purple-500/30 to-blue-500/30 rounded-lg w-full h-full flex items-center justify-center border border-purple-400/20">
                      <span className="iconify ph--share-network-bold w-6 h-6 text-purple-300" />
                    </div>
                  </div>
                  <h2 className="text-2xl font-bold text-white">Social Links (Optional)</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="mb-4">
                    <label
                      htmlFor="website"
                      className="block text-sm font-medium text-purple-200/80 mb-2"
                    >
                      Website
                    </label>
                    {form.Field({
                      name: 'website',
                      children: (field) => (
                        <input
                          id="website"
                          name={field.name}
                          type="url"
                          className="w-full p-3 bg-black/40 border border-purple-500/30 rounded-lg text-white placeholder:text-gray-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-all"
                          placeholder="https://yourwebsite.com"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      ),
                    })}
                  </div>

                  <div className="mb-4">
                    <label
                      htmlFor="twitter"
                      className="block text-sm font-medium text-purple-200/80 mb-2"
                    >
                      Twitter
                    </label>
                    {form.Field({
                      name: 'twitter',
                      children: (field) => (
                        <input
                          id="twitter"
                          name={field.name}
                          type="url"
                          className="w-full p-3 bg-black/40 border border-purple-500/30 rounded-lg text-white placeholder:text-gray-500 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 transition-all"
                          placeholder="https://twitter.com/yourusername"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      ),
                    })}
                  </div>
                </div>
              </div>

              {form.state.errors && form.state.errors.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 space-y-2">
                  {form.state.errors.map((error, index) =>
                    Object.entries(error || {}).map(([, value]) => (
                      <div key={index} className="flex items-start gap-2">
                        <span className="iconify ph--warning-circle-bold w-5 h-5 text-red-400 mt-0.5" />
                        <p className="text-red-300">
                          {Array.isArray(value)
                            ? value.map((v: any) => v.message || v).join(', ')
                            : typeof value === 'string'
                              ? value
                              : String(value)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}

              <div className="flex justify-center pt-4">
                <SubmitButton isSubmitting={isLoading} />
              </div>
            </form>
          )}
        </main>
      </div>
    </>
  );
}

const SubmitButton = ({ isSubmitting }: { isSubmitting: boolean }) => {
  const { publicKey } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();

  if (!publicKey) {
    return (
      <Button
        type="button"
        onClick={() => setShowModal(true)}
        className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white border-0 px-8 py-6 text-lg font-semibold rounded-xl shadow-lg shadow-purple-500/30"
      >
        <span>Connect Wallet to Launch</span>
      </Button>
    );
  }

  return (
    <Button
      className="bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white border-0 px-8 py-6 text-lg font-semibold rounded-xl shadow-lg shadow-purple-500/30 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-3"
      type="submit"
      disabled={isSubmitting}
    >
      {isSubmitting ? (
        <>
          <span className="iconify ph--spinner w-6 h-6 animate-spin" />
          <span>Launching Token...</span>
        </>
      ) : (
        <>
          <span className="iconify ph--rocket-launch-bold w-6 h-6" />
          <span>Launch Token</span>
        </>
      )}
    </Button>
  );
};

const PoolCreationSuccess = () => {
  return (
    <>
      <div className="bg-gradient-to-br from-purple-900/40 to-blue-900/40 rounded-2xl p-12 backdrop-blur-md border border-purple-500/30 text-center shadow-2xl shadow-purple-500/20">
        <div className="relative inline-flex mb-8">
          <div className="absolute inset-0 bg-purple-500 rounded-full blur-2xl opacity-30" />
          <div className="relative bg-purple-500/20 p-6 rounded-full ring-4 ring-purple-500/10">
            <span className="iconify ph--check-circle-bold w-16 h-16 text-purple-300" />
          </div>
        </div>
        <h2 className="text-4xl font-bold mb-4 bg-gradient-to-r from-purple-300 via-blue-300 to-pink-300 bg-clip-text text-transparent">
          Token Launched Successfully!
        </h2>
        <p className="text-gray-300 mb-10 max-w-lg mx-auto text-lg">
          Your token is now live on TrenchFun! Users can start discovering and trading your token.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link
            href="/"
            className="bg-black/40 hover:bg-black/60 px-8 py-4 rounded-xl font-semibold transition border border-purple-500/30 hover:border-purple-400/50 flex items-center justify-center gap-2"
          >
            <span className="iconify ph--compass-bold w-5 h-5" />
            <span>Explore Tokens</span>
          </Link>
          <button
            onClick={() => {
              window.location.reload();
            }}
            className="cursor-pointer bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 px-8 py-4 rounded-xl font-semibold transition shadow-lg shadow-purple-500/30 flex items-center justify-center gap-2"
          >
            <span className="iconify ph--plus-bold w-5 h-5" />
            <span>Launch Another Token</span>
          </button>
        </div>
      </div>
    </>
  );
};
