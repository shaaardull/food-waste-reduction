/**
 * Ethics rule 7: deny-list for user-facing copy.
 * Body-image-safe, no guilt/shame framing.
 *
 * `scripts/lint-copy.ts` greps all .tsx files under src/ and fails if any of these
 * appears in JSX text or string literals. Keep this list in sync with the spec.
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
