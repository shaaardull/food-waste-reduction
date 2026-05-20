/**
 * Restaurant theming applied to the single PWA (§12 multi-tenancy decision).
 *
 * Restaurants get a slug-scoped primary color and optional logo + tagline.
 * We set them as CSS variables on the document root so any Tailwind utility
 * that consumes `--brand` (in tailwind.config.js) updates automatically.
 */
import { useEffect } from 'react';
import type { Restaurant } from '@plate-clean/shared-types';

const DEFAULT_PRIMARY = '#0f766e'; // brand.700

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

/** Mix the primary color with white by `pct` (0–1). Used for hover / 50/600 shades. */
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
