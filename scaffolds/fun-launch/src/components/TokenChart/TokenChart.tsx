import { CSSProperties, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocalStorage } from 'react-use';

import { useTheme } from 'next-themes';

import { createDataFeed } from './datafeed';
import { formatChartPrice, getPrecisionTickSizeText } from './formatter';
import { CHART_THEME_COLORS } from './constants';
import { ChartConfig, DEFAULT_CHART_CONFIG } from './config';
import { FAVORITE_INTERVALS } from './intervals';
import { loadChartState, saveChartState } from './chartstate';

import {
  ChartingLibraryWidgetConstructor,
  ChartingLibraryWidgetOptions,
  IChartingLibraryWidget,
  IChartWidgetApi,
  ResolutionString,
} from '../AdvancedTradingView/charting_library';
import { useMobile } from '@/hooks/useMobile';
import Spinner from '../Spinner/Spinner';
import { cn } from '@/lib/utils';
import { RefreshMarks } from './RefreshMarks';
import { useTokenChart } from '@/contexts/TokenChartProvider';
import { useTokenInfo } from '@/hooks/queries';

type TradingView = {
  widget: ChartingLibraryWidgetConstructor;
};

declare global {
  interface Window {
    TradingView: TradingView;
  }
}

export interface TVOptions {
  enableVolumeStudy?: boolean;
  useUserBrowserTime?: boolean;
  showSeriesOHLC?: boolean;
  showVolume?: boolean;
  showPriceSource?: boolean;
  showBarChange?: boolean;
  isMobile?: boolean;
}

export const DEFAULT_OPTIONS: Required<TVOptions> = {
  enableVolumeStudy: true,
  useUserBrowserTime: true,
  showSeriesOHLC: true,
  showVolume: true,
  showPriceSource: true,
  showBarChange: true,
  isMobile: false,
};

type ChartProps = {
  renderingId?: string;
  style?: CSSProperties;
  positions?: [];
  opt?: TVOptions;
};

const TRADING_VIEW_DOMAIN = 'https://static.jup.ag';
const TV_SCRIPT_ID = 'tradingview-widget-loading-script';

function loadTvLibrary(): Promise<TradingView> {
  return new Promise((resolve) => {
    if (window.TradingView) {
      return resolve(window.TradingView);
    }

    // Check if the script already exists
    const existingScript = document.getElementById(TV_SCRIPT_ID);

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(window.TradingView));
    } else {
      // Script doesn't exist, create and append it
      const script = document.createElement('script');
      script.id = TV_SCRIPT_ID;
      script.src = `${TRADING_VIEW_DOMAIN}/tv/charting_library/charting_library.js`;
      script.type = 'text/javascript';
      script.onload = () => resolve(window.TradingView);

      document.head.appendChild(script);
    }
  });
}

const ENABLED_FEATURES: ChartingLibraryWidgetOptions['enabled_features'] = [
  'header_in_fullscreen_mode', // Enable tools in fullscreen mode
  'side_toolbar_in_fullscreen_mode', // Enable tools in fullscreen mode
  'seconds_resolution', // Enable seconds resolution
  'two_character_bar_marks_labels', // Enable marks to be displayed with two characters.
  'hide_left_toolbar_by_default',
  'save_shortcut',
  'create_volume_indicator_by_default', // create by default, if opt.enableVolumeStudy = false, will remove at onChartReady()
  'axis_pressed_mouse_move_scale',
];

const DISABLED_FEATURES: ChartingLibraryWidgetOptions['disabled_features'] = [
  'header_symbol_search',
  'header_compare',
  'countdown',
  'popup_hints',
  'vert_touch_drag_scroll', // allow vertical scrolling of webpage on touch screen
  'header_saveload', // remove "save" header button
  'symbol_search_hot_key',
  'timeframes_toolbar', // hide bottom timeframe, timezone bar
  'header_undo_redo',
  'display_market_status',
];

