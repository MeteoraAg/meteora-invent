import plugin from 'tailwindcss/plugin';
import tailwindcssAnimate from 'tailwindcss-animate';
import { addIconSelectors } from '@iconify/tailwind';

/**
 * Resolve a color from a CSS variable (RGB triplet) with alpha support.
 * The variables are defined per-theme in `src/styles/globals.css`.
 */
const themeVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      screens: {
        xs: '390px',
      },

      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.75rem' }],
        xxs: ['0.5rem', { lineHeight: '0.625rem' }],
      },

      backgroundSize: {
        '200-auto': '200% auto',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        shine: {
          from: { backgroundPosition: '200% center' },
          to: { backgroundPosition: '-200% center' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out forwards',
        'fade-out': 'fade-out 0.15s ease-in forwards',
        'shine-reverse': 'shine 3s linear infinite reverse',
      },

      colors: {
        background: themeVar('background'),
        foreground: themeVar('foreground'),

        // Theme-aware scales (inverted between light and dark mode)
        neutral: {
          50: themeVar('neutral-50'),
          100: themeVar('neutral-100'),
          200: themeVar('neutral-200'),
          300: themeVar('neutral-300'),
          400: themeVar('neutral-400'),
          500: themeVar('neutral-500'),
          600: themeVar('neutral-600'),
          700: themeVar('neutral-700'),
          750: themeVar('neutral-750'),
          800: themeVar('neutral-800'),
          850: themeVar('neutral-850'),
          900: themeVar('neutral-900'),
          925: themeVar('neutral-925'),
          950: themeVar('neutral-950'),
        },
        primary: {
          DEFAULT: themeVar('primary'),
          200: themeVar('primary-200'),
          300: themeVar('primary-300'),
          400: themeVar('primary-400'),
          500: themeVar('primary-500'),
          600: themeVar('primary-600'),
          700: themeVar('primary-700'),
          800: themeVar('primary-800'),
          900: themeVar('primary-900'),
          950: themeVar('primary-950'),
        },

        // Status colors: theme-aware DEFAULT, static shades
        amber: {
          50: '#fffbeb',
          100: '#fef3c6',
          200: '#fee685',
          300: '#ffd230',
          400: '#ffb900',
          DEFAULT: themeVar('amber'),
          500: '#fe9a00',
          600: '#e17100',
          700: '#bb4d00',
          800: '#973c00',
          900: '#7b3306',
          950: '#461901',
        },
        emerald: {
          50: '#ecfdf5',
          100: '#d0fae5',
          200: '#a4f4cf',
          300: '#5ee9b5',
          400: '#3ce3ab',
          DEFAULT: themeVar('emerald'),
          500: '#02c78c',
          600: '#00a272',
          700: '#00815f',
          800: '#00664c',
          900: '#005440',
          950: '#002f25',
        },
        rose: {
          50: '#fff1f4',
          100: '#ffe4ea',
          200: '#fecddb',
          300: '#fca5bd',
          400: '#f23674',
          DEFAULT: themeVar('rose'),
          500: '#eb2d6f',
          600: '#e01e68',
          700: '#bd1358',
          800: '#9e134f',
          900: '#871449',
          950: '#4b0624',
        },
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    // Iconify plugin for clean selectors, requires writing a list of icon sets to load
    // Icons usage in HTML:
    //  <span class="iconify [icon-set]--[icon]"></span>
    //  <span class="iconify ph--airplane-tilt-fill"></span>
    addIconSelectors({
      // List of icon sets
      prefixes: ['ph'],
    }),
    plugin(({ addUtilities, addVariant }) => {
      // Only apply hover styles on devices that actually support hover
      addVariant('has-hover', '@media (hover: hover) and (pointer: fine)');

      addUtilities({
        '.scrollbar-none': {
          'scrollbar-width': 'none',
          '-ms-overflow-style': 'none',
          '&::-webkit-scrollbar': {
            display: 'none',
          },
        },
      });
    }),
  ],
};
