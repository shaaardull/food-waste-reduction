import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  MessageSquareWarning,
  ShieldAlert,
  Camera,
  Gauge,
  ClipboardCheck,
  Heart,
  Building2,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

type DisputeStatus =
  | 'open'
  | 'resolved_in_favor_diner'
  | 'resolved_in_favor_restaurant'
  | 'closed';

interface DisputeDetailPayload {
  dispute: {
    id: string;
    status: DisputeStatus;
    reason: string;
    resolution_notes: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by_user_id: string | null;
  };
  session: { id: string; status: string; table_code: string; started_at: string };
  diner: { id: string; email: string; display_name: string | null } | null;
  resolver: { id: string; email: string; display_name: string | null } | null;
  score: {
    overall_score: number;
    model_name: string;
    notes: string | null;
    suspicious: boolean;
  } | null;
  staff_validation: {
    decision: string;
    final_score: number;
    reason_code: string | null;
    notes: string | null;
    decided_at: string;
  } | null;
  captures: { before?: string; after?: string };
}

export function DisputeDetail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id = '' } = useParams();
  const { token, restaurantId } = useAuthStore();
  const [notes, setNotes] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dispute', restaurantId, id],
    queryFn: () =>
      api.get<DisputeDetailPayload>(
        `/restaurants/${restaurantId}/dashboard/disputes/${id}`,
        token,
      ),
    enabled: Boolean(restaurantId && token && id),
  });

  const resolve = useMutation({
    mutationFn: (status: DisputeStatus) =>
      api.post(
        `/restaurants/${restaurantId}/dashboard/disputes/${id}/resolve`,
        { status, resolution_notes: notes || undefined },
        token,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dispute', restaurantId, id] });
      queryClient.invalidateQueries({ queryKey: ['disputes'] });
      navigate('/disputes');
    },
    onError: (err: ApiException) => setError(err.message),
  });

  if (isLoading || !data) {
    return <p className="text-s-muted text-sm">{t('disputes.loading')}</p>;
  }
  const { dispute, session, diner, resolver, score, staff_validation, captures } = data;
  const isOpen = dispute.status === 'open';

  return (
    <section className="flex flex-col gap-4 pb-6">
      <Link
        to="/disputes"
        className="row gap-1.5 items-center text-[13px] font-semibold text-s-muted hover:text-s-ink w-fit"
      >
        <ArrowLeft size={14} />
        <span>{t('disputes.detail.back_to_list')}</span>
      </Link>

      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
          {t('app.nav.disputes')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('disputes.detail.title', { code: session.table_code })}
        </h1>
      </header>

      {!isOpen && (
        <div className="confbanner bg-amber-wash text-amber-deep rounded-md">
          <MessageSquareWarning size={16} />
          <div className="flex-1 min-w-0">
            <Trans
              i18nKey="disputes.detail.already_resolved"
              values={{
                status: t(`disputes.status.${dispute.status}`, {
                  defaultValue: dispute.status,
                }),
                datetime: dispute.resolved_at
                  ? new Date(dispute.resolved_at).toLocaleString()
                  : '',
              }}
              components={{ strong: <strong /> }}
            />
            {dispute.resolution_notes && (
              <div className="text-[12px] mt-1 opacity-80">
                {t('disputes.detail.resolved_notes_prefix')}{' '}
                {dispute.resolution_notes}
              </div>
            )}
            {resolver && (
              <div className="text-[11px] mt-0.5 opacity-70">
                {resolver.display_name ?? resolver.email}
              </div>
            )}
          </div>
        </div>
      )}

      {/* diner reason */}
      <Section
        icon={<MessageSquareWarning size={14} />}
        label={t('disputes.detail.reason_label')}
      >
        <p className="text-[14px] text-s-ink whitespace-pre-line">
          {dispute.reason}
        </p>
        <div className="row gap-3 text-[12px] text-s-muted mt-2">
          <span>
            <span className="dev font-semibold">
              {t('disputes.detail.session_state_label')}:
            </span>{' '}
            {session.status}
          </span>
          {diner && (
            <span>
              <span className="dev font-semibold">Diner:</span>{' '}
              {diner.display_name ?? diner.email}
            </span>
          )}
        </div>
      </Section>

      {/* captures */}
      <Section icon={<Camera size={14} />} label={t('disputes.detail.captures_label')}>
        {captures.before || captures.after ? (
          <div className="grid grid-cols-2 gap-2">
            {captures.before && (
              <figure className="flex flex-col gap-1">
                <img
                  src={captures.before}
                  alt="before"
                  className="w-full rounded border border-s-line"
                />
                <figcaption className="text-[11px] text-s-muted dev uppercase tracking-wide">
                  {t('disputes.detail.phase_before')}
                </figcaption>
              </figure>
            )}
            {captures.after && (
              <figure className="flex flex-col gap-1">
                <img
                  src={captures.after}
                  alt="after"
                  className="w-full rounded border border-s-line"
                />
                <figcaption className="text-[11px] text-s-muted dev uppercase tracking-wide">
                  {t('disputes.detail.phase_after')}
                </figcaption>
              </figure>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-s-muted">
            {t('disputes.detail.no_captures')}
          </p>
        )}
      </Section>

      {/* score + staff validation in a 2-up */}
      <div className="grid md:grid-cols-2 gap-3">
        <Section icon={<Gauge size={14} />} label={t('disputes.detail.score_label')}>
          {score ? (
            <div className="flex flex-col gap-1">
              <div className="row gap-2 items-baseline">
                <span className="tnum font-bold text-[22px] text-s-ink">
                  {Math.round(score.overall_score * 100)}%
                </span>
                {score.suspicious && (
                  <span className="chip chip-danger">
                    <ShieldAlert size={11} />
                    suspicious
                  </span>
                )}
              </div>
              <span className="text-[12px] text-s-muted dev">{score.model_name}</span>
            </div>
          ) : (
            <p className="text-[13px] text-s-muted">{t('disputes.detail.no_score')}</p>
          )}
        </Section>

        <Section
          icon={<ClipboardCheck size={14} />}
          label={t('disputes.detail.validation_label')}
        >
          {staff_validation ? (
            <div className="flex flex-col gap-1">
              <div className="row gap-2 items-baseline">
                <span className="font-bold text-[14px] capitalize text-s-ink">
                  {staff_validation.decision}
                </span>
                <span className="tnum font-bold text-[14px] text-s-ink">
                  {Math.round(staff_validation.final_score * 100)}%
                </span>
              </div>
              {staff_validation.reason_code && (
                <span className="text-[12px] text-s-muted">
                  {staff_validation.reason_code}
                </span>
              )}
              <span className="text-[11px] text-s-muted dev">
                {t('disputes.detail.decision_at', {
                  datetime: new Date(staff_validation.decided_at).toLocaleString(),
                })}
              </span>
            </div>
          ) : (
            <p className="text-[13px] text-s-muted">
              {t('disputes.detail.no_validation')}
            </p>
          )}
        </Section>
      </div>

      {/* resolution form */}
      {isOpen && (
        <Section
          icon={<ClipboardCheck size={14} />}
          label={t('disputes.detail.resolution_heading')}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold text-s-ink">
              {t('disputes.detail.resolution_notes_label')}
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="rounded-md border border-s-line bg-s-bg/50 px-3 py-2 text-[14px] text-s-ink focus:bg-white focus:border-brand focus:outline-none transition"
            />
          </label>
          {error && (
            <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mt-2">
              {error}
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-3">
            <button
              onClick={() => resolve.mutate('resolved_in_favor_diner')}
              disabled={resolve.isPending}
              className={clsx(
                'btn btn-block min-h-[48px] text-[15px] font-semibold',
                'bg-brand text-white hover:bg-brand-press disabled:opacity-50',
              )}
            >
              <Heart size={16} />
              {resolve.isPending
                ? t('disputes.detail.resolving')
                : t('disputes.detail.resolve_in_favor_diner')}
            </button>
            <button
              onClick={() => resolve.mutate('resolved_in_favor_restaurant')}
              disabled={resolve.isPending}
              className={clsx(
                'btn btn-block min-h-[48px] text-[15px] font-semibold',
                'bg-s-paper border border-s-line text-s-ink hover:bg-s-bg disabled:opacity-50',
              )}
            >
              <Building2 size={16} />
              {t('disputes.detail.resolve_in_favor_restaurant')}
            </button>
            <button
              onClick={() => resolve.mutate('closed')}
              disabled={resolve.isPending}
              className={clsx(
                'btn btn-block min-h-[48px] text-[15px] font-semibold',
                'bg-s-paper border border-s-line text-s-muted hover:text-s-ink disabled:opacity-50',
              )}
            >
              <X size={16} />
              {t('disputes.detail.resolve_closed')}
            </button>
          </div>
        </Section>
      )}
    </section>
  );
}

interface SectionProps {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}

function Section({ icon, label, children }: SectionProps) {
  return (
    <section className="bg-s-paper border border-s-line rounded-lg p-4 flex flex-col gap-2">
      <div className="row gap-2 items-center text-s-muted">
        {icon}
        <span className="font-semibold text-[12px] dev uppercase tracking-wide">
          {label}
        </span>
      </div>
      {children}
    </section>
  );
}
