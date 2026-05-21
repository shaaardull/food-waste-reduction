/**
 * Body-image-safe deny list applied to staff-facing copy.
 *
 * Mirrors apps/web/src/lib/copy-lint.ts. Staff copy is internal-facing
 * but the same dignity guardrails apply — we don't want managers
 * accidentally seeing weight / calorie / shame language in the queue
 * either, and the same list catches obvious bad copy from translators.
 */
export const COPY_DENY_LIST: readonly string[] = [
  'calorie',
  'calories',
  'guilt',
  'guilty',
  'shame',
  'fat',
  'skinny',
  'overweight',
  'weight loss',
  'body',
  'you should have finished',
  'fatty',
  'diet',
  'lose weight',
];
