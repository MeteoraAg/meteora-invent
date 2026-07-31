import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { useEffect, useState } from 'react';
import { Skeleton } from '../ui/Skeleton';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PLUGIN_CONTAINER_ID = 'jupiter-plugin';
const PLUGIN_HEIGHT = 568;

/**
 * Jupiter Plugin (successor of Jupiter Terminal) in integrated display mode.
 *
 * @see https://dev.jup.ag/docs/tool-kits/plugin
 * @see https://github.com/jup-ag/plugin
 */
export function TerminalComponent({ mint }: { mint: string }) {
  const walletContext = useWallet();
  const { setShowModal } = useUnifiedWalletContext();

  const [isReady, setIsReady] = useState(false);

  // The plugin script is loaded with `defer`, so poll until it is available
  useEffect(() => {
    if (typeof window.Jupiter?.init === 'function') {
      setIsReady(true);
      return;
    }

    const intervalId = setInterval(() => {
      if (typeof window.Jupiter?.init === 'function') {
        setIsReady(true);
        clearInterval(intervalId);
      }
    }, 250);

    return () => clearInterval(intervalId);
  }, []);

  // (Re-)initialize the plugin when it is ready or the token changes
  useEffect(() => {
    if (!isReady) {
      return;
    }

    window.Jupiter.init({
      displayMode: 'integrated',
      integratedTargetId: PLUGIN_CONTAINER_ID,
      // A fixed height prevents the token search modal from collapsing the
      // plugin, see https://dev.jup.ag/docs/tool-kits/plugin/faq
      containerStyles: {
        height: `${PLUGIN_HEIGHT}px`,
      },
      formProps: {
        initialInputMint: SOL_MINT,
        initialOutputMint: mint,
      },
      // Reuse the app's wallet connection instead of the plugin's own adapter
      enableWalletPassthrough: true,
      passthroughWalletContextState: walletContext,
      onRequestConnectWallet: () => setShowModal(true),
    });

    return () => {
      window.Jupiter?.close?.();
    };
    // walletContext is synced separately below to avoid re-initializing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, mint, setShowModal]);

  // Keep the plugin's wallet state in sync with the app's wallet
  useEffect(() => {
    if (!isReady || !window.Jupiter?.syncProps) {
      return;
    }
    window.Jupiter.syncProps({
      passthroughWalletContextState: walletContext,
    });
  }, [isReady, walletContext]);

  return (
    <div className="flex h-full w-full flex-col">
      {!isReady ? (
        <div className="flex w-full flex-col items-center justify-start gap-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <span className="mt-4 text-sm text-neutral-500">Loading Jupiter Plugin...</span>
        </div>
      ) : (
        <div
          id={PLUGIN_CONTAINER_ID}
          className="w-full overflow-hidden"
          style={{ height: PLUGIN_HEIGHT }}
        />
      )}
    </div>
  );
}

export default TerminalComponent;
