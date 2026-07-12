import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  ChevronRight,
  ClipboardList,
  Clock,
  MapPin,
  Receipt,
  Sparkles,
  Trophy,
  Utensils,
  XCircle,
  AlertCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { LangToggle } from '../components/LangToggle';

/**
 * MySessions — diner-side "where was I?" list.
 *
 * A diner can close the tab / browser mid-meal (server takes forever
 * to arrive, phone rings, etc.) and lose their session URL. This
 * screen surfaces every session tied to the account with a big
 * one-tap "Resume" affordance for whichever ones are still live.
 *
 * Backend: `GET /api/v1/sessions`. Newest-first, capped at 50 rows.
 * Client derives the next-action route + copy from `status` alone —
 * server stays dumb, UX rules stay one place.
 */

type SessionStatus =
  | 'open'
  | 'before_captured'
  | 'eating'
  | 'after_submitted'
  | 'scored'
  | 'pending_staff_validation'
  | 'staff_approved'
  | 'staff_rejected'
  | 'rewarded'
  | 'expired'
  | 'disputed'
  | 'cancelled';

interface SessionRow {
  id: string;
  restaurant_id: string;
  restaurant_name: string;
  restaurant_slug: string;
  table_code: string;
  status: SessionStatus;
  started_at: string;
  expires_at: string;
  cancelled_reason: string | null;
  item_count: number;
  has_bill: boolean;
  has_reward: boolean;
}

// Statuses where the diner still has something to do — surfaced in an
// "In progress" section at the top with a green resume CTA.
const LIVE_STATUSES: SessionStatus[] = [
  'open',
  'before_captured',
  'eating',
  'after_submitted',
  'scored',
  'pending_staff_validation',
];

function isLive(row: SessionRow): boolean {
  return LIVE_STATUSES.includes(row.status);
}

/**
 * Given a session's current status, hand back:
 *   - `path`  → the deep-link the "resume" button navigates to
 *   - `ctaKey`  → i18n key for the button label
 *   - `helpKey` → i18n key for the small "up next" hint
 */
