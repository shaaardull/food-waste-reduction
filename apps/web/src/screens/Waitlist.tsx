import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, Minus, Plus, Sparkles } from 'lucide-react';
import type { Restaurant } from '@plate-clean/shared-types';
import { api, ApiException } from '../lib/api';
import { useApplyTheme } from '../lib/theme';
import { LangToggle } from '../components/LangToggle';

/**
 * Public /wait/:slug page — walk-in guests join the waitlist from a
 * per-restaurant QR sticker at the entrance. No auth; the entry id
 * lives in sessionStorage keyed by slug so a reload picks up the same
 * spot.
 *
 * Flow:
 *   1. Load restaurant by slug (public GET).
 *   2. If a stored entry id exists, poll its status; render the
 *      appropriate confirmation state without re-prompting.
 *   3. Otherwise render the form.
 *   4. On submit, stash the returned id, switch to confirmation,
 *      poll every 60s.
 *
 * Terminal states (seated / cancelled / no_show) freeze the poll and
 * render a matching card. Guest cancel hits /waitlist/{id}/guest-cancel.
 */

type EntryStatus = 'waiting' | 'seated' | 'cancelled' | 'no_show';

interface SubmitOut {
  id: string;
  position_in_queue: number;
  party_size: number;
  guest_name: string;
  created_at: string;
}

interface PollOut {
  id: string;
  position_in_queue: number;
  status: EntryStatus;
  created_at: string;
}

const STORAGE_PREFIX = 'waitlist-entry-';
const POLL_MS = 60_000;

interface StoredEntry {
  id: string;
  party_size: number;
  guest_name: string;
}

