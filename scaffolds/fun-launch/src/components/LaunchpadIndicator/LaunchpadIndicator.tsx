import { useMemo } from 'react';

import { useTrenchesTokenIconContext } from '../TokenIcon/Context';
import { cn } from '@/lib/utils';
import { Asset } from '../Explore/types';
import { getLaunchpadInfo } from './info';

type LaunchpadIndicatorProps = {
  launchpad: Asset['launchpad'];
  className?: string;
};

type TrenchesTokenIconLaunchpadProps = {
  className?: string;
};

export const TrenchesTokenIconLaunchpad: React.FC<TrenchesTokenIconLaunchpadProps> = (props) => {
  const { token, width, height, hideLaunchpad } = useTrenchesTokenIconContext();

  if (hideLaunchpad === true || !token?.launchpad) {
    return null;
  }

  const isLargeIcon = width >= 40 && height >= 40;

  return (
    <LaunchpadIndicator
      {...props}
      launchpad={token?.launchpad}
      className={cn(props.className, {
        '[&_svg]:h-2.5 [&_svg]:w-2.5': isLargeIcon,
      })}
    />
  );
};

export const LaunchpadIndicator: React.FC<LaunchpadIndicatorProps> = ({ launchpad, className }) => {
  const config = useMemo(() => getLaunchpadInfo(launchpad), [launchpad]);

  if (!config) return null;

  const Icon = config.icon;

  return (
    <div
      className={cn(
        'absolute -bottom-px -right-1',
        // Fixed dark chip in both themes: the launchpad brand icons are drawn
        // with white fills and are illegible on a light background
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full border bg-[#0b0e13] p-0.5',
        className
      )}
      style={{ borderColor: config.borderColor }}
    >
      <Icon className="h-2 w-2" />
    </div>
  );
};
