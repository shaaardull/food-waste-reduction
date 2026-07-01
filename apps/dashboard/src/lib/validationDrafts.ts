import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Draft form state for the validation-detail screen, keyed by
 * session_id. A staff member who half-fills the reason / notes /
 * adjusted-score on one session, then hops away to Redeem or
 * Analytics, comes back to find their draft intact. Cleared once
 * the session is decided or explicitly discarded.
 *
 * Persisted to localStorage so drafts survive a browser refresh —
 * dashboard tabs get left open on kitchen displays all the time.
 */
export interface ValidationDraft {
  reason: string;
  notes: string;
  /** 0..1 (matches the API contract). `null` if the slider hasn't been touched. */
  adjustedScore: number | null;
}

interface DraftStore {
  drafts: Record<string, ValidationDraft>;
  getDraft: (sessionId: string) => ValidationDraft | undefined;
  setDraft: (sessionId: string, patch: Partial<ValidationDraft>) => void;
  clearDraft: (sessionId: string) => void;
}

const DEFAULT_DRAFT: ValidationDraft = {
  reason: 'plate_not_clean_enough',
  notes: '',
  adjustedScore: null,
};

export const useValidationDrafts = create<DraftStore>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (sessionId) => get().drafts[sessionId],
      setDraft: (sessionId, patch) =>
        set((s) => ({
          drafts: {
            ...s.drafts,
            [sessionId]: {
              ...DEFAULT_DRAFT,
              ...(s.drafts[sessionId] ?? {}),
              ...patch,
            },
          },
        })),
      clearDraft: (sessionId) =>
        set((s) => {
          if (!(sessionId in s.drafts)) return s;
          const next = { ...s.drafts };
          delete next[sessionId];
          return { drafts: next };
        }),
    }),
    { name: 'plate_dashboard_validation_drafts' },
  ),
);
