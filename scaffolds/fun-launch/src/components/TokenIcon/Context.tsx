import { createContext, useContext } from 'react';
import { Asset } from '../Explore/types';

export type TokenIconInfo = {
  readonly logoURI?: string;
  readonly symbol: string;
  launchpad?: Asset['launchpad'];
};

type TrenchesTokenIconContextValue = {
  token: TokenIconInfo | undefined | null;
  width: number;
  height: number;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  hideLaunchpad?: boolean;
  isValid: boolean;
  isCdnValid: boolean;
  resolvedSrc: string | undefined;
  transformedSrc: string | undefined;
  handleImageError: React.ReactEventHandler<HTMLImageElement>;
  setIsValid: React.Dispatch<React.SetStateAction<boolean>>;
  setIsCdnValid: React.Dispatch<React.SetStateAction<boolean>>;
};

export const TrenchesTokenIconContext = createContext<TrenchesTokenIconContextValue | null>(null);

export const useTrenchesTokenIconContext = () => {
  const context = useContext(TrenchesTokenIconContext);
  if (!context) {
    throw new Error('useTrenchesTokenIconContext must be used within a TrenchesTokenIconRoot');
  }
  return context;
};
