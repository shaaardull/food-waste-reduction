import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  Loader2,
  Mail,
  MoreVertical,
  Phone,
  Printer,
  Timer,
  UserRound,
  Users,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useToasts } from '../lib/toasts';

/**
 * Waitlist — walk-in queue at the door. Oldest-first list with a
 * prominent "Seat" action per row. Owner + manager + server may act;
 * the API guards on the same rule.
 *
 * Design choices worth flagging:
 *   - No prediction of ETA beyond a median-so-far chip. Wait-time
 *     estimates are a rabbit hole; visibility is enough for the pilot.
 *   - Seat is optimistic: we remove the card from the list before the
 *     API round-trip so the counter stays snappy during a rush. On
 *     failure we restore + toast, then let the poll re-sync.
 *   - Poll every 10 s. The dashboard rail also polls badges every 15 s
 *     — 10 s here keeps the queue feeling live without a second cache
 *     for the total-waiting count.
 */

interface WaitlistEntry {
  id: string;
  party_size: number;
  guest_name: string;
  guest_email: string | null;
  guest_phone: string | null;
  notes: string | null;
  status: 'waiting' | 'seated' | 'cancelled' | 'no_show';
  created_at: string;
  seated_at: string | null;
  seated_by_user_id: string | null;
  cancelled_at: string | null;
  cancelled_reason: string | null;
}

interface QueueOut {
  active: WaitlistEntry[];
  recent: WaitlistEntry[] | null;
}

const POLL_MS = 10_000;

function minutesSince(iso: string): number {
  const then = new Date(iso).getTime();
  return Math.max(0, Math.round((Date.now() - then) / 60_000));
}

function medianMinutes(entries: WaitlistEntry[]): number | null {
  const durations = entries
    .filter((e) => e.status === 'seated' && e.seated_at)
    .map((e) =>
      Math.max(
        0,
        Math.round(
          (new Date(e.seated_at as string).getTime() -
            new Date(e.created_at).getTime()) /
            60_000,
        ),
      ),
    )
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  if (durations.length % 2 === 0) {
    const a = durations[mid - 1] ?? 0;
    const b = durations[mid] ?? 0;
    return Math.round((a + b) / 2);
  }
  return durations[mid] ?? 0;
}

const DINER_BASE =
  import.meta.env.VITE_DINER_APP_BASE_URL ?? 'http://localhost:5173';

