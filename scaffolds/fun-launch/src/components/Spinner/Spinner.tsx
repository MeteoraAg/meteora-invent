import { cn } from '@/lib/utils';

const Spinner = ({
  className,
  baseColor = 'currentColor',
  spinnerColor = 'currentColor',
  width = 20,
  height = 20,
}: {
  className?: string;
  baseColor?: string;
  spinnerColor?: string;
  width?: React.CSSProperties['width'];
  height?: React.CSSProperties['height'];
}) => (
  <div
    className={cn(`flex items-center justify-center rounded-full`, className)}
    style={{ width, height }}
  >
    <svg
      className="animate-spin text-current"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width={width}
      height={height}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke={baseColor}
        strokeWidth="4"
      ></circle>
      <path
        className="opacity-75"
        fill={spinnerColor}
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      ></path>
    </svg>
  </div>
);

export default Spinner;
