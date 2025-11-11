import React from 'react';
import { ToggleGroup as ToggleGroupPrimitive } from 'radix-ui';
import { useExplore } from '@/contexts/ExploreProvider';
import { ExploreTab } from './types';
import { PausedIndicator } from './PausedIndicator';
import { cn } from '@/lib/utils';

export const ExploreTabTitleMap: Record<ExploreTab, string> = {
  [ExploreTab.NEW]: `🚀 Fresh`,
  [ExploreTab.GRADUATING]: `📈 Trending`,
  [ExploreTab.GRADUATED]: `✅ Bonded`,
};

export const MobileExploreTabs = () => {
  const { mobileTab, setMobileTab, pausedTabs } = useExplore();
  return (
    <div className="sticky inset-x-0 top-0 z-20 border-b border-purple-500/10 shadow-lg shadow-black/50 lg:hidden bg-black/90 backdrop-blur-md">
      <div className="px-2 py-1">
        <ToggleGroupPrimitive.Root
          className="flex h-9 w-full min-w-fit items-center gap-1 text-sm"
          type="single"
          value={mobileTab}
          onValueChange={(value) => {
            if (value) {
              setMobileTab(value as ExploreTab);
            }
          }}
        >
          <ToggleGroupItem value={ExploreTab.NEW}>
            {ExploreTabTitleMap[ExploreTab.NEW]}
            {mobileTab === ExploreTab.NEW && pausedTabs[ExploreTab.NEW] && <PausedIndicator />}
          </ToggleGroupItem>
          <ToggleGroupItem value={ExploreTab.GRADUATING}>
            {ExploreTabTitleMap[ExploreTab.GRADUATING]}
            {mobileTab === ExploreTab.GRADUATING && pausedTabs[ExploreTab.GRADUATING] && (
              <PausedIndicator />
            )}
          </ToggleGroupItem>
          <ToggleGroupItem value={ExploreTab.GRADUATED}>
            {ExploreTabTitleMap[ExploreTab.GRADUATED]}
            {mobileTab === ExploreTab.GRADUATED && pausedTabs[ExploreTab.GRADUATED] && (
              <PausedIndicator />
            )}
          </ToggleGroupItem>
        </ToggleGroupPrimitive.Root>
      </div>
    </div>
  );
};

const ToggleGroupItem = React.forwardRef<
  React.ElementRef<typeof ToggleGroupPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>
>(({ className, ...props }, ref) => {
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      className={cn(
        'flex h-full w-full items-center justify-center gap-1 whitespace-nowrap rounded-lg px-3 text-gray-400 transition-all font-semibold',
        'data-[state=off]:hover:text-purple-400/80',
        'data-[state=on]:bg-purple-500/20 data-[state=on]:text-purple-300 data-[state=on]:border data-[state=on]:border-purple-500/40',
        'disabled:pointer-events-none disabled:opacity-50',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-purple-500',
        className
      )}
      {...props}
    />
  );
});
ToggleGroupItem.displayName = ToggleGroupPrimitive.Item.displayName;
