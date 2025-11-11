import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import Link from 'next/link';
import { Button } from './ui/button';
import { CreatePoolButton } from './CreatePoolButton';
import { useMemo } from 'react';
import { shortenAddress } from '@/lib/utils';

export const Header = () => {
  const { setShowModal } = useUnifiedWalletContext();

  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  const handleConnectWallet = () => {
    // In a real implementation, this would connect to a Solana wallet
    setShowModal(true);
  };

  return (
    <header className="w-full px-6 py-5 flex items-center justify-between border-b border-white/5 bg-black">
      {/* Logo Section */}
      <Link href="/" className="flex items-center gap-3 group">
        <div className="relative">
          <div className="absolute inset-0 bg-gradient-to-r from-purple-500 to-blue-500 rounded-xl blur-sm opacity-50 group-hover:opacity-75 transition-opacity" />
          <div className="relative w-10 h-10 md:w-12 md:h-12 bg-gradient-to-br from-purple-500 via-pink-500 to-blue-500 rounded-xl flex items-center justify-center transform group-hover:scale-105 transition-all duration-300">
            <span className="text-white font-black text-xl md:text-2xl">T</span>
          </div>
        </div>
        <div className="flex flex-col">
          <span className="whitespace-nowrap text-xl md:text-3xl font-black tracking-tight bg-gradient-to-r from-white via-purple-200 to-blue-200 bg-clip-text text-transparent">
            TrenchFun
          </span>
          <span className="text-xs text-gray-500 font-medium -mt-1">FAIR LAUNCH</span>
        </div>
      </Link>

      {/* Navigation and Actions */}
      <div className="flex items-center gap-3">
        <CreatePoolButton />
        {address ? (
          <Button
            onClick={() => disconnect()}
            className="bg-white/5 hover:bg-white/10 border border-white/10 text-gray-300 hover:text-white transition-all"
          >
            {shortenAddress(address)}
          </Button>
        ) : (
          <Button
            onClick={() => {
              handleConnectWallet();
            }}
            className="relative group overflow-hidden bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-500 hover:to-blue-500 text-white border-0 shadow-lg shadow-purple-500/20"
          >
            <span className="relative z-10 hidden md:block">Connect Wallet</span>
            <span className="relative z-10 block md:hidden">Connect</span>
            <div className="absolute inset-0 bg-gradient-to-r from-purple-400 to-blue-400 opacity-0 group-hover:opacity-20 transition-opacity" />
          </Button>
        )}
      </div>
    </header>
  );
};

export default Header;
