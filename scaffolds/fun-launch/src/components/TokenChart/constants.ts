export type ChartThemeColors = {
  /** Chart pane background */
  bg: string;
  /** Chart grid line color */
  grid: string;
  /** Accent color used for highlighted header buttons */
  accent: string;
};

export const CHART_THEME_COLORS: Record<'dark' | 'light', ChartThemeColors> = {
  dark: {
    bg: '#0b0e13', // neutral-950
    grid: '#182430', // neutral-850
    accent: '#c7f284', // primary
  },
  light: {
    bg: '#ffffff',
    grid: '#e2e8f0',
    accent: '#4d7c0f', // primary
  },
};
