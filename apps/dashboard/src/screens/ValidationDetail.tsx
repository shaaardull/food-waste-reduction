import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ShieldAlert,
  HelpCircle,
  AlertTriangle,
  Check,
  Sliders,
  X,
  Flag,
  Gift,
  GripVertical,
  StickyNote,
  Receipt,
  ClipboardList,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';
import { useValidationDrafts } from '../lib/validationDrafts';
import { BillSendModal } from '../components/BillSendModal';

interface Bundle {
  session_id: string;
  table_code: string;
  score: number;
  before_image_url: string;
  after_image_url: string;
  ordered_items: Array<{
    name: string;
    quantity: number;
    portion_size: string | null;
    notes: string | null;
  }>;
  model_notes: string | null;
  model_confidence: number | null;
  suspicious: boolean;
  fraud_signals: Array<{
    signal_type: string;
    severity: string;
    details: Record<string, unknown>;
  }>;
}

const REASON_CODES = [
  'plate_not_clean_enough',
  'wrong_plate_photographed',
  'food_hidden_or_discarded',
  'image_quality_issue',
  'model_overestimated',
  'model_underestimated',
  'dispute_with_diner',
  'other',
] as const;

type Decision = 'approved' | 'adjusted' | 'rejected' | 'escalated' | 'grant';

/**
 * ValidationDetail — the staff "approve/adjust/reject/escalate" screen.
 *
 * Layout:
 *   - top breadcrumb with the table chip and signal chips
 *   - compare slider (before vs after, dragged horizontally) so staff
 *     can eyeball waste in one glance instead of A/B'ing two thumbs
 *   - ordered-items + fraud-signal panel
 *   - decision form: reason chip picker, score slider (only relevant
 *     when adjusting), notes textarea
 *   - sticky decision bar at the bottom: Approve / Adjust / Reject /
 *     Escalate, each colour-coded to the action it represents
 */
