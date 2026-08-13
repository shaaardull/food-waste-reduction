import { useEffect, useState } from 'react';
import { api } from '../lib/api';

/**
 * Fetches the currently effective versions of the two documents the
 * diner signup path cares about: the mandatory Diner Terms of Service
 * (Part A) and the optional Research & AI Improvement Consent (Part B).
 *
 * Kept as a hook rather than a one-off fetch so both Login (email
 * signup) and QuickStart (phone-OTP signup) share the same fetch +
 * loading state without duplicating the shape.
 *
 * Failure mode: if the backend has no published versions (fresh install
 * where the seed script hasn't run), the hook exposes `error` and the
 * caller must block signup rather than sending a bogus version — the
 * signup middleware would reject anything but the current version
 * anyway, so failing loudly here is the right behaviour.
 */
export interface CurrentDocument {
  document_type: 'diner_tos' | 'research_consent';
  version: string;
  effective_from: string;
  content_markdown: string;
  content_sha256: string;
}

export interface ConsentVersionsState {
  tos: CurrentDocument | null;
  research: CurrentDocument | null;
  loading: boolean;
  error: string | null;
}

export function useConsentVersions(): ConsentVersionsState {
  const [tos, setTos] = useState<CurrentDocument | null>(null);
  const [research, setResearch] = useState<CurrentDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Fetch both in parallel — no auth needed on GET /documents/*.
        const [t, r] = await Promise.all([
          api.get<CurrentDocument>('/documents/diner_tos/current'),
          api.get<CurrentDocument>('/documents/research_consent/current'),
        ]);
        if (cancelled) return;
        setTos(t);
        setResearch(r);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'consent_fetch_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { tos, research, loading, error };
}
