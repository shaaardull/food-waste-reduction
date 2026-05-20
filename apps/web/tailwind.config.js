/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CSS variables let `applyTheme` (apps/web/src/lib/theme.ts) re-skin
        // the app at runtime per restaurant. Fallbacks keep the default
        // brand colors when no restaurant has been picked yet.
        brand: {
          50: 'var(--brand-50, #f0fdfa)',
          500: 'var(--brand-500, #14b8a6)',
          600: 'var(--brand-600, #0d9488)',
          700: 'var(--brand-700, #0f766e)',
          900: 'var(--brand-900, #042f2e)',
        },
      },
    },
  },
  plugins: [],
};
