import Header from '@/components/Header';
import { cn } from '@/lib/utils';

interface IProps {
  containerClassName?: string;
  pageClassName?: string;
}

const Page: React.FC<React.PropsWithChildren<IProps>> = ({
  containerClassName,
  children,
  pageClassName,
}) => {
  return (
    <div
      className={cn(
        'flex min-h-screen flex-col justify-between bg-background text-foreground',
        pageClassName
      )}
    >
      <Header />
      {/* Full-width content with a modest gutter around it */}
      <div
        className={cn(
          'flex flex-1 flex-col items-center px-2 pt-3 pb-8 md:px-4',
          containerClassName
        )}
      >
        <div className="flex w-full flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
};

export default Page;
