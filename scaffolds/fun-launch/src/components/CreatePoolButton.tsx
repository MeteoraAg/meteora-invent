import Link from 'next/link';
import { cn } from '@/lib/utils';
import { buttonVariants } from './ui/button';

type CreatePoolButtonProps = {
  className?: string;
};

export const CreatePoolButton = ({ className }: CreatePoolButtonProps) => {
  return (
    <Link
      href="/create-pool"
      className={cn(buttonVariants({ variant: 'outline' }), className)}
    >
      <span className="iconify ph--rocket-bold h-4 w-4" />
      <span className="hidden sm:inline">Create Pool</span>
      <span className="sm:hidden">Create</span>
    </Link>
  );
};
