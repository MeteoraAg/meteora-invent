import ExploreGrid from './ExploreGrid';
import { DataStreamProvider } from '@/contexts/DataStreamProvider';
import { ExploreMsgHandler } from './ExploreMsgHandler';
import { ExploreProvider } from '@/contexts/ExploreProvider';
import { PropsWithChildren } from 'react';

const Explore = () => {
  return (
    <ExploreContext>
      <ExploreGrid className="flex-1" />
    </ExploreContext>
  );
};

const ExploreContext = ({ children }: PropsWithChildren) => {
  return (
    <div className="flex flex-col h-full">
      <ExploreMsgHandler />

      <ExploreProvider>
        <DataStreamProvider>{children}</DataStreamProvider>
      </ExploreProvider>
    </div>
  );
};

export default Explore;
