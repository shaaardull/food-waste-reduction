interface UserLike {
  display_name?: string | null;
  email?: string | null;
}

/**
 * Two-character avatar-chip initials.
 *
 * Rules:
 *   - display_name with 2+ words → first letter of first two words
 *     ("Demo Admin" → "DA").
 *   - display_name with 1 word → first two chars of that word
 *     ("Anaya" → "AN").
 *   - email fallback → first letter of local-part + first letter of
 *     domain ("admin@example.com" → "AE").
 *   - Nothing usable → "?".
 */
export function initialsFor(user: UserLike | null | undefined): string {
  const name = user?.display_name?.trim();
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
    }
    return words[0]!.slice(0, 2).toUpperCase();
  }
  const email = user?.email?.trim();
  if (email) {
    const at = email.indexOf('@');
    if (at > 0 && at < email.length - 1) {
      return (email.charAt(0) + email.charAt(at + 1)).toUpperCase();
    }
    return email.slice(0, 2).toUpperCase();
  }
  return '?';
}
