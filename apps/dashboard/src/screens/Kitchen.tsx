import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Flame, Bell, Check, Printer, RefreshCw, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useChime } from '../lib/chime';
import { AutoPrintFrame, printKotEvent } from '../components/KotPrint';

/**
 * KDS — the kitchen's board. Cards per (session × station), one
 * column per station. Chefs advance items queued → fired → ready →
 * served. New KOT events trigger the chime and (if the auto-print
 * toggle is on) a silent window.print() via the hidden iframe.
 *
 * Poll interval matches Live Orders (3 s). No SSE at pilot scale.
 */

const STATION_ORDER = ['hot', 'tandoor', 'cold', 'bar', 'dessert'] as const;
type Station = (typeof STATION_ORDER)[number];

interface KitchenItem {
  id: string;
  menu_item_id: string;
  name: string;
  quantity: number;
  portion_size: 'small' | 'regular' | 'large' | null;
  notes: string | null;
  kitchen_status: 'queued' | 'fired' | 'ready' | 'served' | 'voided';
  fired_at: string | null;
  ready_at: string | null;
}

interface KitchenCard {
  session_id: string;
  table_code: string;
  entry_channel: 'qr' | 'walkin';
  is_takeaway: boolean;
  station: string;
  started_at: string;
  items: KitchenItem[];
}

interface QueueResponse {
  stations: Record<string, KitchenCard[]>;
}

interface KotEvent {
  id: string;
  meal_session_id: string;
  event_type: 'new' | 'add_on' | 'void' | 'reprint';
  station: string;
  items_snapshot: Array<{
    item_id: string;
    menu_item_id: string;
    name: string;
    quantity: number;
    portion_size: string | null;
    notes: string | null;
  }>;
  created_at: string;
  table_code: string;
}

interface EventsResponse {
  events: KotEvent[];
  server_now: string;
}

const AUTO_PRINT_KEY = 'plate_dashboard_kot_autoprint';
const PAGE_SIZE_KEY = 'plate_dashboard_kot_page_size';

// Options for the per-column visible-count dropdown. 0 = show all
// (no cap). 30 is a compromise between "everything's visible on a
// wall-mounted TV" and "don't lag the browser at rush hour".
const PAGE_SIZE_OPTIONS = [10, 20, 30, 50, 0] as const;
const DEFAULT_PAGE_SIZE = 30;

function readPageSize(): number {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;
  const raw = localStorage.getItem(PAGE_SIZE_KEY);
  if (raw === null) return DEFAULT_PAGE_SIZE;
  const n = parseInt(raw, 10);
  return PAGE_SIZE_OPTIONS.includes(n as (typeof PAGE_SIZE_OPTIONS)[number])
    ? n
    : DEFAULT_PAGE_SIZE;
}

