import { useDataStream } from '@/contexts/DataStreamProvider';
import { useEffect } from 'react';
import { ExploreTab } from './types';
import { ExploreColumn } from './ExploreColumn';
import { cn } from '@/lib/utils';
import { MobileExploreTabs } from './MobileExploreTabs';
import { useExplore } from '@/contexts/ExploreProvider';
import { useBreakpoint } from '@/lib/device';

type ExploreGridProps = {
  className?: string;
};

const ExploreGrid = ({ className }: ExploreGridProps) => {
  const { subscribeRecentTokenList, unsubscribeRecentTokenList } = useDataStream();
  const { mobileTab } = useExplore();
  const breakpoint = useBreakpoint();

  useEffect(() => {
    subscribeRecentTokenList();
    return () => {
      unsubscribeRecentTokenList();
    };
  }, [subscribeRecentTokenList, unsubscribeRecentTokenList]);

  const isMobile = breakpoint === 'md' || breakpoint === 'sm' || breakpoint === 'xs';

  return (
    <div
      className={cn(
        'grid grid-cols-1 border-neutral-850 max-lg:grid-rows-[auto_1fr] lg:grid-cols-3 lg:border xl:overflow-hidden lg:rounded-xl',
        className
      )}
    >
      <MobileExploreTabs />

      <div className="contents divide-x divide-neutral-850">
        <ExploreColumn tab={isMobile ? mobileTab : ExploreTab.NEW} />
        {!isMobile && <ExploreColumn tab={ExploreTab.GRADUATING} />}
        {!isMobile && <ExploreColumn tab={ExploreTab.GRADUATED} />}
      </div>
    </div>
  );
};

export default ExploreGrid;
