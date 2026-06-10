/** @type {import('tailwindcss').Config} */
//
// Plate-Clean Dashboard ("Counter") — Tailwind theme.
//
// Same tokens as the diner PWA so a single design system spans both. The
// dashboard emphasises the staff (`s-*`) neutral set but keeps the diner
// warm tokens available for the OnboardWizard preview + restaurant theming.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'hsl(var(--brand-h) var(--brand-s) var(--brand-l) / <alpha-value>)',
          press: 'hsl(var(--brand-press-h) var(--brand-press-s) var(--brand-press-l))',
          tint: 'hsl(var(--brand-tint-h) var(--brand-tint-s) var(--brand-tint-l))',
          wash: 'hsl(var(--brand-wash-h) var(--brand-wash-s) var(--brand-wash-l))',
          line: 'hsl(var(--brand-line-h) var(--brand-line-s) var(--brand-line-l))',
          50: 'var(--brand-50, #f0fdfa)',
          500: 'var(--brand-500, #14b8a6)',
          600: 'var(--brand-600, #0d9488)',
          700: 'var(--brand-700, #0f766e)',
          900: 'var(--brand-900, #042f2e)',
        },
        saffron: {
          DEFAULT: 'hsl(31 80% 56%)',
          deep: 'hsl(28 72% 44%)',
          wash: 'hsl(34 82% 94%)',
        },
        sage: {
          DEFAULT: 'hsl(150 32% 38%)',
          tint: 'hsl(150 30% 46%)',
          wash: 'hsl(148 34% 95%)',
        },
        cream: 'hsl(40 36% 97%)',
        paper: 'hsl(42 42% 99.3%)',
        ink: 'hsl(186 14% 13%)',
        muted: 'hsl(190 7% 42%)',
        faint: 'hsl(190 9% 58%)',
        line: 'hsl(40 17% 88%)',
        's-bg': 'hsl(210 28% 98%)',
        's-paper': '#ffffff',
        's-ink': 'hsl(215 30% 16%)',
        's-muted': 'hsl(215 14% 44%)',
        's-faint': 'hsl(215 16% 62%)',
        's-line': 'hsl(214 22% 91%)',
        's-rail': 'hsl(213 30% 13%)',
        amber: {
          DEFAULT: 'hsl(38 92% 47%)',
          wash: 'hsl(40 92% 94%)',
        },
        danger: {
          DEFAULT: 'hsl(8 70% 50%)',
          wash: 'hsl(8 78% 96%)',
        },
        info: {
          DEFAULT: 'hsl(208 72% 47%)',
          wash: 'hsl(208 70% 95%)',
        },
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '22px',
        '2xl': '28px',
      },
      boxShadow: {
        'sh-sm': '0 1px 2px rgba(18,38,36,.06)',
        card: '0 1px 2px rgba(18,38,36,.05), 0 10px 26px -12px rgba(18,38,36,.16)',
        pop: '0 18px 54px -18px rgba(18,38,36,.34)',
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', 'sans-serif'],
        serif: ['Instrument Serif', 'Georgia', 'serif'],
        dev: ['Mukta', 'Hanken Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