export function ValidationDetail() {
  const { t } = useTranslation();
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);

  // Draft store: keeps this session's form fields alive across route
  // changes so a half-filled review isn't lost if the staff member
  // hops away to Redeem or Analytics and back.
  const drafts = useValidationDrafts();
  const initialDraft = drafts.getDraft(sessionId);
  const [adjustedScore, setAdjustedScoreState] = useState<number | null>(
    initialDraft?.adjustedScore ?? null,
  );
  const [reason, setReasonState] = useState<string>(
    initialDraft?.reason ?? 'plate_not_clean_enough',
  );
  const [notes, setNotesState] = useState<string>(initialDraft?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Decision | null>(null);
  const [billModalOpen, setBillModalOpen] = useState(false);

  // Wrap setters so every change funnels into the draft store, keyed
  // by sessionId. No debounce needed — the store is in-process.
  function setAdjustedScore(next: number | null) {
    setAdjustedScoreState(next);
    drafts.setDraft(sessionId, { adjustedScore: next });
  }
  function setReason(next: string) {
    setReasonState(next);
    drafts.setDraft(sessionId, { reason: next });
  }
  function setNotes(next: string) {
    setNotesState(next);
    drafts.setDraft(sessionId, { notes: next });
  }

  const { data: bundle, isLoading } = useQuery({
    queryKey: ['bundle', sessionId],
    queryFn: () => api.get<Bundle>(`/sessions/${sessionId}/validation-bundle`, token),
  });

  const mutate = useMutation({
    mutationFn: (body: {
      decision: string;
      final_score?: number;
      reason_code?: string;
      notes?: string;
    }) => api.post(`/sessions/${sessionId}/validate`, body, token),
    onSuccess: () => {
      // Decision recorded — draft is no longer needed.
      drafts.clearDraft(sessionId);
      queryClient.invalidateQueries({ queryKey: ['pending'] });
      navigate('/validations');
    },
    onError: (err: ApiException) => {
      setError(err.message);
      setPending(null);
    },
  });

  if (isLoading || !bundle) {
    return <p className="text-s-muted text-sm">{t('detail.loading')}</p>;
  }

  const lowConfidence =
    bundle.model_confidence !== null && bundle.model_confidence < 0.75;

  function decide(kind: 'approved' | 'adjusted' | 'rejected') {
    setError(null);
    if (kind === 'adjusted' && adjustedScore === null) {
      setError(t('detail.adjust_requires_score'));
      return;
    }
    setPending(kind);
    mutate.mutate({
      decision: kind,
      final_score: kind === 'adjusted' ? adjustedScore ?? undefined : undefined,
      reason_code: kind !== 'approved' ? reason : undefined,
      notes: notes || undefined,
    });
  }

  function escalate() {
    setError(null);
    setPending('escalated');
    api
      .post(
        `/sessions/${sessionId}/validate/escalate`,
        { notes: notes || t('detail.escalate_default_note') },
        token,
      )
      .then(() => {
        drafts.clearDraft(sessionId);
        queryClient.invalidateQueries({ queryKey: ['pending'] });
        navigate('/validations');
      })
      .catch((err: ApiException) => {
        setError(err.message);
        setPending(null);
      });
  }

  /**
   * Staff override — grant the reward regardless of what the vision
   * model saw. Implemented on top of the existing "adjusted" decision
   * with `final_score = 1.0`, which clears any reasonable reward-rule
   * threshold (§8 rule 1 caps it at 0.95). Reason falls back to
   * `other` since the reason-code set doesn't include a bespoke
   * "manual grant" entry; the staff note carries the intent.
   */
  function grantReward() {
    setError(null);
    setPending('grant');
    const grantNotes = notes
      ? `${t('detail.grant_reward_note')} · ${notes}`
      : t('detail.grant_reward_note');
    mutate.mutate({
      decision: 'adjusted',
      final_score: 1.0,
      reason_code: 'other',
      notes: grantNotes,
    });
  }

  const busy = mutate.isPending || pending !== null;

  return (
    <section className="flex flex-col gap-5 pb-32">
      {/* top breadcrumb / context strip */}
      <header className="flex flex-col gap-3">
        <Link
          to="/validations"
          className="row gap-1.5 items-center text-[13px] font-semibold text-s-muted hover:text-s-ink w-fit"
        >
          <ArrowLeft size={14} />
          <span>{t('app.nav.validations')}</span>
        </Link>
        <div className="row gap-3 items-center flex-wrap">
          <h1 className="display text-[28px] text-s-ink leading-tight">
            {t('queue.table', { code: bundle.table_code })}
          </h1>
          <span className="chip chip-info">
            {t('detail.model_score', { percent: Math.round(bundle.score * 100) })}
          </span>
          {bundle.suspicious && (
            <span className="chip chip-danger">
              <ShieldAlert size={11} />
              {t('detail.possible_tampering')}
            </span>
          )}
          {lowConfidence && (
            <span className="chip chip-amber">
              <HelpCircle size={11} />
              {t('detail.low_confidence')}
            </span>
          )}
        </div>
      </header>

      {/* compare slider */}
      <CompareSlider
        beforeUrl={bundle.before_image_url}
        afterUrl={bundle.after_image_url}
        beforeLabel={t('detail.before')}
        afterLabel={t('detail.after')}
      />

      {/* meta panel: items + signals */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded-lg bg-s-paper border border-s-line p-4 flex flex-col gap-2">
          <div className="row gap-2 items-center">
            <ClipboardList size={14} className="text-s-muted" />
            <span className="font-semibold text-[12px] text-s-muted dev uppercase tracking-wide">
              {t('detail.ordered_items')}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {bundle.ordered_items.map((i, idx) => (
              <li
                key={idx}
                className="row gap-2 items-baseline text-[14px] text-s-ink"
              >
                <span className="tnum font-bold w-6 text-right">{i.quantity}×</span>
                <span className="flex-1">{i.name}</span>
                <span className="chip chip-muted">
                  {i.portion_size ?? t('detail.portion_fallback')}
                </span>
              </li>
            ))}
          </ul>
          {bundle.model_notes && (
            <p className="text-[12px] text-s-muted leading-snug mt-1">
              {t('detail.model_notes', { notes: bundle.model_notes })}
            </p>
          )}
        </section>

        <section className="rounded-lg bg-s-paper border border-s-line p-4 flex flex-col gap-2">
          <div className="row gap-2 items-center">
            <AlertTriangle
              size={14}
              className={
                bundle.fraud_signals.length > 0 ? 'text-amber-deep' : 'text-s-muted'
              }
            />
            <span className="font-semibold text-[12px] text-s-muted dev uppercase tracking-wide">
              {t('detail.fraud_signals')}
            </span>
          </div>
          {bundle.fraud_signals.length === 0 ? (
            <p className="text-[13px] text-s-muted">{t('detail.no_signals')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {bundle.fraud_signals.map((f, idx) => (
                <li
                  key={idx}
                  className="row gap-2 items-baseline text-[13px]"
                >
                  <span className="flex-1 text-s-ink">{f.signal_type}</span>
                  <span
                    className={clsx(
                      'chip',
                      f.severity === 'high'
                        ? 'chip-danger'
                        : f.severity === 'medium'
                          ? 'chip-amber'
                          : 'chip-muted',
                    )}
                  >
                    {f.severity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* decision form */}
      <section className="rounded-lg bg-s-paper border border-s-line p-4 flex flex-col gap-4">
        <div className="row gap-2 items-center">
          <StickyNote size={14} className="text-s-muted" />
          <span className="font-semibold text-[12px] text-s-muted dev uppercase tracking-wide">
            {t('detail.decision_form')}
          </span>
        </div>

        {/* reason picker */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[12.5px] font-semibold text-s-ink">
            {t('detail.reason_label')}
          </label>
          <div className="flex flex-wrap gap-1.5">
            {REASON_CODES.map((c) => {
              const active = reason === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setReason(c)}
                  className={clsx(
                    'chip transition cursor-pointer',
                    active
                      ? 'bg-brand text-white'
                      : 'bg-s-bg border border-s-line text-s-muted hover:text-s-ink',
                  )}
                  aria-pressed={active}
                >
                  {t(`reason_code.${c}`)}
                </button>
              );
            })}
          </div>
        </div>

        {/* adjusted score slider */}
        <div className="flex flex-col gap-1.5">
          <div className="row spread items-baseline">
            <label className="row gap-1.5 items-center text-[12.5px] font-semibold text-s-ink">
              <Sliders size={12} />
              {t('detail.adjusted_score_label')}
            </label>
            <span
              className={clsx(
                'tnum font-bold text-[18px]',
                adjustedScore === null ? 'text-s-muted/60' : 'text-s-ink',
              )}
            >
              {adjustedScore === null
                ? '—'
                : `${Math.round(adjustedScore * 100)}%`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={adjustedScore === null ? Math.round(bundle.score * 100) : Math.round(adjustedScore * 100)}
            onChange={(e) => setAdjustedScore(Number(e.target.value) / 100)}
            className="w-full accent-brand"
            aria-label={t('detail.adjusted_score_label')}
          />
          <div className="row spread text-[11px] text-s-muted">
            <span>{t('detail.score_low')}</span>
            <span className="dev">
              {t('detail.model_score', { percent: Math.round(bundle.score * 100) })}
            </span>
            <span>{t('detail.score_high')}</span>
          </div>
        </div>

        {/* notes */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[12.5px] font-semibold text-s-ink">
            {t('detail.notes_label')}
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="rounded-md border border-s-line bg-s-bg/50 px-3 py-2 text-[14px] text-s-ink focus:bg-white focus:border-brand focus:outline-none transition"
          />
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
      </section>

      {/* Ancillary action — sending the bill isn't the primary
          decision, so it sits between the decision form and the
          sticky action bar as a small text link. Opens the same
          BillSendModal component the Orders board uses. */}
      <div className="row spread items-center bg-s-paper border border-s-line rounded-lg px-4 py-3">
        <div>
          <div className="font-semibold text-[13px] text-s-ink">
            {t('detail.send_bill_title')}
          </div>
          <div className="text-[12px] text-s-muted mt-0.5">
            {t('detail.send_bill_blurb')}
          </div>
        </div>
        <button
          onClick={() => setBillModalOpen(true)}
          className="btn btn-outline min-h-[36px] text-[13px] px-3"
        >
          <Receipt size={14} />
          {t('detail.send_bill_button')}
        </button>
      </div>

      {billModalOpen && (
        <BillSendModal
          sessionId={sessionId}
          tableCode={bundle.table_code}
          onClose={() => setBillModalOpen(false)}
        />
      )}

      {/* sticky action bar */}
      <div className="fixed bottom-0 left-[228px] right-0 z-30 px-6 py-3 bg-s-paper/95 backdrop-blur border-t border-s-line">
        <div className="max-w-screen-xl mx-auto grid grid-cols-2 lg:grid-cols-5 gap-2">
          <DecisionButton
            tone="brand"
            icon={<Check size={16} />}
            label={t('detail.approve')}
            loading={pending === 'approved'}
            disabled={busy}
            onClick={() => decide('approved')}
          />
          {/* Manual override — grants a reward regardless of vision score. */}
          <DecisionButton
            tone="sage"
            icon={<Gift size={16} />}
            label={t('detail.grant_reward')}
            loading={pending === 'grant'}
            disabled={busy}
            onClick={grantReward}
          />
          <DecisionButton
            tone="saffron"
            icon={<Sliders size={16} />}
            label={t('detail.adjust')}
            loading={pending === 'adjusted'}
            disabled={busy}
            onClick={() => decide('adjusted')}
          />
          <DecisionButton
            tone="danger"
            icon={<X size={16} />}
            label={t('detail.reject')}
            loading={pending === 'rejected'}
            disabled={busy}
            onClick={() => decide('rejected')}
          />
          <DecisionButton
            tone="amber"
            icon={<Flag size={16} />}
            label={t('detail.escalate')}
            loading={pending === 'escalated'}
            disabled={busy}
            onClick={escalate}
          />
        </div>
      </div>
    </section>
  );
}

/* ----- compare slider ---------------------------------------------- */

interface CompareSliderProps {
  beforeUrl: string;
  afterUrl: string;
  beforeLabel: string;
  afterLabel: string;
}

function CompareSlider({
  beforeUrl,
  afterUrl,
  beforeLabel,
  afterLabel,
}: CompareSliderProps) {
  const [pct, setPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  function dragTo(clientX: number) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPct(Math.max(0, Math.min(100, next)));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragTo(e.clientX);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons === 1) dragTo(e.clientX);
  }

  return (
    <div
      ref={containerRef}
      className="relative rounded-lg overflow-hidden bg-black select-none touch-none"
      style={{ aspectRatio: '16 / 9' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
    >
      {/* base layer — before */}
      <img
        src={beforeUrl}
        alt="before"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />
      {/* reveal layer — after, clipped from the left */}
      <img
        src={afterUrl}
        alt="after"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        style={{ clipPath: `inset(0 0 0 ${pct}%)` }}
      />
      {/* labels */}
      <span className="absolute top-2.5 left-2.5 chip bg-black/55 text-white border border-white/15 backdrop-blur">
        {beforeLabel}
      </span>
      <span className="absolute top-2.5 right-2.5 chip bg-black/55 text-white border border-white/15 backdrop-blur">
        {afterLabel}
      </span>
      {/* divider line */}
      <div
        className="absolute top-0 bottom-0 w-[3px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.18)] pointer-events-none"
        style={{ left: `calc(${pct}% - 1.5px)` }}
      />
      {/* drag handle */}
      <div
        className="absolute w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center pointer-events-none"
        style={{
          left: `calc(${pct}% - 20px)`,
          top: 'calc(50% - 20px)',
        }}
      >
        <GripVertical size={18} className="text-s-ink" />
      </div>
    </div>
  );
}

/* ----- decision button -------------------------------------------- */

interface DecisionButtonProps {
  tone: 'brand' | 'sage' | 'saffron' | 'danger' | 'amber';
  icon: ReactNode;
  label: string;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}

function DecisionButton({
  tone,
  icon,
  label,
  loading,
  disabled,
  onClick,
}: DecisionButtonProps) {
  const cls =
    tone === 'brand'
      ? 'bg-brand text-white hover:bg-brand-press'
      : tone === 'sage'
        ? 'bg-sage-wash text-sage border border-sage/30 hover:bg-sage hover:text-white'
        : tone === 'saffron'
          ? 'bg-saffron text-[#3a2410] hover:bg-saffron-deep hover:text-white'
          : tone === 'danger'
            ? 'bg-danger-wash text-danger border border-danger/30 hover:bg-danger hover:text-white'
            : 'bg-amber-wash text-amber-deep border border-amber/30 hover:bg-amber hover:text-white';
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'btn btn-block min-h-[48px] text-[15px] font-semibold transition disabled:opacity-50',
        cls,
      )}
    >
      {icon}
      {loading ? '…' : label}
    </button>
  );
}
