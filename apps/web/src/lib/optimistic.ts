import { create } from 'zustand';

/**
 * Optimistic upload tracker — a client-only Zustand slice for pieces
 * of state that must show up in the UI BEFORE the server confirms.
 *
 * Currently the only thing here is the before-photo capture:
 *   • The moment the diner taps "Submit" on the before-photo screen
 *     we mark the session as `pending` and navigate to /sessions/:id.
 *   • SessionStatus reads this store and treats an `open` server
 *     status as `before_captured` while the flag is `pending`.
 *   • On upload success, the Capture component calls `markBeforeDone`
 *     — the flag clears and the polling on /sessions/:id syncs to
 *     the real server truth (which by now says `before_captured`).
 *   • On upload failure, `markBeforeError` records the message. The
 *     SessionStatus screen renders a red retry banner with a "Try
 *     again" affordance instead of the "Claim after" CTA.
 *
 * Why not use TanStack Query's optimistic-update helpers?
 * The Capture component unmounts as soon as we navigate away from
 * the camera view. TanStack's mutation callbacks fire on the query
 * client (which survives) but the mutation ID is tied to the
 * component — the onError/onSuccess wiring gets flaky across
 * unmounts. A dedicated store keeps the state explicit and
 * inspectable in DevTools.
 */

export type BeforeUploadState =
  | { kind: 'pending' }
  | { kind: 'error'; message: string };

interface OptimisticStore {
  /** Session ID → current optimistic before-upload state. */
  beforeUploads: Record<string, BeforeUploadState>;
  markBeforePending: (sessionId: string) => void;
  markBeforeDone: (sessionId: string) => void;
  markBeforeError: (sessionId: string, message: string) => void;
  getBefore: (sessionId: string) => BeforeUploadState | undefined;
}

export const useOptimisticStore = create<OptimisticStore>((set, get) => ({
  beforeUploads: {},
  markBeforePending: (sessionId) =>
    set((s) => ({
      beforeUploads: { ...s.beforeUploads, [sessionId]: { kind: 'pending' } },
    })),
  markBeforeDone: (sessionId) =>
    set((s) => {
      // Remove the entry entirely so `getBefore` returns undefined
      // — the SessionStatus screen falls straight back to the
      // server-reported status once we're synced.
      const next = { ...s.beforeUploads };
      delete next[sessionId];
      return { beforeUploads: next };
    }),
  markBeforeError: (sessionId, message) =>
    set((s) => ({
      beforeUploads: {
        ...s.beforeUploads,
        [sessionId]: { kind: 'error', message },
      },
    })),
  getBefore: (sessionId) => get().beforeUploads[sessionId],
}));