function nextAction(row: SessionRow): {
  path: string;
  ctaKey: string;
  helpKey: string;
} {
  const base = `/sessions/${row.id}`;
  switch (row.status) {
    case 'open':
      // If they already added items, the before photo is up next;
      // otherwise send them back into the Order screen.
      return row.item_count > 0
        ? { path: `${base}/before`, ctaKey: 'my_sessions.cta_take_before', helpKey: 'my_sessions.up_next_before' }
        : { path: `${base}/order`, ctaKey: 'my_sessions.cta_order', helpKey: 'my_sessions.up_next_order' };
    case 'before_captured':
    case 'eating':
      return { path: `${base}/after`, ctaKey: 'my_sessions.cta_after', helpKey: 'my_sessions.up_next_after' };
    case 'after_submitted':
    case 'scored':
    case 'pending_staff_validation':
      return { path: base, ctaKey: 'my_sessions.cta_check', helpKey: 'my_sessions.up_next_review' };
    default:
      return { path: base, ctaKey: 'my_sessions.cta_open', helpKey: 'my_sessions.up_next_view' };
  }
}

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function MySessions() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const { data, isLoading, error } = useQuery({
    queryKey: ['my-sessions'],
    queryFn: () => api.get<SessionRow[]>('/sessions', token),
    enabled: Boolean(token),
    // Refetch on focus so a diner tabbing back sees fresh status
    // (e.g. staff just approved while they were checking email).
    refetchOnWindowFocus: true,
    refetchInterval: 20_000,
  });

  const rows = data ?? [];
  const live = rows.filter(isLive);
  const past = rows.filter((r) => !isLive(r));

  return (
    <div className="d-screen flex flex-col min-h-full">
      <div className="px-5 pt-4 pb-2">
        <div className="spread">
          <span />
          <LangToggle />
        </div>
        <h1 className="display text-[26px] mt-3.5">
          {t('my_sessions.title')}
        </h1>
        <p className="text-[13px] text-muted leading-snug mt-1 max-w-[42ch]">
          {t('my_sessions.blurb')}
        </p>
      </div>

      <div className="px-4 pb-6 flex-1 flex flex-col gap-4">
        {isLoading && (
          <p className="text-muted text-sm text-center py-8">
            {t('my_sessions.loading')}
          </p>
        )}

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {(error as Error).message}
          </p>
        )}

        {!isLoading && rows.length === 0 && (
          <div className="empty">
            <div className="art">
              <ClipboardList size={32} />
            </div>
            <p className="text-sm">{t('my_sessions.empty')}</p>
            <Link
              to="/scan"
              className="btn btn-primary mt-3 min-h-[44px] text-[14px] px-5"
            >
              {t('my_sessions.scan_qr')}
            </Link>
          </div>
        )}

        {live.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="row gap-1.5 items-center text-[11.5px] font-bold tracking-wide dev text-brand uppercase">
              <Clock size={12} />
              {t('my_sessions.section_live', { count: live.length })}
            </div>
            <ul className="flex flex-col gap-2.5">
              {live.map((row) => (
                <SessionCard key={row.id} row={row} live t={t} />
              ))}
            </ul>
          </section>
        )}

        {past.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="row gap-1.5 items-center text-[11.5px] font-bold tracking-wide dev text-muted uppercase">
              <ClipboardList size={12} />
              {t('my_sessions.section_past', { count: past.length })}
            </div>
            <ul className="flex flex-col gap-2.5">
              {past.map((row) => (
                <SessionCard key={row.id} row={row} live={false} t={t} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  row,
  live,
  t,
}: {
  row: SessionRow;
  live: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const action = nextAction(row);
  const chip = statusChip(row, t);

  return (
    <li>
      <Link
        to={action.path}
        className={clsx(
          'card p-3.5 flex flex-col gap-2.5 transition',
          live
            ? 'border-brand/50 bg-brand-wash/40 hover:border-brand'
            : 'hover:border-brand',
        )}
      >
        <div className="row spread items-start gap-2.5">
          <div className="flex-1 min-w-0">
            <div className="row gap-1.5 items-center text-[12px] text-muted">
              <MapPin size={11} />
              <span className="truncate">{row.restaurant_name}</span>
              <span>·</span>
              <span>
                {t('my_sessions.table', { code: row.table_code })}
              </span>
            </div>
            <div className="mt-1 font-bold text-[15px] text-ink truncate">
              {live
                ? t(action.helpKey)
                : t('my_sessions.past_headline', {
                    count: row.item_count,
                  })}
            </div>
            <div className="text-[12px] text-muted mt-0.5">
              {formatWhen(row.started_at)}
              {row.has_bill && (
                <>
                  {' · '}
                  <Receipt size={11} className="inline-block -mt-0.5" />{' '}
                  {t('my_sessions.chip_bill')}
                </>
              )}
              {row.has_reward && (
                <>
                  {' · '}
                  <Sparkles size={11} className="inline-block -mt-0.5" />{' '}
                  {t('my_sessions.chip_reward')}
                </>
              )}
            </div>
          </div>
          {chip}
        </div>
        <div className="row spread items-center pt-1 border-t border-line/60">
          <span className="text-[12px] text-muted">
            {t('my_sessions.item_count', { count: row.item_count })}
          </span>
          <span
            className={clsx(
              'row gap-1 items-center font-bold text-[13px]',
              live ? 'text-brand' : 'text-ink',
            )}
          >
            {t(action.ctaKey)}
            <ChevronRight size={14} />
          </span>
        </div>
      </Link>
    </li>
  );
}

function statusChip(
  row: SessionRow,
  t: ReturnType<typeof useTranslation>['t'],
) {
  // Warm, semantic chip per status. Kept compact — the card headline
  // already carries the "up next" language for live rows.
  switch (row.status) {
    case 'open':
    case 'before_captured':
    case 'eating':
      return (
        <span className="chip chip-brand">
          <Utensils size={11} />
          {t(`my_sessions.status.${row.status}`)}
        </span>
      );
    case 'after_submitted':
    case 'scored':
    case 'pending_staff_validation':
      return (
        <span className="chip chip-amber">
          <Camera size={11} />
          {t(`my_sessions.status.${row.status}`)}
        </span>
      );
    case 'rewarded':
      return (
        <span className="chip chip-saffron">
          <Trophy size={11} />
          {t('my_sessions.status.rewarded')}
        </span>
      );
    case 'staff_approved':
      return (
        <span className="chip chip-sage">
          {t('my_sessions.status.staff_approved')}
        </span>
      );
    case 'staff_rejected':
    case 'cancelled':
      return (
        <span className="chip chip-danger">
          <XCircle size={11} />
          {t(`my_sessions.status.${row.status}`)}
        </span>
      );
    case 'disputed':
      return (
        <span className="chip chip-amber">
          <AlertCircle size={11} />
          {t('my_sessions.status.disputed')}
        </span>
      );
    case 'expired':
      return (
        <span className="chip chip-muted">
          {t('my_sessions.status.expired')}
        </span>
      );
    default:
      return null;
  }
}
