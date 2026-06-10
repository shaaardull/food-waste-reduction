/**
 * Restaurant theming applied to the single PWA (§12 multi-tenancy decision).
 *
 * Restaurants choose a primary color in their onboarding wizard. We project
 * that color onto the design system's --brand HSL contract so every utility
 * (`bg-brand`, `text-brand`, `border-brand-line` etc.) re-skins at runtime.
 *
 * The brand contract — see apps/web/src/index.css and tailwind.config.js —
 * derives press / tint / wash / line shades from one HSL family. We keep
 * the legacy --brand-{50,500,600,700,900} CSS variables alive too so any
 * screen still using `bg-brand-600` keeps rendering during the migration.
 */
import { useEffect } from 'react';
import type { Restaurant } from '@plate-clean/shared-types';

const DEFAULT_PRIMARY = '#21695f'; // refined coastal teal — design-handoff default

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

/** Convert a #rrggbb hex to HSL channels (h ∈ 0..360, s ∈ 0..100, l ∈ 0..100). */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      case bn:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Mix the primary color with white by `pct` (0–1). Used for legacy shades. */
function lighten(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  const lr = Math.round(r + (255 - r) * pct);
  const lg = Math.round(g + (255 - g) * pct);
  const lb = Math.round(b + (255 - b) * pct);
  return `rgb(${lr} ${lg} ${lb})`;
}

function darken(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r * (1 - pct))} ${Math.round(g * (1 - pct))} ${Math.round(b * (1 - pct))})`;
}

export function applyTheme(restaurant: Restaurant | null | undefined): void {
  const root = document.documentElement;
  const primary = restaurant?.theme_primary_color ?? DEFAULT_PRIMARY;

  // ── New system: write the HSL contract. press = slightly darker, tint =
  // mid lightness for secondary text, wash = near-white fill, line = warm
  // mid-light for hairlines.
  const { h, s, l } = hexToHsl(primary);
  root.style.setProperty('--brand-h', String(h));
  root.style.setProperty('--brand-s', `${s}%`);
  root.style.setProperty('--brand-l', `${l}%`);
  root.style.setProperty('--brand-press-h', String(h));
  root.style.setProperty('--brand-press-s', `${Math.min(100, s + 2)}%`);
  root.style.setProperty('--brand-press-l', `${Math.max(0, l - 7)}%`);
  root.style.setProperty('--brand-tint-h', String(h));
  root.style.setProperty('--brand-tint-s', `${Math.max(0, s - 12)}%`);
  root.style.setProperty('--brand-tint-l', `${Math.min(100, l + 11)}%`);
  root.style.setProperty('--brand-wash-h', String(h));
  root.style.setProperty('--brand-wash-s', `${Math.max(0, s - 18)}%`);
  root.style.setProperty('--brand-wash-l', '95%');
  root.style.setProperty('--brand-line-h', String(h));
  root.style.setProperty('--brand-line-s', `${Math.max(0, s - 28)}%`);
  root.style.setProperty('--brand-line-l', '86%');

  // ── Legacy palette — kept alive during migration.
  root.style.setProperty('--brand-700', primary);
  root.style.setProperty('--brand-600', lighten(primary, 0.1));
  root.style.setProperty('--brand-500', lighten(primary, 0.2));
  root.style.setProperty('--brand-50', lighten(primary, 0.9));
  root.style.setProperty('--brand-900', darken(primary, 0.2));
}

export function useApplyTheme(restaurant: Restaurant | null | undefined): void {
  useEffect(() => {
    applyTheme(restaurant);
  }, [restaurant?.theme_primary_color]);
}