function elapsedShort(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function Kitchen() {
  const { t } = useTranslation();
  const token = useAuthStore((s) => s.token);
  const restaurantId = useAuthStore((s) => s.restaurantId);
  const qc = useQueryClient();
  const chime = useChime((s) => s.play);
  const lastSeenEventAt = useRef<string | null>(null);
  const autoPrint = useRef<boolean>(
    typeof window !== 'undefined'
      ? localStorage.getItem(AUTO_PRINT_KEY) === '1'
      : false,
  );
  const printQueueRef = useRef<KotEvent[]>([]);
  const [pageSize, setPageSize] = useState<number>(() => readPageSize());

  function changePageSize(next: number) {
    setPageSize(next);
    localStorage.setItem(PAGE_SIZE_KEY, String(next));
  }

  // Cheap tick so elapsed labels stay live without extra queries.
  const now = useNow(5_000);

  const queueQ = useQuery({
    queryKey: ['kitchen-queue', restaurantId],
    queryFn: () =>
      api.get<QueueResponse>(
        `/restaurants/${restaurantId}/kitchen/queue`,
        token,
      ),
    enabled: !!restaurantId && !!token,
    refetchInterval: 3_000,
  });

  const eventsQ = useQuery({
    queryKey: ['kitchen-events', restaurantId, lastSeenEventAt.current],
    queryFn: async () => {
      const since = lastSeenEventAt.current
        ? `?since=${encodeURIComponent(lastSeenEventAt.current)}`
        : '';
      return api.get<EventsResponse>(
        `/restaurants/${restaurantId}/kitchen/events${since}`,
        token,
      );
    },
    enabled: !!restaurantId && !!token,
    refetchInterval: 4_000,
  });

  // Chime + auto-print on new events. Guard against first-load bulk
  // (we don't want the kitchen alarm going off with every event from
  // today's already-cooked orders when a chef first opens the tab).
  useEffect(() => {
    const data = eventsQ.data;
    if (!data) return;
    const isFirstFetch = lastSeenEventAt.current === null;
    const last = data.events[data.events.length - 1];
    if (last) {
      lastSeenEventAt.current = last.created_at;
    }
    if (isFirstFetch) return; // silent seed
    // Only alert for order-triggering events, not our own reprint
    // taps (those already produced an immediate print on click).
    const alertable = data.events.filter(
      (e) => e.event_type === 'new' || e.event_type === 'add_on',
    );
    if (alertable.length > 0) {
      chime('order');
      if (autoPrint.current) {
        printQueueRef.current.push(...alertable);
        // Kick the print loop.
        void drainPrintQueue(printQueueRef);
      }
    }
    // We also react to void events — silent, no chime, but do refetch
    // the queue so voided items disappear immediately without waiting
    // for the 3 s poll.
    const hasVoid = data.events.some((e) => e.event_type === 'void');
    if (hasVoid || alertable.length > 0) {
      void qc.invalidateQueries({ queryKey: ['kitchen-queue', restaurantId] });
    }
  }, [eventsQ.data, chime, qc, restaurantId]);

  const transition = useMutation({
    mutationFn: ({ itemId, status }: { itemId: string; status: string }) =>
      api.patch(`/kitchen/items/${itemId}/status`, { status }, token),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kitchen-queue', restaurantId] });
    },
  });

  const reprint = useMutation({
    mutationFn: ({
      sessionId,
      station,
    }: {
      sessionId: string;
      station: string;
    }) =>
      api.post<EventsResponse>(
        `/kitchen/sessions/${sessionId}/reprint`,
        { station },
        token,
      ),
    onSuccess: (data) => {
      // Immediate silent print of the reissued tickets.
      data.events.forEach((e) => printKotEvent(e));
    },
  });

  function toggleAutoPrint() {
    autoPrint.current = !autoPrint.current;
    localStorage.setItem(AUTO_PRINT_KEY, autoPrint.current ? '1' : '0');
    // Force a re-render via a tiny query invalidation.
    void qc.invalidateQueries({ queryKey: ['kitchen-queue', restaurantId] });
  }

  if (!restaurantId) {
    return (
      <div className="p-8 text-center text-muted">
        {t('kitchen.pick_restaurant')}
      </div>
    );
  }
  if (queueQ.isLoading) {
    return (
      <div className="p-8 flex items-center justify-center gap-2 text-muted">
        <Loader2 className="animate-spin" size={16} />
        {t('kitchen.loading')}
      </div>
    );
  }

  const stations = queueQ.data?.stations ?? {};
  // All five station columns render every time — empty ones show
  // an idle-state placeholder. Fills the wide screen on kitchen
  // tablets and keeps the layout stable as cards come and go.
  const columns = [...STATION_ORDER] as Station[];

  return (
    <div className="p-4 md:p-6 flex flex-col gap-4 min-h-full">
      <AutoPrintFrame />
      <header className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide text-muted font-semibold">
            {t('kitchen.eyebrow')}
          </div>
          <h1 className="text-[22px] font-display font-semibold">
            {t('kitchen.title')}
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-[13px] select-none">
            <span className="text-muted">{t('kitchen.page_size_label')}</span>
            <select
              value={pageSize}
              onChange={(e) => changePageSize(parseInt(e.target.value, 10))}
              className="h-8 rounded-md border border-s-line bg-white px-2 text-[13px] font-semibold text-ink"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? t('kitchen.page_size_all') : n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[13px] cursor-pointer select-none">
            <input
              type="checkbox"
              defaultChecked={autoPrint.current}
              onChange={toggleAutoPrint}
              className="w-4 h-4 accent-brand"
            />
            <Printer size={14} />
            {t('kitchen.auto_print_label')}
          </label>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        {columns.map((station) => (
          <StationColumn
            key={station}
            station={station}
            cards={stations[station] ?? []}
            now={now}
            pageSize={pageSize}
            onTransition={(itemId, status) =>
              transition.mutate({ itemId, status })
            }
            onReprint={(sessionId) =>
              reprint.mutate({ sessionId, station })
            }
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function StationColumn({
  station,
  cards,
  now,
  pageSize,
  onTransition,
  onReprint,
  t,
}: {
  station: Station;
  cards: KitchenCard[];
  now: number;
  /** Per-column visible cap. 0 means show all (no cap). */
  pageSize: number;
  onTransition: (itemId: string, status: string) => void;
  onReprint: (sessionId: string) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const uncapped = pageSize === 0;
  const showAll = uncapped || expanded || cards.length <= pageSize;
  const visible = showAll ? cards : cards.slice(0, pageSize);
  const hiddenCount = cards.length - visible.length;
  return (
    <section className="rounded-lg bg-s-paper border border-s-line flex flex-col overflow-hidden">
      <header className="px-3 py-2 border-b border-s-line flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StationIcon station={station} />
          <span className="text-[13px] font-bold uppercase tracking-wide">
            {t(`kitchen.station.${station}`)}
          </span>
        </div>
        <span className="text-[11px] text-muted tnum">{cards.length}</span>
      </header>
      <div className="p-2 flex flex-col gap-2 overflow-y-auto flex-1">
        {cards.length === 0 && (
          <div className="text-center text-[12.5px] text-muted py-8">
            {t('kitchen.idle')}
          </div>
        )}
        {visible.map((card) => (
          <OrderCard
            key={`${card.station}-${card.session_id}`}
            card={card}
            now={now}
            onTransition={onTransition}
            onReprint={() => onReprint(card.session_id)}
            t={t}
          />
        ))}
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-1 h-8 rounded-md text-[12px] font-semibold text-brand hover:bg-brand/5 border border-dashed border-brand/40"
          >
            {t('kitchen.show_more', { count: hiddenCount })}
          </button>
        )}
        {expanded && !uncapped && cards.length > pageSize && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="mt-1 h-7 rounded-md text-[11.5px] font-semibold text-muted hover:bg-s-bg"
          >
            {t('kitchen.show_less')}
          </button>
        )}
      </div>
    </section>
  );
}

function OrderCard({
  card,
  now,
  onTransition,
  onReprint,
  t,
}: {
  card: KitchenCard;
  now: number;
  onTransition: (itemId: string, status: string) => void;
  onReprint: () => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const elapsed = elapsedShort(card.started_at, now);
  const isTakeaway = card.is_takeaway;
  return (
    <article className="rounded-md bg-white border border-s-line px-3 py-2.5 shadow-sm">
      <header className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono font-bold text-[13.5px]">
            {isTakeaway ? 'TA' : card.table_code}
          </span>
          {isTakeaway && (
            <span className="text-[9.5px] font-bold bg-amber/15 text-amber px-1.5 py-0.5 rounded uppercase">
              {t('kitchen.takeaway_pill')}
            </span>
          )}
          {card.entry_channel === 'walkin' && !isTakeaway && (
            <span className="text-[9.5px] font-bold bg-info/15 text-info px-1.5 py-0.5 rounded uppercase">
              {t('kitchen.walkin_pill')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted tnum">{elapsed}</span>
          <button
            type="button"
            onClick={onReprint}
            aria-label={t('kitchen.reprint_aria')}
            className="p-1 rounded hover:bg-s-bg text-muted hover:text-ink"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </header>
      <ul className="space-y-1.5">
        {card.items.map((it) => (
          <ItemRow key={it.id} item={it} onTransition={onTransition} t={t} />
        ))}
      </ul>
    </article>
  );
}

function ItemRow({
  item,
  onTransition,
  t,
}: {
  item: KitchenItem;
  onTransition: (itemId: string, status: string) => void;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const nextStatus =
    item.kitchen_status === 'queued'
      ? 'fired'
      : item.kitchen_status === 'fired'
        ? 'ready'
        : item.kitchen_status === 'ready'
          ? 'served'
          : null;
  const nextLabel =
    item.kitchen_status === 'queued'
      ? t('kitchen.fire')
      : item.kitchen_status === 'fired'
        ? t('kitchen.mark_ready')
        : item.kitchen_status === 'ready'
          ? t('kitchen.mark_served')
          : t('kitchen.done');
  const NextIcon =
    item.kitchen_status === 'queued'
      ? Flame
      : item.kitchen_status === 'fired'
        ? Bell
        : Check;
  return (
    <li
      className={clsx(
        'flex items-start gap-2 rounded px-2 py-1.5 border',
        item.kitchen_status === 'queued' && 'border-s-line bg-s-bg/40',
        item.kitchen_status === 'fired' && 'border-amber/50 bg-amber/5',
        item.kitchen_status === 'ready' && 'border-sage/60 bg-sage/10',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono font-bold text-[13px] tnum">
            {item.quantity}×
          </span>
          <span className="text-[13px] font-semibold truncate">{item.name}</span>
          {item.portion_size && item.portion_size !== 'regular' && (
            <span className="text-[10px] uppercase text-muted">
              {item.portion_size}
            </span>
          )}
        </div>
        {item.notes && (
          <div className="text-[11.5px] text-danger mt-0.5 italic leading-tight">
            {item.notes}
          </div>
        )}
      </div>
      {nextStatus && (
        <button
          type="button"
          onClick={() => onTransition(item.id, nextStatus)}
          className={clsx(
            'shrink-0 h-7 px-2 text-[11.5px] font-bold uppercase rounded flex items-center gap-1',
            item.kitchen_status === 'queued' &&
              'bg-brand text-white hover:opacity-90',
            item.kitchen_status === 'fired' &&
              'bg-amber text-white hover:opacity-90',
            item.kitchen_status === 'ready' &&
              'bg-sage text-white hover:opacity-90',
          )}
        >
          <NextIcon size={11} />
          {nextLabel}
        </button>
      )}
    </li>
  );
}

function StationIcon({ station }: { station: Station }) {
  switch (station) {
    case 'hot':
      return <Flame size={14} className="text-amber" />;
    case 'tandoor':
      return <Flame size={14} className="text-danger" />;
    case 'cold':
      return <Bell size={14} className="text-info" />;
    case 'bar':
      return <Bell size={14} className="text-brand" />;
    case 'dessert':
      return <Check size={14} className="text-sage" />;
  }
}

// Small hook that re-renders every `interval` ms so elapsed-time
// labels stay live without a full data refetch.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

async function drainPrintQueue(queueRef: {
  current: KotEvent[];
}): Promise<void> {
  // Prints happen sequentially — window.print() is blocking in some
  // browsers and stacking them causes lost tickets.
  while (queueRef.current.length > 0) {
    const ev = queueRef.current.shift();
    if (!ev) break;
    printKotEvent(ev);
    // Small breather so the browser can flush the previous print job.
    await new Promise((r) => setTimeout(r, 400));
  }
}
