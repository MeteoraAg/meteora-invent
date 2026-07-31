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

const inputClassName =
  'w-full rounded-lg border border-neutral-750 bg-background p-3 text-sm text-foreground placeholder:text-neutral-500 transition-colors focus:border-primary/60 focus:outline-none focus:ring-1 focus:ring-primary/40';

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
        const signedTransaction = await signTransaction(transaction);

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
          throw new Error(error.error);
        }

        const { success } = await sendResponse.json();
        if (success) {
          toast.success('Pool created successfully');
          setPoolCreated(true);
        }
      } catch (error) {
        console.error('Error creating pool:', error);
        toast.error(error instanceof Error ? error.message : 'Failed to create pool');
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
        <title>Create Pool - Virtual Curve</title>
        <meta
          name="description"
          content="Create a new token pool on Virtual Curve with customizable price curves."
        />
      </Head>

      <div className="min-h-screen bg-background text-foreground">
        {/* Header */}
        <Header />

        {/* Page Content */}
        <main className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 md:mb-10">
            <div>
              <h1 className="text-3xl md:text-4xl font-bold mb-2 tracking-tight">Create Pool</h1>
              <p className="text-neutral-400">Launch your token with a customizable price curve</p>
            </div>
          </div>

          {poolCreated && !isLoading ? (
            <PoolCreationSuccess />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                form.handleSubmit();
              }}
              className="space-y-8"
            >
              {/* Token Details Section */}
              <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5 sm:p-8">
                <h2 className="text-xl md:text-2xl font-bold mb-4">Token Details</h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div>
                    <div className="mb-4">
                      <label
                        htmlFor="tokenName"
                        className="block text-sm font-medium text-neutral-300 mb-1.5"
                      >
                        Token Name*
                      </label>
                      <form.Field name="tokenName">
                        {(field) => (
                          <input
                            id="tokenName"
                            name={field.name}
                            type="text"
                            className={inputClassName}
                            placeholder="e.g. Virtual Coin"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            required
                            minLength={3}
                          />
                        )}
                      </form.Field>
                    </div>

                    <div className="mb-4">
                      <label
                        htmlFor="tokenSymbol"
                        className="block text-sm font-medium text-neutral-300 mb-1.5"
                      >
                        Token Symbol*
                      </label>
                      <form.Field name="tokenSymbol">
                        {(field) => (
                          <input
                            id="tokenSymbol"
                            name={field.name}
                            type="text"
                            className={inputClassName}
                            placeholder="e.g. VRTL"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            required
                            maxLength={10}
                          />
                        )}
                      </form.Field>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="tokenLogo"
                      className="block text-sm font-medium text-neutral-300 mb-1.5"
                    >
                      Token Logo*
                    </label>
                    <form.Field name="tokenLogo">
                      {(field) => (
                        <div className="rounded-lg border-2 border-dashed border-neutral-750 p-6 sm:p-8 text-center transition-colors hover:border-neutral-600">
                          <span className="iconify w-6 h-6 mx-auto mb-2 text-neutral-500 ph--upload-bold" />
                          <p className="text-neutral-500 text-xs mb-3">
                            {field.state.value?.name ?? 'PNG, JPG or SVG (max. 2MB)'}
                          </p>
                          <input
                            type="file"
                            id="tokenLogo"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                field.handleChange(file);
                              }
                            }}
                          />
                          <label
                            htmlFor="tokenLogo"
                            className="inline-flex cursor-pointer items-center rounded-full border border-neutral-750 px-4 py-2 text-sm font-medium text-neutral-200 transition-colors hover:bg-neutral-900"
                          >
                            Browse Files
                          </label>
                        </div>
                      )}
                    </form.Field>
                  </div>
                </div>
              </div>

              {/* Social Links Section */}
              <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-5 sm:p-8">
                <h2 className="text-xl md:text-2xl font-bold mb-6">Social Links (Optional)</h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="mb-4">
                    <label
                      htmlFor="website"
                      className="block text-sm font-medium text-neutral-300 mb-1.5"
                    >
                      Website
                    </label>
                    <form.Field name="website">
                      {(field) => (
                        <input
                          id="website"
                          name={field.name}
                          type="url"
                          className={inputClassName}
                          placeholder="https://yourwebsite.com"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      )}
                    </form.Field>
                  </div>

                  <div className="mb-4">
                    <label
                      htmlFor="twitter"
                      className="block text-sm font-medium text-neutral-300 mb-1.5"
                    >
                      Twitter
                    </label>
                    <form.Field name="twitter">
                      {(field) => (
                        <input
                          id="twitter"
                          name={field.name}
                          type="url"
                          className={inputClassName}
                          placeholder="https://twitter.com/yourusername"
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        />
                      )}
                    </form.Field>
                  </div>
                </div>
              </div>

              {form.state.errors && form.state.errors.length > 0 && (
                <div className="rounded-lg border border-rose/40 bg-rose/10 p-4 space-y-2">
                  {form.state.errors.map((error, index) =>
                    Object.entries(error || {}).map(([, value]) => (
                      <div key={index} className="flex items-start gap-2">
                        <span className="iconify mt-0.5 h-4 w-4 shrink-0 text-rose ph--warning-circle-bold" />
                        <p className="text-sm text-rose">
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

              <div className="flex justify-end">
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
      <Button type="button" onClick={() => setShowModal(true)}>
        <span>Connect Wallet</span>
      </Button>
    );
  }

  return (
    <Button className="flex items-center gap-2" type="submit" disabled={isSubmitting}>
      {isSubmitting ? (
        <>
          <span className="iconify ph--spinner w-5 h-5 animate-spin" />
          <span>Creating Pool...</span>
        </>
      ) : (
        <>
          <span className="iconify ph--rocket-bold w-5 h-5" />
          <span>Launch Pool</span>
        </>
      )}
    </Button>
  );
};

const PoolCreationSuccess = () => {
  return (
    <>
      <div className="rounded-xl border border-neutral-850 bg-neutral-925 p-6 sm:p-8 text-center">
        <div className="bg-emerald/15 p-4 rounded-full inline-flex mb-6">
          <span className="iconify ph--check-bold w-12 h-12 text-emerald" />
        </div>
        <h2 className="text-2xl md:text-3xl font-bold mb-4">Pool Created Successfully!</h2>
        <p className="text-neutral-400 mb-8 max-w-lg mx-auto">
          Your token pool has been created and is now live on the Virtual Curve platform. Users can
          now buy and trade your tokens.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 justify-center">
          <Link
            href="/"
            className="rounded-full border border-neutral-750 px-6 py-3 font-medium text-neutral-200 transition-colors hover:bg-neutral-900"
          >
            Explore Pools
          </Link>
          <button
            onClick={() => {
              window.location.reload();
            }}
            className="cursor-pointer rounded-full bg-primary px-6 py-3 font-semibold text-primary-950 transition-colors hover:bg-primary-300"
          >
            Create Another Pool
          </button>
        </div>
      </div>
    </>
  );
};
