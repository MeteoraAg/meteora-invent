import { TokenPageMsgHandler } from '@/components/Token/TokenPageMsgHandler';
import { TokenChart } from '@/components/TokenChart/TokenChart';
import { TokenDetails } from '@/components/TokenHeader/TokenDetail';
import { TokenHeader } from '@/components/TokenHeader/TokenHeader';
import { TokenStats } from '@/components/TokenHeader/TokenStats';
import { TokenBottomPanel } from '@/components/TokenTable';
import Page from '@/components/ui/Page/Page';
import { DataStreamProvider, useDataStream } from '@/contexts/DataStreamProvider';
import { TokenChartProvider } from '@/contexts/TokenChartProvider';
import { useTokenAddress, useTokenInfo } from '@/hooks/queries';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';

const Terminal = dynamic(() => import('@/components/Terminal'), { ssr: false });

const SwapWidget = () => {
  const tokenId = useTokenAddress();

  if (!tokenId) {
    return null;
  }

  return <Terminal mint={tokenId} />;
};

export const TokenPageWithContext = () => {
  const tokenId = useTokenAddress();
  const { data: poolId } = useTokenInfo((data) => data?.id);
  const { subscribeTxns, unsubscribeTxns, subscribePools, unsubscribePools } = useDataStream();

  // Subscribe to token txns
  useEffect(() => {
    if (!tokenId) {
      return;
    }
    subscribeTxns([tokenId]);
    return () => {
      unsubscribeTxns([tokenId]);
    };
  }, [tokenId, subscribeTxns, unsubscribeTxns]);

  useEffect(() => {
    if (!poolId) {
      return;
    }

    subscribePools([poolId]);
    return () => {
      unsubscribePools([poolId]);
    };
    // dont track tokenId to prevent data mismatch
  }, [poolId, subscribePools, unsubscribePools]);

  return (
    <Page>
      <TokenPageMsgHandler />

      {/* On lg+ the page fits the viewport exactly (100vh minus 64px header,
          12px top gutter and 32px bottom gutter) and panels scroll internally */}
      <div className="flex flex-col lg:h-[calc(100vh-108px)]">
        <div className="mb-4 flex shrink-0 rounded-lg border border-neutral-700 p-3">
          <TokenHeader className="max-sm:order-1" />
        </div>

        <div className="flex w-full flex-col gap-4 md:flex-row lg:min-h-0 lg:flex-1">
          <div className="flex flex-col gap-4 max-lg:mb-8 max-sm:w-full max-sm:order-3 lg:min-w-[400px] lg:overflow-y-auto">
            <TokenDetails />
            <div>
              <SwapWidget />
            </div>
          </div>

          <div className="flex w-full flex-col border-neutral-850 max-sm:order-2 lg:min-h-0">
            <div className="shrink-0">
              <TokenStats key={`token-stats-${poolId}`} />
            </div>

            {/* Chart caps at 500px but shrinks on short screens so the tables keep room */}
            <div className="flex h-[300px] w-full shrink-0 flex-col lg:h-[min(500px,55vh)]">
              <TokenChartProvider>
                <TokenChart />
              </TokenChartProvider>
            </div>

            {/* Mobile: one screen tall; lg+: fills the space left under the chart.
                Both ways the txns/holders tables scroll internally. */}
            <TokenBottomPanel className="flex flex-col overflow-hidden max-lg:h-screen lg:min-h-0 lg:flex-1" />
          </div>
        </div>
      </div>
    </Page>
  );
};

export default function TokenPage() {
  return (
    <DataStreamProvider>
      <TokenPageWithContext />
    </DataStreamProvider>
  );
}
