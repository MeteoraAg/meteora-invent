import { Popover as PopoverPrimitive } from 'radix-ui';
import { forwardRef } from 'react';

import { HoverPopover, useHoverPopover } from './context';
import { cn } from '@/lib/utils';

/**
 * Wrapper for radix-ui popover trigger component.
 * Popover content is triggered via the following methods:
 * - Desktop: hover on popover trigger
 * - Mobile: click on popover trigger
 *
 * More details, @see https://www.radix-ui.com/primitives/docs/components/popover#trigger
 */
// eslint-disable-next-line react/display-name
const HoverPopoverTrigger = forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Trigger>
>(({ className, ...props }) => {
  const { handleMouseEnter, handleMouseLeave, open } = useHoverPopover();
  return (
    <PopoverPrimitive.Trigger
      className={cn('outline-none', className, { 'z-50': open })}
      {...props}
      onMouseLeave={handleMouseLeave}
      onMouseEnter={handleMouseEnter}
    />
  );
});

export type HoverPopoverTriggerProps = React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Trigger
>;

export type HoverPopoverContentProps = React.ComponentPropsWithoutRef<
  typeof PopoverPrimitive.Content
> & {
  /**
   * Retain popover content while mouse is still
   * hovering on content
   */
  retainOnContentHover?: boolean | undefined;
  /**
   * Include overlay backdrop on hover
   */
  backdrop?: boolean | undefined;
  /**
   * Enable pointer events on backdrop
   */
  backdropClickable?: boolean | undefined;
  /**
   * Render the popover content in a portal
   *
   * Useful for positioning outside of parent containers with overflow:hidden
   *
   * @default true
   */
  portal?: boolean | undefined;
};

/**
 * Wrapper for radix-ui popover content component.
 * Popover content is closed via the following methods:
 * - Desktop: hover off popover content
 * - Mobile: another element is clicked/tapped on
 *
 * More details, @see https://www.radix-ui.com/primitives/docs/components/popover#trigger
 */
const HoverPopoverContent = forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  HoverPopoverContentProps
>(
  (
    {
      className,
      retainOnContentHover,
      backdrop,
      backdropClickable,
      portal = true,
      children,
      ...props
    },
    ref
  ) => {
    const { handleMouseEnter, handleMouseLeave, open } = useHoverPopover();

    const content = (
      <>
        {backdrop && open && (
          <div
            className={cn('fixed inset-0 z-10 bg-black/10 backdrop-blur-sm', {
              'animate-fade-in': open,
              'animate-fade-out': !open,
              'pointer-events-none': !backdropClickable,
            })}
          />
        )}
        <PopoverPrimitive.Content
          ref={ref}
          {...props}
          className={cn(
            'z-50 w-full max-w-[360px] rounded-lg border border-neutral-800 bg-neutral-925 p-2 text-xs text-neutral-100 shadow-xl outline-none',
            className
          )}
          onMouseEnter={retainOnContentHover ? handleMouseEnter : undefined}
          onMouseLeave={handleMouseLeave}
        >
          {children}
        </PopoverPrimitive.Content>
      </>
    );

    return <>{portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content}</>;
  }
);

// Add display name for better debugging
HoverPopoverContent.displayName = 'HoverPopoverContent';

export { HoverPopover, HoverPopoverContent, HoverPopoverTrigger };