export function Waitlist() {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const restaurantId = useAuthStore((s) => s.restaurantId);
  const activeRestaurant = useAuthStore((s) => s.activeRestaurant);
  const queryClient = useQueryClient();
  const pushToast = useToasts((s) => s.push);

  const [showRecent, setShowRecent] = useState(false);
  const [optimisticallyCleared, setOptimisticallyCleared] = useState<Set<string>>(
    new Set(),
  );
  const [cancelDraft, setCancelDraft] = useState<{
    entry: WaitlistEntry;
    reason: string;
  } | null>(null);

  const { data, isLoading, error } = useQuery<QueueOut>({
    queryKey: ['waitlist', restaurantId, showRecent],
    queryFn: () =>
      api.get<QueueOut>(
        `/restaurants/${restaurantId}/waitlist${
          showRecent ? '?include_recent=true' : ''
        }`,
        token,
      ),
    enabled: Boolean(restaurantId && token),
    refetchInterval: POLL_MS,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const active = useMemo(
    () =>
      (data?.active ?? []).filter((e) => !optimisticallyCleared.has(e.id)),
    [data, optimisticallyCleared],
  );

  const median = useMemo(() => medianMinutes(data?.recent ?? []), [data]);

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['waitlist', restaurantId] });
  }

  const seatMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<WaitlistEntry>(`/waitlist/${id}/seat`, undefined, token),
    onMutate: (id: string) => {
      setOptimisticallyCleared((prev) => new Set(prev).add(id));
    },
    onError: (err, id) => {
      setOptimisticallyCleared((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      pushToast({
        tone: 'alert',
        title: t('dashboard.waitlist.toast_seat_error_title'),
        body: err instanceof ApiException ? err.message : undefined,
      });
    },
    onSettled: () => {
      invalidate();
      // Clear the optimistic set on the next tick — the invalidate
      // will refetch and by then the row is gone from `active` in
      // the server response too.
      window.setTimeout(() => {
        setOptimisticallyCleared(new Set());
      }, 500);
    },
  });

  const noShowMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<WaitlistEntry>(`/waitlist/${id}/no-show`, undefined, token),
    onMutate: (id: string) => {
      setOptimisticallyCleared((prev) => new Set(prev).add(id));
    },
    onError: (err, id) => {
      setOptimisticallyCleared((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      pushToast({
        tone: 'alert',
        title: t('dashboard.waitlist.toast_action_error'),
        body: err instanceof ApiException ? err.message : undefined,
      });
    },
    onSettled: () => {
      invalidate();
      window.setTimeout(() => setOptimisticallyCleared(new Set()), 500);
    },
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post<WaitlistEntry>(`/waitlist/${id}/cancel`, { reason }, token),
    onSuccess: () => {
      pushToast({
        tone: 'brand',
        title: t('dashboard.waitlist.toast_cancel_success'),
      });
      setCancelDraft(null);
      invalidate();
    },
    onError: (err) => {
      pushToast({
        tone: 'alert',
        title: t('dashboard.waitlist.toast_action_error'),
        body: err instanceof ApiException ? err.message : undefined,
      });
    },
  });

  const waitlistUrl = activeRestaurant
    ? `${DINER_BASE.replace(/\/$/, '')}/wait/${activeRestaurant.slug}`
    : '';
  const printUrl = activeRestaurant
    ? `/-/waitlist-print?slug=${encodeURIComponent(activeRestaurant.slug)}&name=${encodeURIComponent(activeRestaurant.name)}`
    : '';

  return (
    <div className="flex flex-col gap-5">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-[22px] font-bold text-s-ink">
            {t('dashboard.waitlist.title')}
          </h1>
          <p className="text-sm text-s-muted">
            {t('dashboard.waitlist.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div
            className="chip chip-brand"
            aria-label={t('dashboard.waitlist.chip_waiting_aria')}
          >
            <Users size={13} />
            <span>
              {t('dashboard.waitlist.chip_waiting', { count: active.length })}
            </span>
          </div>
          {median !== null && (
            <div className="chip chip-sage" aria-label={t('dashboard.waitlist.chip_median_aria')}>
              <Timer size={13} />
              <span>
                {t('dashboard.waitlist.chip_median', { minutes: median })}
              </span>
            </div>
          )}
          {printUrl && (
            <Link
              to={printUrl}
              target="_blank"
              rel="noopener"
              className="chip chip-muted hover:bg-s-line"
            >
              <Printer size={13} />
              <span>{t('dashboard.waitlist.print_cta')}</span>
            </Link>
          )}
        </div>
      </header>

      {isLoading && !data && (
        <div className="card p-6 text-center text-s-muted text-sm">
          <Loader2 size={16} className="inline animate-spin mr-2" />
          {t('dashboard.waitlist.loading')}
        </div>
      )}

      {error && (
        <div className="card p-4 text-sm text-danger bg-danger-wash border-danger/20">
          {(error as Error).message}
        </div>
      )}

      {!isLoading && active.length === 0 && (
        <EmptyState
          slug={activeRestaurant?.slug ?? ''}
          waitlistUrl={waitlistUrl}
          t={t}
        />
      )}

      {active.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {active.map((entry, idx) => (
            <WaitingRow
              key={entry.id}
              entry={entry}
              position={idx + 1}
              highlight={idx === 0}
              seating={seatMutation.isPending && seatMutation.variables === entry.id}
              onSeat={() => seatMutation.mutate(entry.id)}
              onNoShow={() => noShowMutation.mutate(entry.id)}
              onCancel={() => setCancelDraft({ entry, reason: '' })}
              t={t}
            />
          ))}
        </ul>
      )}

      {/* Recently cleared toggle */}
      <div className="border-t border-s-line pt-4 mt-2">
        <button
          type="button"
          onClick={() => setShowRecent((s) => !s)}
          className="row gap-2 items-center text-[13px] font-semibold text-s-muted hover:text-s-ink"
          aria-expanded={showRecent}
        >
          <ChevronDown
            size={14}
            className={clsx('transition', showRecent && 'rotate-180')}
          />
          <span>
            {t('dashboard.waitlist.recent_toggle', {
              count: data?.recent?.length ?? 0,
            })}
          </span>
        </button>
        {showRecent && (
          <div className="mt-3">
            {(!data?.recent || data.recent.length === 0) && (
              <p className="text-sm text-s-muted italic">
                {t('dashboard.waitlist.recent_empty')}
              </p>
            )}
            {data?.recent && data.recent.length > 0 && (
              <ul className="flex flex-col gap-2">
                {data.recent.map((entry) => (
                  <RecentRow key={entry.id} entry={entry} t={t} />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {cancelDraft && (
        <CancelModal
          entry={cancelDraft.entry}
          reason={cancelDraft.reason}
          onReasonChange={(reason) =>
            setCancelDraft((d) => (d ? { ...d, reason } : d))
          }
          onCancel={() => setCancelDraft(null)}
          onConfirm={() => {
            const r = cancelDraft.reason.trim();
            if (!r) return;
            cancelMutation.mutate({ id: cancelDraft.entry.id, reason: r });
          }}
          submitting={cancelMutation.isPending}
          t={t}
        />
      )}
    </div>
  );
}

interface WaitingRowProps {
  entry: WaitlistEntry;
  position: number;
  highlight: boolean;
  seating: boolean;
  onSeat: () => void;
  onNoShow: () => void;
  onCancel: () => void;
  t: (k: string, v?: Record<string, unknown>) => string;
}

function WaitingRow({
  entry,
  position,
  highlight,
  seating,
  onSeat,
  onNoShow,
  onCancel,
  t,
}: WaitingRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const waitingMins = minutesSince(entry.created_at);
  return (
    <li
      className={clsx(
        'card p-3 md:p-4 flex items-stretch gap-3',
        highlight && 'ring-1 ring-brand bg-brand-wash/40',
      )}
    >
      {/* Position badge */}
      <div
        className={clsx(
          'shrink-0 w-14 md:w-16 rounded-lg flex flex-col items-center justify-center font-bold tnum',
          highlight
            ? 'bg-brand text-white'
            : 'bg-brand-wash text-brand',
        )}
      >
        <div className="text-[26px] leading-none">{position}</div>
        <div className="text-[10px] uppercase tracking-wide font-semibold mt-0.5 opacity-80">
          {t('dashboard.waitlist.position_label')}
        </div>
      </div>

      {/* Middle */}
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-bold text-s-ink text-[15px] truncate">
            {entry.guest_name}
          </span>
          <span className="chip chip-muted">
            <UserRound size={12} />
            {t('dashboard.waitlist.party_size', { count: entry.party_size })}
          </span>
          <span className="text-xs text-s-muted inline-flex items-center gap-1">
            <Timer size={12} />
            {t('dashboard.waitlist.waiting_for', { minutes: waitingMins })}
          </span>
        </div>
        {(entry.guest_email || entry.guest_phone) && (
          <div className="text-xs text-s-muted flex items-center gap-3 flex-wrap">
            {entry.guest_phone && (
              <span className="inline-flex items-center gap-1">
                <Phone size={11} />
                {entry.guest_phone}
              </span>
            )}
            {entry.guest_email && (
              <span className="inline-flex items-center gap-1">
                <Mail size={11} />
                {entry.guest_email}
              </span>
            )}
          </div>
        )}
        {entry.notes && (
          <div className="text-xs italic text-s-muted mt-0.5">
            {entry.notes}
          </div>
        )}
      </div>

      {/* Right actions */}
      <div className="shrink-0 flex items-center gap-2 relative">
        <button
          type="button"
          onClick={onSeat}
          disabled={seating}
          className="btn btn-primary min-h-[42px] px-4 text-[14px]"
        >
          {seating ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            t('dashboard.waitlist.seat_cta')
          )}
        </button>
        <button
          type="button"
          aria-label={t('dashboard.waitlist.more_actions_aria')}
          onClick={() => setMenuOpen((s) => !s)}
          className="w-9 h-9 rounded-md hover:bg-s-line/50 flex items-center justify-center text-s-muted"
        >
          <MoreVertical size={16} />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 z-20 min-w-[180px] card p-1 flex flex-col text-[13px] shadow-lg"
            onMouseLeave={() => setMenuOpen(false)}
          >
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onNoShow();
              }}
              className="text-left px-3 py-2 rounded-md hover:bg-s-line/50"
            >
              {t('dashboard.waitlist.action_no_show')}
            </button>
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onCancel();
              }}
              className="text-left px-3 py-2 rounded-md hover:bg-s-line/50"
            >
              {t('dashboard.waitlist.action_cancel')}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

interface RecentRowProps {
  entry: WaitlistEntry;
  t: (k: string, v?: Record<string, unknown>) => string;
}

function RecentRow({ entry, t }: RecentRowProps) {
  const clearedAt = entry.seated_at ?? entry.cancelled_at ?? entry.created_at;
  const cleared = new Date(clearedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const tone =
    entry.status === 'seated'
      ? 'chip-sage'
      : entry.status === 'no_show'
        ? 'chip-muted'
        : 'chip-amber';
  return (
    <li className="card-flat px-3 py-2 flex items-center gap-3 text-sm">
      <span className={`chip ${tone}`}>
        {t(`dashboard.waitlist.status.${entry.status}`)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-s-ink truncate">
          {entry.guest_name}
          <span className="ml-2 text-xs text-s-muted font-normal">
            · {t('dashboard.waitlist.party_size', { count: entry.party_size })}
          </span>
        </div>
        {entry.cancelled_reason && entry.status !== 'seated' && (
          <div className="text-xs text-s-muted truncate">
            {entry.cancelled_reason}
          </div>
        )}
      </div>
      <div className="text-xs text-s-muted tnum">{cleared}</div>
    </li>
  );
}

interface EmptyStateProps {
  slug: string;
  waitlistUrl: string;
  t: (k: string, v?: Record<string, unknown>) => string;
}

function EmptyState({ slug, waitlistUrl, t }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="w-16 h-16 rounded-full bg-brand-wash text-brand flex items-center justify-center mb-3">
        <Users size={26} />
      </div>
      <p className="font-semibold text-s-ink text-[15px]">
        {t('dashboard.waitlist.empty_title')}
      </p>
      {slug && (
        <p className="text-[13px] text-s-muted mt-2 max-w-[42ch] leading-snug">
          {t('dashboard.waitlist.empty_hint', { url: waitlistUrl })}
        </p>
      )}
    </div>
  );
}

interface CancelModalProps {
  entry: WaitlistEntry;
  reason: string;
  onReasonChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
  t: (k: string, v?: Record<string, unknown>) => string;
}

function CancelModal({
  entry,
  reason,
  onReasonChange,
  onCancel,
  onConfirm,
  submitting,
  t,
}: CancelModalProps) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="card w-full max-w-[420px] p-5 flex flex-col gap-4">
        <div>
          <h2 className="font-bold text-[17px] text-s-ink">
            {t('dashboard.waitlist.cancel_title', { name: entry.guest_name })}
          </h2>
          <p className="text-sm text-s-muted mt-1">
            {t('dashboard.waitlist.cancel_subtitle')}
          </p>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-s-ink">
            {t('dashboard.waitlist.cancel_reason_label')}
          </span>
          <input
            type="text"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            placeholder={t('dashboard.waitlist.cancel_reason_placeholder')}
            className="min-h-[42px] rounded-lg border border-s-line px-3 text-sm bg-white"
            autoFocus
          />
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-outline flex-1"
            disabled={submitting}
          >
            {t('dashboard.waitlist.cancel_dismiss')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn btn-primary flex-1"
            disabled={submitting || !reason.trim()}
          >
            {submitting ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              t('dashboard.waitlist.cancel_confirm')
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
