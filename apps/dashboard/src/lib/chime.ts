import { create } from 'zustand';

/**
 * Chime — the "ting" the staff dashboard plays when a new order,
 * validation, dispute, or reward-claim lands. Backed by the Web Audio
 * API so we don't need to ship / cache an mp3, and so the sound
 * survives ad-blockers / firewalls that block media asset fetches.
 *
 * Four distinct pitches so a busy staff can tell the events apart by
 * ear without looking at the screen. All variants share a bell-like
 * envelope (fast attack, gentle exponential decay) so they read as
 * the same instrument, not four unrelated beeps.
 *
 * Mute preference persists in localStorage so a staff who silenced it
 * at the start of a shift doesn't get re-surprised the next time they
 * refresh. The very first play attempt is gated on a user gesture
 * anywhere in the tab (browser autoplay policy); we lazy-construct
 * the AudioContext the first time `playChime` is invoked.
 */

export type ChimeKind = 'order' | 'validation' | 'reward' | 'dispute';

const FREQUENCIES: Record<ChimeKind, number> = {
  order: 880,       // A5 — bright, "attention"
  validation: 988,  // B5 — one step up, "task waiting"
  reward: 1319,     // E6 — celebratory
  dispute: 660,     // E5 — lower, more serious
};

let _ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  if (_ctx === null) {
    try {
      _ctx = new Ctor();
    } catch {
      _ctx = null;
    }
  }
  return _ctx;
}

// A gentle two-note bell — the fundamental plus its perfect fifth,
// with a quick attack and a ~0.4 s exponential decay. Feels like
// a hotel counter bell rather than an OS notification blip.
function tingAt(freq: number) {
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    // Autoplay-policy resume. Safe to fire-and-forget — if the promise
    // rejects (no user gesture yet), the whole play call silently no-ops.
    void ctx.resume().catch(() => undefined);
  }
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.22, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  gain.connect(ctx.destination);

  const fundamental = ctx.createOscillator();
  fundamental.type = 'sine';
  fundamental.frequency.setValueAtTime(freq, now);
  fundamental.connect(gain);

  const fifth = ctx.createOscillator();
  fifth.type = 'sine';
  fifth.frequency.setValueAtTime(freq * 1.5, now);
  const fifthGain = ctx.createGain();
  fifthGain.gain.setValueAtTime(0.35, now);
  fifth.connect(fifthGain).connect(gain);

  fundamental.start(now);
  fifth.start(now);
  fundamental.stop(now + 0.5);
  fifth.stop(now + 0.5);
}

// ── Zustand slice for the mute preference ───────────────────────────

const STORAGE_KEY = 'plate-clean:staff:chime-muted';

function readMuted(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
  } catch {
    // ignore quota / private-mode errors
  }
}

interface ChimeStore {
  muted: boolean;
  toggle: () => void;
  play: (kind: ChimeKind) => void;
}

export const useChime = create<ChimeStore>((set, get) => ({
  muted: readMuted(),
  toggle: () => {
    const next = !get().muted;
    writeMuted(next);
    set({ muted: next });
    // Small confirmation ping when unmuting so the staff hears the
    // level they'll get during the shift. Doubles as the user
    // gesture that unlocks the audio context.
    if (!next) tingAt(FREQUENCIES.order);
  },
  play: (kind) => {
    if (get().muted) return;
    tingAt(FREQUENCIES[kind]);
  },
}));
