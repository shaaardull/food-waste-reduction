/** @type {import('tailwindcss').Config} */
//
// Plate-Clean Rewards — Tailwind theme.
//
// Two systems share one --brand contract: the diner PWA ("Konkan Coast", warm
// cream surfaces) and the staff dashboard ("Counter", cool slate surfaces).
// Every colour reads from a CSS custom property declared in src/index.css so
// each restaurant can re-skin at runtime via theme.ts.
//
// Legacy brand-{50,500,600,700,900} keys stay in place during the migration
// so existing screens keep rendering — once every screen is moved over to
// `bg-brand` / `text-brand` / etc., the numeric keys can be deleted.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── New design-system tokens ────────────────────────────────
        brand: {
          // Modern HSL contract — `bg-brand`, `text-brand`, `bg-brand/20` etc.
          DEFAULT: 'hsl(var(--brand-h) var(--brand-s) var(--brand-l) / <alpha-value>)',
          press: 'hsl(var(--brand-press-h) var(--brand-press-s) var(--brand-press-l))',
          tint: 'hsl(var(--brand-tint-h) var(--brand-tint-s) var(--brand-tint-l))',
          wash: 'hsl(var(--brand-wash-h) var(--brand-wash-s) var(--brand-wash-l))',
          line: 'hsl(var(--brand-line-h) var(--brand-line-s) var(--brand-line-l))',
          // ── Legacy numeric palette — kept alive during migration.
          // Once every component reads from `brand` directly, drop these.
          50: 'var(--brand-50, #f0fdfa)',
          500: 'var(--brand-500, #14b8a6)',
          600: 'var(--brand-600, #0d9488)',
          700: 'var(--brand-700, #0f766e)',
          900: 'var(--brand-900, #042f2e)',
        },
        // v2 Sprout accents — sage brighter (sustainability scoreboard),
        // saffron warmer (rewards only), plus two new accents that
        // ship with v2: lime (playful pop / sprout highlight) and
        // berry (a friendly secondary accent, used sparingly).
        saffron: {
          DEFAULT: 'hsl(33 88% 56%)',
          deep: 'hsl(28 78% 44%)',
          wash: 'hsl(36 90% 93%)',
        },
        sage: {
          DEFAULT: 'hsl(145 54% 40%)',
          tint: 'hsl(145 50% 48%)',
          wash: 'hsl(145 50% 94%)',
        },
        lime: {
          DEFAULT: 'hsl(78 64% 50%)',
          deep: 'hsl(84 50% 36%)',
          wash: 'hsl(74 62% 92%)',
        },
        berry: {
          DEFAULT: 'hsl(340 62% 58%)',
          wash: 'hsl(342 70% 95%)',
        },
        // Diner neutrals — v2 shifts hue from warm cream to cool mint-cream.
        cream: 'hsl(140 24% 97%)',
        paper: 'hsl(150 30% 99.3%)',
        ink: 'hsl(160 18% 14%)',
        muted: 'hsl(160 8% 40%)',
        faint: 'hsl(155 12% 56%)',
        line: 'hsl(145 18% 89%)',
        's-bg': 'hsl(210 28% 98%)',
        's-paper': '#ffffff',
        's-ink': 'hsl(215 30% 16%)',
        's-muted': 'hsl(215 14% 44%)',
        's-faint': 'hsl(215 16% 62%)',
        's-line': 'hsl(214 22% 91%)',
        's-rail': 'hsl(213 30% 13%)',
        amber: {
          DEFAULT: 'hsl(38 92% 47%)',
          deep: 'hsl(28 80% 36%)',
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
      // v2 radii — rounder across the board.
      borderRadius: {
        sm: '10px',
        md: '14px',
        lg: '20px',
        xl: '26px',
        '2xl': '34px',
      },
      // v2 shadows — green-tinted card + pop, and a new "lift" that
      // stacks a coloured tab on top of a soft drop (used on primary
      // buttons and the reward-celebration ticket).
      boxShadow: {
        'sh-sm': '0 1px 2px rgba(20,60,42,.07)',
        card: '0 2px 4px rgba(20,60,42,.05), 0 14px 30px -14px rgba(20,60,42,.18)',
        pop: '0 20px 58px -18px rgba(20,60,42,.34)',
        lift: '0 10px 0 -4px hsl(var(--brand-wash-h) var(--brand-wash-s) var(--brand-wash-l)), 0 16px 34px -16px rgba(20,60,42,.30)',
      },
      fontFamily: {
        sans: ['Hanken Grotesk', 'system-ui', 'sans-serif'],
        serif: ['Fraunces', 'Georgia', 'serif'],
        dev: ['Mukta', 'Hanken Grotesk', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
