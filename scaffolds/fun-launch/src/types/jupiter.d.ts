/**
 * Jupiter Plugin type declarations
 *
 * Adapted from the official docs:
 * https://dev.jup.ag/docs/tool-kits/plugin/customization#full-typescript-declaration
 * https://github.com/jup-ag/plugin/blob/main/src/types/index.d.ts
 *
 * External types (wallet context, quotes, swap results) are kept loose to
 * avoid coupling to plugin-internal packages.
 */
import type { CSSProperties } from 'react';

declare global {
  interface Window {
    Jupiter: JupiterPlugin;
  }
}

export type WidgetPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
export type WidgetSize = 'sm' | 'default';
export type SwapMode = 'ExactInOrOut' | 'ExactIn' | 'ExactOut';
export type DefaultExplorer = 'Solana Explorer' | 'Solscan' | 'Solana Beach' | 'SolanaFM';

export interface FormProps {
  swapMode?: SwapMode;
  initialAmount?: string;
  initialInputMint?: string;
  initialOutputMint?: string;
  fixedAmount?: boolean;
  fixedMint?: string;
  referralAccount?: string;
  referralFee?: number;
}

export interface JupiterPluginInit {
  localStoragePrefix?: string;
  formProps?: FormProps;
  defaultExplorer?: DefaultExplorer;
  autoConnect?: boolean;
  displayMode?: 'modal' | 'integrated' | 'widget';
  integratedTargetId?: string;
  widgetStyle?: {
    position?: WidgetPosition;
    size?: WidgetSize;
  };
  containerStyles?: CSSProperties;
  containerClassName?: string;
  branding?: {
    logoUri?: string;
    name?: string;
  };
  enableWalletPassthrough?: boolean;
  passthroughWalletContextState?: unknown;
  onRequestConnectWallet?: () => void | Promise<void>;
  onSwapError?: (params: { error?: unknown; quoteResponseMeta: unknown }) => void;
  onSuccess?: (params: { txid: string; swapResult: unknown; quoteResponseMeta: unknown }) => void;
  onFormUpdate?: (form: unknown) => void;
  onScreenUpdate?: (screen: unknown) => void;
}

export interface JupiterPlugin {
  init: (props: JupiterPluginInit) => void;
  resume: () => void;
  close: () => void;
  enableWalletPassthrough: boolean;
  onRequestConnectWallet: JupiterPluginInit['onRequestConnectWallet'];
  syncProps: (props: {
    passthroughWalletContextState?: JupiterPluginInit['passthroughWalletContextState'];
  }) => void;
  onSwapError: JupiterPluginInit['onSwapError'];
  onSuccess: JupiterPluginInit['onSuccess'];
  onFormUpdate: JupiterPluginInit['onFormUpdate'];
  onScreenUpdate: JupiterPluginInit['onScreenUpdate'];
  localStoragePrefix: string;
}

export {};
