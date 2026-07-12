/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Mirror the v2 "Sprout" tokens from the diner PWA so the
      // marketing site feels continuous when someone jumps into
      // the product.
      colors: {
        brand: 'hsl(153 46% 33%)',
        'brand-wash': 'hsl(153 40% 95%)',
        sage: 'hsl(140 30% 40%)',
        'sage-wash': 'hsl(140 30% 94%)',
        saffron: 'hsl(31 80% 56%)',
        'saffron-wash': 'hsl(31 80% 95%)',
        ink: 'hsl(186 14% 13%)',
        muted: 'hsl(190 7% 42%)',
        line: 'hsl(40 17% 88%)',
        paper: '#ffffff',
        cream: 'hsl(40 36% 97%)',
      },
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        sans: ['Hanken Grotesk', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
