/**
 * Restaurant theming for the staff dashboard. Same logic as apps/web —
 * sets CSS variables consumed by tailwind.config.js's brand palette.
 */
import { useEffect } from 'react';

interface ThemeSource {
  theme_primary_color: string;
  theme_logo_url?: string | null;
  tagline?: string | null;
}

const DEFAULT_PRIMARY = '#0f766e';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace('#', '');
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  };
}

function lighten(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r + (255 - r) * pct)} ${Math.round(g + (255 - g) * pct)} ${Math.round(
    b + (255 - b) * pct,
  )})`;
}

function darken(hex: string, pct: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r * (1 - pct))} ${Math.round(g * (1 - pct))} ${Math.round(b * (1 - pct))})`;
}

export function applyTheme(restaurant: ThemeSource | null | undefined): void {
  const root = document.documentElement;
  const primary = restaurant?.theme_primary_color ?? DEFAULT_PRIMARY;
  root.style.setProperty('--brand-700', primary);
  root.style.setProperty('--brand-600', lighten(primary, 0.1));
  root.style.setProperty('--brand-500', lighten(primary, 0.2));
  root.style.setProperty('--brand-50', lighten(primary, 0.9));
  root.style.setProperty('--brand-900', darken(primary, 0.2));
}

export function useApplyTheme(restaurant: ThemeSource | null | undefined): void {
  useEffect(() => {
    applyTheme(restaurant);
  }, [restaurant?.theme_primary_color]);
}
