'use client';

import { useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { categorySortBy, categorySortDir, createPoolSorter } from '@/components/Explore/pool-utils';
import { ApeQueries, GemsTokenListQueryArgs, QueryData } from '@/components/Explore/queries';
import { ExploreTab, TokenListSortByField, normalizeSortByField } from '@/components/Explore/types';
import { TokenCardList } from '@/components/TokenCard/TokenCardList';
import { useExploreGemsTokenList } from '@/hooks/useExploreGemsTokenList';
import { EXPLORE_FIXED_TIMEFRAME, useExplore } from '@/contexts/ExploreProvider';
import { Pool } from '@/contexts/types';
import { isHoverableDevice, useBreakpoint } from '@/lib/device';
import { PausedIndicator } from './PausedIndicator';

type ExploreColumnProps = {
  tab: ExploreTab;
};

export const ExploreTabTitleMap: Record<ExploreTab, string> = {
  [ExploreTab.NEW]: `Fresh Launches`,
  [ExploreTab.GRADUATING]: `Trending Up`,
  [ExploreTab.GRADUATED]: `Bonded`,
};

export const ExploreColumn: React.FC<ExploreColumnProps> = ({ tab }) => {
  const { pausedTabs, setTabPaused, request } = useExplore();
  const isPaused = pausedTabs[tab];
  const setIsPaused = useCallback(
    (paused: boolean) => setTabPaused(tab, paused),
    [setTabPaused, tab]
  );

  return (
    <div className="flex flex-col h-full lg:h-[calc(100vh-300px)]">
      {/* Desktop Column Header */}
      <div className="flex items-center justify-between px-5 py-4 max-lg:hidden bg-black/40 border-b border-purple-500/10 backdrop-blur-sm">
        <div className="flex items-center gap-x-2">
          <h2 className="font-bold text-base text-white">{ExploreTabTitleMap[tab]}</h2>
          {isPaused && <PausedIndicator />}
        </div>
      </div>

      {/* List */}
      <div className="relative flex-1 text-xs h-full bg-black/20">
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-3 bg-gradient-to-b from-black via-black/50 to-transparent" />
        <TokenCardListContainer
          tab={tab}
          request={request}
          isPaused={isPaused}
          setIsPaused={setIsPaused}
        />
      </div>
    </div>
  );
};

type TokenCardListContainerProps = {
  tab: ExploreTab;
  request: Required<GemsTokenListQueryArgs>;
  isPaused: boolean;
  setIsPaused: (isPaused: boolean) => void;
};

const timeframe = EXPLORE_FIXED_TIMEFRAME;

const TokenCardListContainer: React.FC<TokenCardListContainerProps> = memo(
  ({ tab, request, isPaused, setIsPaused }) => {
    const queryClient = useQueryClient();
    const breakpoint = useBreakpoint();
    const isMobile = breakpoint === 'md' || breakpoint === 'sm' || breakpoint === 'xs';

    const listRef = useRef<HTMLDivElement>(null);

    const { data: currentData, status } = useExploreGemsTokenList((data) => data[tab]);

    const [snapshotData, setSnapshotData] = useState<Pool[]>();

    const handleMouseEnter = useCallback(() => {
      if (!isHoverableDevice() || status !== 'success') {
        return;
      }

      // When clicking elements (copyable) it triggers mouse enter again
      // We don't want to re-snapshot data if already paused
      if (!isPaused) {
        setSnapshotData(currentData?.pools);
      }
      setIsPaused(true);
    }, [currentData?.pools, isPaused, setIsPaused, status]);

    const handleMouseLeave = useCallback(() => {
      if (!isHoverableDevice()) return;

      setIsPaused(false);
    }, [setIsPaused]);

    // Mutate the args so stream sorts by timeframe
    useEffect(() => {
      queryClient.setQueriesData(
        {
          type: 'active',
          queryKey: ApeQueries.gemsTokenList(request).queryKey,
        },
        (prev?: QueryData<typeof ApeQueries.gemsTokenList>) => {
          const prevPools = prev?.[tab]?.pools;
          if (!prevPools) return;

          const pools = [...prevPools];

          // Re-sort
          const sortDir = categorySortDir(tab);
          let sortBy: TokenListSortByField | undefined;
          const defaultSortBy = categorySortBy(tab, timeframe);
          if (defaultSortBy) {
            sortBy = normalizeSortByField(defaultSortBy);
          }
          if (sortBy) {
            const sorter = createPoolSorter(
              {
                sortBy,
                sortDir,
              },
              timeframe
            );
            pools.sort(sorter);
          }

          return {
            ...prev,
            [tab]: {
              ...prev[tab],
              pools,
            },
            args: {
              ...prev?.args,
              timeframe,
            },
          };
        }
      );
    }, [queryClient, tab, request]);

    const handleScroll = useCallback(() => {
      if (!isMobile || !listRef.current) return;

      const top = listRef.current.getBoundingClientRect().top;

      if (top <= 0) {
        // Only snapshot on initial pause
        if (!isPaused) {
          setSnapshotData(currentData?.pools);
        }
        setIsPaused(true);
      } else {
        setIsPaused(false);
      }
    }, [currentData?.pools, isPaused, setIsPaused, isMobile]);

    // Handle scroll pausing on mobile
    useEffect(() => {
      if (!isMobile) return;

      // Initial check
      handleScroll();

      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => {
        window.removeEventListener('scroll', handleScroll);
        setIsPaused(false);
      };
    }, [isMobile, setIsPaused, handleScroll]);

    // Map snapshot data to current data for most recent updated data
    const displayData = isPaused
      ? snapshotData?.map((snapshotPool) => {
        const current = currentData?.pools.find(
          (p) => p.baseAsset.id === snapshotPool.baseAsset.id
        );
        if (current) {
          return current;
        }
        return snapshotPool;
      })
      : currentData?.pools;

    return (
      <TokenCardList
        ref={listRef}
        data={displayData}
        status={status}
        timeframe={timeframe}
        trackPools
        className="lg:h-0 lg:min-h-full"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      />
    );
  }
);

TokenCardListContainer.displayName = 'TokenCardListContainer';
