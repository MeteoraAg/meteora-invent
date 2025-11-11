import Link from 'next/link';
import { Button } from './ui/button';

export const CreatePoolButton = () => {
  return (
    <Button className="bg-purple-600/10 hover:bg-purple-600/20 border border-purple-500/30 text-purple-300 hover:text-purple-200 transition-all">
      <Link href="/create-pool" className="flex items-center gap-2">
        <span className="iconify ph--rocket-launch-bold w-4 h-4" />
        <span className="hidden sm:inline">Launch Token</span>
        <span className="sm:hidden">Launch</span>
      </Link>
    </Button>
  );
};