export const TokenChart: React.FC<ChartProps> = memo(({ renderingId, style, opt }) => {
  const isMobile = useMobile();
  const { resolvedTheme } = useTheme();
  const chartTheme = resolvedTheme === 'light' ? 'light' : 'dark';
  const chartColors = CHART_THEME_COLORS[chartTheme];
  const [chartConfig, setChartConfig] = useLocalStorage<ChartConfig>(
    'chart_config',
    DEFAULT_CHART_CONFIG
  );

  const {
    resolutionRef,
    chartTypeRef,
    showDevTradesRef,
    showUserTradesRef,
    baseAssetRef,
    resolutionToMostRecentBarRef,
    onNewMarksRef,
    onNewSwapTxsRef,
    userAddressRef,
  } = useTokenChart();

  useLayoutEffect(() => {
    if (!chartConfig) {
      return;
    }
    resolutionRef.current = chartConfig.lastInterval;
    chartTypeRef.current = chartConfig.chartType;
    showDevTradesRef.current = chartConfig.showDevTrades;
    showUserTradesRef.current = chartConfig.showUserTrades;
  }, [chartConfig, resolutionRef, chartTypeRef, showDevTradesRef, showUserTradesRef]);

  const options: Required<TVOptions> = useMemo(
    () => ({
      ...DEFAULT_OPTIONS,
      ...opt,
      isMobile,
    }),
    [opt, isMobile]
  );

  const widgetRef = useRef<IChartingLibraryWidget | null>(null);
  const htmlId = useMemo(() => `${renderingId}-tradingview-chart`, [renderingId]);
  const priceMcapTogglerRef = useRef<HTMLElement | null>(null);
  const devTradesTogglerRef = useRef<HTMLElement | null>(null);
  const userTradesTogglerRef = useRef<HTMLElement | null>(null);
  const resetCacheFnRef = useRef<Record<string, () => void>>({});
  const isMarksLoadingRef = useRef<boolean>(false);

  const [isLoaded, setIsLoaded] = useState(false);
  const [isDataReady, setIsDataReady] = useState(false);

  const { data: tokenInfo } = useTokenInfo((data) => data?.baseAsset);
  const symbol = useMemo(() => {
    return tokenInfo ? `${tokenInfo.symbol.toUpperCase()}/USD` : undefined;
  }, [tokenInfo]);

  // Set up widget on first mount and rebuild it when the theme changes
  useEffect(() => {
    if (!symbol) {
      console.error('createWidget: missing symbol, breaking: ', { symbol });
      return;
    }

    let disposed = false;
    setIsLoaded(false);
    setIsDataReady(false);

    const initializeWidget = async () => {
      try {
        // First, ensure TradingView script is loaded
        const tv = await loadTvLibrary();
        if (disposed) {
          return;
        }

        const disabledFeatures = [...DISABLED_FEATURES];
        // Prevent TV from preventing to scroll the page on mobile
        if (isMobile) {
          disabledFeatures.push('axis_pressed_mouse_move_scale');
        }

        const chartData = loadChartState();

        // Now that the script is loaded, we can safely create the widget
        const widget = new tv.widget({
          symbol,
          interval: (chartConfig?.lastInterval ?? '15') as ResolutionString, // 15 minutes
          locale: 'en',
          container: htmlId,
          theme: chartTheme,
          autosize: true,
          auto_save_delay: 1,
          custom_css_url: `${TRADING_VIEW_DOMAIN}/tv/css/tokenchart.css`,
          // Don't do override anymore, edit from template
          settings_overrides: {
            'chartEventsSourceProperties.breaks.visible': false,
            'paneProperties.legendProperties.showSeriesTitle': true,
            'paneProperties.backgroundType': 'solid',
            'paneProperties.background': chartColors.bg,
            'scalesProperties.fontSize': isMobile ? 7 : 12,
          },
          overrides: {
            'mainSeriesProperties.highLowAvgPrice.highLowPriceLabelsVisible': true,
            'mainSeriesProperties.highLowAvgPrice.highLowPriceLinesVisible': true,
            'paneProperties.vertGridProperties.style': 2, // dashed
            'paneProperties.vertGridProperties.color': chartColors.grid, // neutral-850
            'paneProperties.horzGridProperties.style': 2, // dashed
            'paneProperties.horzGridProperties.color': chartColors.grid, // neutral-850
          },
          width: '100%' as any, // Ignore this typing, this fills to container
          height: '100%' as any, // Ignore this typing, this fills to container
          datafeed: createDataFeed(
            baseAssetRef,
            resolutionToMostRecentBarRef,
            onNewSwapTxsRef,
            chartTypeRef,
            userAddressRef,
            onNewMarksRef,
            showDevTradesRef,
            showUserTradesRef,
            isMarksLoadingRef,
            resetCacheFnRef
          ),
          library_path: `${TRADING_VIEW_DOMAIN}/tv/charting_library/bundles`,
          disabled_features: disabledFeatures,
          enabled_features: ENABLED_FEATURES,
          custom_formatters: {
            priceFormatterFactory: () => {
              return {
                format: (price: number) => {
                  const value = getPrecisionTickSizeText({
                    value: price,
                    maxSuffix: 6,
                  });
                  // formatnumber here to show the comma in the price, eg BTC: 95,000
                  return price > 1_000 ? formatChartPrice(price, 2) : value;
                },
              };
            },
          } as any,
          // Intentionally set as any to prevent overriding dateFormatter and timeFormatter
          favorites: {
            intervals: FAVORITE_INTERVALS,
          },
          saved_data: chartData,
        });
        widgetRef.current = widget;

        widget.headerReady().then(() => {
          // Delete toggle button if previously created
          priceMcapTogglerRef.current?.remove();
          priceMcapTogglerRef.current = widget.createButton();
          priceMcapTogglerRef.current?.addEventListener('click', () => {
            if (!resolutionRef.current) {
              return;
            }
            setChartConfig({
              lastInterval: resolutionRef.current ?? DEFAULT_CHART_CONFIG.lastInterval,
              chartType: chartTypeRef.current === 'mcap' ? 'price' : 'mcap',
              showDevTrades: showDevTradesRef.current,
              showUserTrades: showUserTradesRef.current,
            });
          });

          devTradesTogglerRef.current?.remove();
          devTradesTogglerRef.current = widget.createButton();
          devTradesTogglerRef.current?.addEventListener('click', () => {
            const activeChart = widget.activeChart();
            if (isMarksLoadingRef.current || !activeChart) {
              return;
            }
            const showDevTrades = !showDevTradesRef.current;
            setChartConfig({
              lastInterval: resolutionRef.current ?? DEFAULT_CHART_CONFIG.lastInterval,
              chartType: chartTypeRef.current,
              showUserTrades: showUserTradesRef.current,
              showDevTrades,
            });
            if (showDevTrades) {
              activeChart.refreshMarks();
              return;
            }
            activeChart.clearMarks();
            activeChart.refreshMarks();
          });

          userTradesTogglerRef.current = widget.createButton();
          userTradesTogglerRef.current?.addEventListener('click', () => {
            const activeChart = widget.activeChart();
            if (isMarksLoadingRef.current || !activeChart) {
              return;
            }
            const showUserTrades = !showUserTradesRef.current;
            setChartConfig({
              lastInterval: resolutionRef.current ?? DEFAULT_CHART_CONFIG.lastInterval,
              chartType: chartTypeRef.current,
              showDevTrades: showDevTradesRef.current,
              showUserTrades,
            });
            if (showUserTrades) {
              activeChart.refreshMarks();
              return;
            }
            activeChart.clearMarks();
            activeChart.refreshMarks();
          });

          if (chartConfig) {
            updateButtonTitles(chartConfig);
          }
        });

        widget.onChartReady(() => {
          const activeChart = widget.activeChart();
          if (!activeChart) {
            console.error('window.onChartReady: missing activechart, breaking!');
            return;
          }

          const studies = activeChart.getAllStudies();
          const foundVolumeStudy = studies.find((item) => item.name === 'Volume');

          // This is to patch everyone settings to this, else it will be inconsistent
          widget.applyOverrides({
            'mainSeriesProperties.highLowAvgPrice.highLowPriceLabelsVisible': true,
            'mainSeriesProperties.highLowAvgPrice.highLowPriceLinesVisible': true,
            'paneProperties.vertGridProperties.style': 2, // dashed
            'paneProperties.vertGridProperties.color': chartColors.grid, // neutral-850
            'paneProperties.horzGridProperties.style': 2, // dashed
            'paneProperties.horzGridProperties.color': chartColors.grid, // neutral-850
            'paneProperties.backgroundType': 'solid',
            'paneProperties.background': chartColors.bg,
            'mainSeriesProperties.statusViewStyle.symbolTextSource': 'description', // display token symbol, jup.ag in chart
          });

          // Force price chart auto scaling
          const panes = activeChart.getPanes();
          const priceScale = panes[0]?.getMainSourcePriceScale();
          if (priceScale) {
            priceScale.setAutoScale(true);
          }

          // Remove volume on mobile OR ensure volume is created if enabled AND on desktop
          if (opt?.enableVolumeStudy && !isMobile) {
            if (!foundVolumeStudy) {
              activeChart.createStudy('Volume');
            }
          } else if (foundVolumeStudy) {
            activeChart.removeEntity(foundVolumeStudy.id);
          }

          // Save the chart state to local storage
          widget.subscribe('onAutoSaveNeeded', () => {
            widget.save(saveChartState);
          });

          // Handle chart loading sequence
          activeChart.dataReady(() => {
            setIsDataReady(true);
          });

          // Save the last interval user chose
          activeChart.onIntervalChanged().subscribe(null, (interval) => {
            setChartConfig({
              chartType: chartTypeRef.current,
              showDevTrades: showDevTradesRef.current,
              showUserTrades: showUserTradesRef.current,
              lastInterval: interval,
            });
          });

          if (options.useUserBrowserTime) {
            const timezoneApi = activeChart.getTimezoneApi();
            const userTz = new Date().getTimezoneOffset() * 60 * 1000 * -1; // This is how TV handles timezone offset, don't ask why, don't know why
            const detectedTimezone = timezoneApi
              .availableTimezones()
              .find((item) => item.offset === userTz);
            timezoneApi.setTimezone(detectedTimezone?.id || 'Etc/UTC');
          }

          setIsLoaded(true);
        });
      } catch (error) {
        console.error('Failed to initialize TradingView widget:', error);
        return;
      }
    };
    initializeWidget();

    return () => {
      disposed = true;
      try {
        widgetRef.current?.remove();
      } catch {
        // widget may already be disposed
      }
      widgetRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, chartTheme]);

  function updateButtonTitles(config: ChartConfig) {
    if (!priceMcapTogglerRef.current) {
      return;
    }

    // Price/mcap toggle
    if (config.chartType === 'mcap') {
      priceMcapTogglerRef.current.innerHTML = `Price / <span style="color:${chartColors.accent}">Mcap</span>`;
    } else {
      priceMcapTogglerRef.current.innerHTML = `<span style="color:${chartColors.accent}">Price</span> / Mcap`;
    }

    // Show dev trades toggle
    if (devTradesTogglerRef.current) {
      if (config.showDevTrades) {
        devTradesTogglerRef.current.textContent = 'Hide Dev Trades';
      } else {
        devTradesTogglerRef.current.textContent = 'Show Dev Trades';
      }
    }

    // Show user trades toggle
    if (userTradesTogglerRef.current) {
      if (config.showUserTrades) {
        userTradesTogglerRef.current.textContent = 'Hide My Trades';
      } else {
        userTradesTogglerRef.current.textContent = 'Show My Trades';
      }
    }
  }

  // Reset chart data when config changes
  useEffect(() => {
    const widget = widgetRef.current;
    if (!widget) {
      return;
    }

    let activeChart: IChartWidgetApi | undefined;
    try {
      activeChart = widget.activeChart();
    } catch (err) {
      console.error('failed to get active chart, breaking');
      return;
    }

    const ready = isLoaded && isDataReady;
    if (!activeChart || !ready || !symbol || !chartConfig) {
      return;
    }

    const baseAssetId = baseAssetRef.current?.id;
    if (!baseAssetId) {
      console.error('failed to reset data, missing asset id');
      return;
    }

    updateButtonTitles(chartConfig);
    const key = baseAssetRef.current?.id;
    if (!key) {
      console.error('failed to get token id, breaking');
      return;
    }
    // invalidate cache if it exists to request for new data
    // see https://www.tradingview.com/charting-library-docs/latest/connecting_data/datafeed-api/required-methods/#subscribebars
    const onResetCacheNeededCallback = resetCacheFnRef.current[key];
    if (!onResetCacheNeededCallback) {
      return;
    }

    onResetCacheNeededCallback();
    activeChart.resetData();
  }, [chartConfig, isLoaded, isDataReady, symbol, baseAssetRef]);

  return (
    <>
      <RefreshMarks isLoaded={isLoaded} widgetRef={widgetRef} />

      <div
        className={cn('relative h-full w-full flex-1 overflow-hidden transition-all')}
        style={{ minHeight: 200, ...style }}
      >
        {/* Shades to prevent flickering */}
        <div
          className={cn(
            `pointer-events-none absolute left-0 top-0 h-full w-full transition-all`,
            isLoaded && isDataReady ? 'bg-transparent' : `bg-neutral-950`,
            `flex items-center justify-center`
          )}
        >
          {!isLoaded || !isDataReady ? <Spinner /> : null}
        </div>

        <div
          id={htmlId}
          className={cn('h-full w-full', isDataReady ? `opacity-100` : `opacity-0`)}
          style={{ minHeight: 200, ...style }}
        />
      </div>
    </>
  );
});

TokenChart.displayName = 'TokenChart';
