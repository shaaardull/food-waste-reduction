import { expect, test } from '@playwright/test';

/**
 * Diner PWA smoke. Deliberately offline-friendly — no API calls. Just
 * verifies the build renders, the i18n strings reach the DOM, and the
 * language switcher in /profile actually swaps the locale.
 *
 * Heavier flows (auth, capture, validation) are covered by the API
 * integration tests against the running stack. This file is the
 * "did the bundle even load" guardrail Playwright in §11 calls for.
 */

test.describe('diner PWA smoke', () => {
  test('landing page renders English copy', async ({ page }) => {
    // Force a fresh language pick so prior runs don't poison the test.
    await page.addInitScript(() => {
      localStorage.removeItem('plate_clean_locale');
      localStorage.setItem('plate_clean_locale', 'en');
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Finish your plate, unlock a reward.',
    );
    // Header brand name when no restaurant is active.
    await expect(page.getByRole('link', { name: 'Plate-Clean' })).toBeVisible();
  });

  test('language switcher swaps to Hindi stub', async ({ page }) => {
    // Walk through to /profile after a faked sign-in. Easier: drop a
    // synthetic auth into localStorage so Profile renders.
    await page.addInitScript(() => {
      localStorage.setItem('plate_clean_locale', 'en');
      localStorage.setItem(
        'plate_clean_user',
        JSON.stringify({
          id: '00000000-0000-0000-0000-000000000000',
          email: 'demo@example.com',
          role: 'diner',
          created_at: '2026-01-01T00:00:00Z',
        }),
      );
      localStorage.setItem('plate_clean_token', 'fake-token');
    });

    await page.goto('/profile');
    // Confirm English first.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Profile');

    // Click the Hindi switcher.
    await page.getByRole('button', { name: 'हिन्दी' }).click();

    // The auto-generated stub prefixes each value with `[hi] `.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('[hi] Profile');
  });

  test('footer carries the sustainability tagline', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('plate_clean_locale', 'en');
    });
    await page.goto('/');
    await expect(page.getByText(/small win for the planet/)).toBeVisible();
  });
});