function readStored(slug: string): StoredEntry | null {
  try {
    const raw = sessionStorage.getItem(`${STORAGE_PREFIX}${slug}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredEntry;
  } catch {
    return null;
  }
}

function writeStored(slug: string, value: StoredEntry) {
  sessionStorage.setItem(`${STORAGE_PREFIX}${slug}`, JSON.stringify(value));
}

function clearStored(slug: string) {
  sessionStorage.removeItem(`${STORAGE_PREFIX}${slug}`);
}

export function Waitlist() {
  const { t } = useTranslation();
  const { slug = '' } = useParams();
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [restaurantError, setRestaurantError] = useState<string | null>(null);
  useApplyTheme(restaurant);

  const stored = useMemo(() => readStored(slug), [slug]);
  const [entryId, setEntryId] = useState<string | null>(stored?.id ?? null);
  const [entry, setEntry] = useState<StoredEntry | null>(stored);
  const [poll, setPoll] = useState<PollOut | null>(null);
  const [pollLoading, setPollLoading] = useState<boolean>(Boolean(stored));

  const [partySize, setPartySize] = useState<number>(2);
  const [guestName, setGuestName] = useState('');
  const [guestEmail, setGuestEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Load the restaurant so the header shows a real name + theme.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<Restaurant>(`/restaurants/${slug}`);
        if (!cancelled) setRestaurant(r);
      } catch (err) {
        if (cancelled) return;
        setRestaurantError(
          err instanceof ApiException
            ? err.message
            : t('waitlist.error_restaurant_generic'),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, t]);

  // Poll loop — only runs while we hold an entryId AND the status is
  // still "waiting". A terminal state freezes the last poll response.
  useEffect(() => {
    if (!entryId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      try {
        const p = await api.get<PollOut>(`/waitlist/${entryId}`);
        if (cancelled) return;
        setPoll(p);
        setPollLoading(false);
        if (p.status === 'waiting') {
          timer = setTimeout(tick, POLL_MS);
        }
      } catch (err) {
        if (cancelled) return;
        setPollLoading(false);
        // Entry deleted / never existed — drop the stored id so the
        // guest can start over cleanly.
        if (err instanceof ApiException && err.status === 404) {
          clearStored(slug);
          setEntryId(null);
          setEntry(null);
        } else {
          // transient — try again on the normal cadence
          timer = setTimeout(tick, POLL_MS);
        }
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [entryId, slug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitError(null);
    const trimmedName = guestName.trim();
    if (!trimmedName) {
      setSubmitError(t('waitlist.error_name_required'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.post<SubmitOut>(
        `/restaurants/${slug}/waitlist`,
        {
          party_size: partySize,
          guest_name: trimmedName,
          guest_email: guestEmail.trim() || undefined,
          notes: notes.trim() || undefined,
        },
      );
      const stash: StoredEntry = {
        id: res.id,
        party_size: res.party_size,
        guest_name: res.guest_name,
      };
      writeStored(slug, stash);
      setEntry(stash);
      setEntryId(res.id);
      setPoll({
        id: res.id,
        position_in_queue: res.position_in_queue,
        status: 'waiting',
        created_at: res.created_at,
      });
      setPollLoading(false);
    } catch (err) {
      setSubmitError(
        err instanceof ApiException ? err.message : t('waitlist.error_submit_generic'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLeave() {
    if (!entryId || leaving) return;
    setLeaving(true);
    try {
      await api.post(`/waitlist/${entryId}/guest-cancel`, {
        reason: 'guest_cancelled',
      });
      clearStored(slug);
      setPoll(
        (p) =>
          p && {
            ...p,
            status: 'cancelled',
          },
      );
      setConfirmingLeave(false);
    } catch (err) {
      // If the entry is already seated / cancelled the confirm just
      // clears — flip to whatever the poll returns next.
      setConfirmingLeave(false);
      if (err instanceof ApiException && err.status === 409) {
        // trigger a fresh poll by nudging the entryId cycle
        const p = await api.get<PollOut>(`/waitlist/${entryId}`).catch(() => null);
        if (p) setPoll(p);
      }
    } finally {
      setLeaving(false);
    }
  }

  const status = poll?.status ?? 'waiting';
  const showForm = !entryId;
  const showWaitingCard = Boolean(entryId) && status === 'waiting';
  const showSeatedCard = status === 'seated';
  const showRemovedCard = status === 'cancelled' || status === 'no_show';

  return (
    <div className="d-screen min-h-full flex flex-col">
      <header className="px-5 pt-4 pb-3 flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="text-[13px] font-semibold text-muted uppercase tracking-wide dev">
            {t('waitlist.eyebrow')}
          </div>
          <h1 className="display text-[26px] leading-tight">
            {restaurant?.name ?? t('waitlist.loading_restaurant')}
          </h1>
          <p className="text-sm text-muted leading-snug">{t('waitlist.subtitle')}</p>
        </div>
        <LangToggle />
      </header>

      <div className="px-4 pb-24 flex flex-col gap-4 flex-1">
        {restaurantError && (
          <div className="card p-4 text-sm text-alert leading-snug">
            {restaurantError}
          </div>
        )}

        {showForm && !restaurantError && (
          <form onSubmit={handleSubmit} className="card p-5 flex flex-col gap-5">
            <PartySizeStepper
              value={partySize}
              onChange={setPartySize}
              label={t('waitlist.field_party_size')}
            />

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">
                {t('waitlist.field_name')}
              </span>
              <input
                type="text"
                inputMode="text"
                autoComplete="name"
                required
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder={t('waitlist.field_name_placeholder')}
                className="min-h-[48px] rounded-lg border border-line px-3.5 text-base bg-paper"
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">
                {t('waitlist.field_email')}{' '}
                <span className="text-muted font-normal">
                  {t('waitlist.field_optional')}
                </span>
              </span>
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                value={guestEmail}
                onChange={(e) => setGuestEmail(e.target.value)}
                placeholder={t('waitlist.field_email_placeholder')}
                className="min-h-[48px] rounded-lg border border-line px-3.5 text-base bg-paper"
              />
              <span className="text-xs text-muted">
                {t('waitlist.field_email_helper')}
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold text-ink">
                {t('waitlist.field_notes')}{' '}
                <span className="text-muted font-normal">
                  {t('waitlist.field_optional')}
                </span>
              </span>
              <textarea
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('waitlist.field_notes_placeholder')}
                className="rounded-lg border border-line px-3.5 py-2.5 text-base bg-paper resize-none"
              />
            </label>

            {submitError && (
              <div className="text-sm text-alert leading-snug">{submitError}</div>
            )}

            <button
              type="submit"
              disabled={submitting || !guestName.trim()}
              className="btn btn-primary btn-block btn-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('waitlist.submit_pending')}
                </>
              ) : (
                t('waitlist.submit_cta')
              )}
            </button>
          </form>
        )}

        {pollLoading && !poll && entryId && (
          <div className="card p-6 text-center text-muted text-sm">
            <Loader2 size={18} className="animate-spin inline mr-2" />
            {t('waitlist.loading_position')}
          </div>
        )}

        {showWaitingCard && poll && (
          <WaitingCard
            position={poll.position_in_queue}
            partySize={entry?.party_size ?? poll.position_in_queue}
            t={t}
          />
        )}

        {showSeatedCard && (
          <SeatedCard t={t} />
        )}

        {showRemovedCard && (
          <RemovedCard t={t} />
        )}
      </div>

      {showWaitingCard && (
        <div className="sticky bottom-0 bg-paper border-t border-line px-4 py-3 shadow-lg">
          {confirmingLeave ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-ink text-center">
                {t('waitlist.leave_confirm')}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmingLeave(false)}
                  className="btn btn-outline btn-block"
                  disabled={leaving}
                >
                  {t('waitlist.leave_stay')}
                </button>
                <button
                  type="button"
                  onClick={handleLeave}
                  className="btn btn-primary btn-block"
                  disabled={leaving}
                >
                  {leaving ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    t('waitlist.leave_confirm_cta')
                  )}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingLeave(true)}
              className="btn btn-outline btn-block"
            >
              {t('waitlist.leave_cta')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface PartySizeStepperProps {
  value: number;
  onChange: (v: number) => void;
  label: string;
}

function PartySizeStepper({ value, onChange, label }: PartySizeStepperProps) {
  const clamp = (n: number) => Math.min(20, Math.max(1, n));
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-ink">{label}</span>
      <div className="flex items-center justify-between border border-line rounded-lg bg-paper px-1.5 py-1.5">
        <button
          type="button"
          aria-label="decrement"
          onClick={() => onChange(clamp(value - 1))}
          disabled={value <= 1}
          className="w-11 h-11 rounded-lg flex items-center justify-center text-ink disabled:opacity-30 hover:bg-brand-wash"
        >
          <Minus size={18} />
        </button>
        <div className="tnum font-bold text-2xl text-ink">{value}</div>
        <button
          type="button"
          aria-label="increment"
          onClick={() => onChange(clamp(value + 1))}
          disabled={value >= 20}
          className="w-11 h-11 rounded-lg flex items-center justify-center text-ink disabled:opacity-30 hover:bg-brand-wash"
        >
          <Plus size={18} />
        </button>
      </div>
    </div>
  );
}

interface WaitingCardProps {
  position: number;
  partySize: number;
  t: ReturnType<typeof useTranslation>['t'];
}

function WaitingCard({ position, partySize, t }: WaitingCardProps) {
  return (
    <section className="card p-6 flex flex-col items-center text-center gap-3 bg-brand-wash/50 border-brand-line">
      <div className="text-[13px] font-semibold text-brand uppercase tracking-wide dev">
        {t('waitlist.waiting_eyebrow')}
      </div>
      <div className="font-mono font-bold text-[68px] leading-none text-ink">
        #{position}
      </div>
      <p className="text-[15px] text-ink leading-snug max-w-[38ch]">
        {t('waitlist.waiting_body', { partySize })}
      </p>
      <p className="text-xs text-muted mt-2">{t('waitlist.waiting_poll_note')}</p>
    </section>
  );
}

interface SeatedCardProps {
  t: ReturnType<typeof useTranslation>['t'];
}

function SeatedCard({ t }: SeatedCardProps) {
  return (
    <section className="card p-6 flex flex-col items-center text-center gap-3 bg-sage-wash/50 border-sage/20">
      <div className="w-14 h-14 rounded-full bg-sage-wash text-sage flex items-center justify-center">
        <Sparkles size={26} />
      </div>
      <h2 className="display text-[28px] leading-tight">
        {t('waitlist.seated_title')}
      </h2>
      <p className="text-[15px] text-ink leading-snug max-w-[36ch]">
        {t('waitlist.seated_body')}
      </p>
    </section>
  );
}

interface RemovedCardProps {
  t: ReturnType<typeof useTranslation>['t'];
}

function RemovedCard({ t }: RemovedCardProps) {
  return (
    <section className="card p-6 flex flex-col items-center text-center gap-3">
      <div className="w-14 h-14 rounded-full bg-paper text-muted flex items-center justify-center border border-line">
        <CheckCircle2 size={24} />
      </div>
      <h2 className="display text-[24px] leading-tight">
        {t('waitlist.removed_title')}
      </h2>
      <p className="text-sm text-muted leading-snug max-w-[36ch]">
        {t('waitlist.removed_body')}
      </p>
    </section>
  );
}

