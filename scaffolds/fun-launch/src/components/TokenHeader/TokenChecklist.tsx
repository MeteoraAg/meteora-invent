import { useTokenInfo } from '@/hooks/queries';
import {
  AUDIT_MAX_SCORE,
  AUDIT_TOP_HOLDERS_THRESHOLD,
  getAuditScoreColorCn,
  isAuditTopHoldersPass,
} from '../Explore/pool-utils';
import React from 'react';
import { getAuditScore } from '../Explore/pool-utils';
import { cn } from '@/lib/utils';
import { HoverPopover, HoverPopoverContent, HoverPopoverTrigger } from '../ui/HoverPopover';
import { formatReadablePercentChange } from '@/lib/format/number';
import { useQuery } from '@tanstack/react-query';

type ChecklistProps = {
  className?: string;
};

export const Checklist: React.FC<ChecklistProps> = ({ className }) => {
  return (
    <div className={cn('flex flex-col gap-2 border border-neutral-700 rounded-lg p-2', className)}>
      <h2 className="flex items-center justify-between text-sm font-semibold">
        Checklist <ChecklistScore />
      </h2>
      <div className="flex flex-col gap-2">
        <ChecklistAuthority />
        <ChecklistTopHolders />
        <ChecklistGraduationLp />
      </div>
    </div>
  );
};

const ChecklistScore: React.FC = () => {
  const { data: audit } = useTokenInfo((data) => data?.baseAsset.audit);

  const auditScore = getAuditScore(audit);
  return (
    <div className={cn('font-normal', getAuditScoreColorCn(auditScore))}>
      {auditScore !== undefined ? auditScore + '/' + AUDIT_MAX_SCORE : '-'}
    </div>
  );
};

const ChecklistAuthority: React.FC = () => {
  const { data: audit } = useTokenInfo((data) => data?.baseAsset.audit);
  return (
    <div className="flex justify-between gap-1">
      <HoverPopover root={true}>
        <HoverPopoverTrigger>
          <div className="truncate text-sm text-neutral-500 underline decoration-neutral-700 decoration-dashed underline-offset-4 group-hover:decoration-neutral-200">
            Mint / Freeze
          </div>
        </HoverPopoverTrigger>

        <HoverPopoverContent>
          <AuditTooltipInfo
            approved={audit?.mintAuthorityDisabled}
            label={`Mint Auth Disabled`}
            description={`Ability to mint new tokens`}
          />
          <AuditTooltipInfo
            approved={audit?.freezeAuthorityDisabled}
            label={`Freeze Auth Disabled`}
            description={`Ability to freeze token account`}
          />
        </HoverPopoverContent>
      </HoverPopover>

      <div className={cn('inline-flex items-center text-sm')}>
        <div className={cn(audit?.mintAuthorityDisabled ? 'text-emerald' : 'text-rose')}>
          {audit?.mintAuthorityDisabled ? 'Disabled' : 'Enabled'}
        </div>
        <span className="px-1 text-xs text-neutral-750">&bull;</span>
        <div className={cn(audit?.freezeAuthorityDisabled ? 'text-emerald' : 'text-rose')}>
          {audit?.freezeAuthorityDisabled ? 'Disabled' : 'Enabled'}
        </div>
      </div>
    </div>
  );
};

const ChecklistTopHolders: React.FC = () => {
  const { data: audit } = useTokenInfo((data) => data?.baseAsset.audit);
  return (
    <div className="flex justify-between gap-1">
      <HoverPopover root={true}>
        <HoverPopoverTrigger>
          <div className="truncate text-sm text-neutral-500 underline decoration-neutral-700 decoration-dashed underline-offset-4 group-hover:decoration-neutral-200">
            Top 10 Holders
          </div>
        </HoverPopoverTrigger>
        <HoverPopoverContent>
          <AuditTooltipInfo
            approved={audit && isAuditTopHoldersPass(audit)}
            label={`Top 10 Holders < 15%`}
            description={`% owned by top 10 holders. Green check if top 10 holders owns less than ${AUDIT_TOP_HOLDERS_THRESHOLD.toFixed(0)}%`}
          />
        </HoverPopoverContent>
      </HoverPopover>

      <div
        className={cn(
          'inline-flex items-center text-sm',
          audit?.topHoldersPercentage === undefined
            ? 'text-neutral-500'
            : isAuditTopHoldersPass(audit)
              ? 'text-emerald'
              : 'text-rose'
        )}
      >
        {formatReadablePercentChange(
          audit?.topHoldersPercentage === undefined ? undefined : audit?.topHoldersPercentage / 100,
          { hideSign: 'positive' }
        )}
      </div>
    </div>
  );
};

type GraduationLp = { lockedPct: number; vestingPct: number; withdrawablePct: number };

// Share of the liquidity that stays locked in the DAMM pool after graduation, from the DBC pool's config. LP that is
// not permanently locked can be withdrawn by the partner or creator after graduation (or as it vests).
const ChecklistGraduationLp: React.FC = () => {
  const { data: poolId } = useTokenInfo((data) =>
    data?.dex === 'met-dbc' ? data.id : data?.baseAsset.firstPool?.id
  );
  const { data: lp } = useQuery({
    queryKey: ['graduation-lp', poolId],
    queryFn: async (): Promise<GraduationLp | null> => {
      const res = await fetch(`/api/graduation-lp?pool=${poolId}`);
      return res.ok ? res.json() : null;
    },
    enabled: !!poolId,
    staleTime: 60 * 60 * 1000,
  });

  if (!lp) {
    return null;
  }

  return (
    <div className="flex justify-between gap-1">
      <HoverPopover root={true}>
        <HoverPopoverTrigger>
          <div className="truncate text-sm text-neutral-500 underline decoration-neutral-700 decoration-dashed underline-offset-4 group-hover:decoration-neutral-200">
            Graduation LP
          </div>
        </HoverPopoverTrigger>
        <HoverPopoverContent>
          <AuditTooltipInfo
            approved={lp.lockedPct === 100}
            label={`${lp.lockedPct}% permanently locked`}
            description={`Set by the pool config. ${lp.withdrawablePct}% of the DAMM liquidity goes to the partner and creator as positions they can withdraw after graduation${lp.vestingPct ? `, and ${lp.vestingPct}% as it vests` : ''}.`}
          />
        </HoverPopoverContent>
      </HoverPopover>

      <div
        className={cn(
          'inline-flex items-center text-sm',
          lp.lockedPct === 100 ? 'text-emerald' : 'text-rose'
        )}
      >
        {lp.lockedPct}% locked
      </div>
    </div>
  );
};

export const AuditTooltipInfo: React.FC<{
  approved?: boolean;
  label: string;
  description: string;
}> = ({ approved, label, description }) => {
  return (
    <div
      className={cn('group space-y-1 text-neutral-200', {
        'opacity-40': !approved,
      })}
    >
      <div className="flex items-center gap-x-1.5">
        <div
          className={cn('flex size-4 items-center justify-center', {
            'text-primary': approved,
            'text-rose': !approved,
          })}
        >
          <span className="iconify text-primary ph--check-bold" />
        </div>
        <div className="mt-0.5 whitespace-pre text-left text-xs font-medium leading-3">{label}</div>
      </div>
      <p className="text-xs text-neutral-400">{description}</p>
    </div>
  );
};
