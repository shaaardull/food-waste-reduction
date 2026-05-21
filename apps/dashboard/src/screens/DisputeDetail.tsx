import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { api, ApiException } from '../lib/api';
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

  if (isLoading || !data) return <p className="text-slate-600">{t('disputes.loading')}</p>;
  const { dispute, session, diner, resolver, score, staff_validation, captures } = data;
  const isOpen = dispute.status === 'open';

  return (
    <section className="space-y-4">
      <Link to="/disputes" className="text-sm text-brand-700 hover:underline">
        {t('disputes.detail.back_to_list')}
      </Link>
      <h1 className="text-xl font-semibold">
        {t('disputes.detail.title', { code: session.table_code })}
      </h1>

      {!isOpen && (
        <div className="rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-sm p-3">
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
            <div className="mt-2 text-xs text-slate-700">
              {t('disputes.detail.resolved_notes_prefix')} {dispute.resolution_notes}
            </div>
          )}
          {resolver && (
            <div className="mt-1 text-xs text-slate-500">
              {resolver.display_name ?? resolver.email}
            </div>
          )}
        </div>
      )}

      <section className="rounded-lg bg-white border border-slate-200 p-3 space-y-3 text-sm">
        <div>
          <p className="text-slate-500 text-xs">{t('disputes.detail.reason_label')}</p>
          <p>{dispute.reason}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-slate-500">{t('disputes.detail.session_state_label')}</p>
            <p>{session.status}</p>
          </div>
          {diner && (
            <div>
              <p className="text-slate-500">Diner</p>
              <p>{diner.display_name ?? diner.email}</p>
            </div>
          )}
        </div>

        <div>
          <p className="text-slate-500 text-xs mb-1">{t('disputes.detail.captures_label')}</p>
          {captures.before || captures.after ? (
            <div className="grid grid-cols-2 gap-2">
              {captures.before && (
                <figure className="space-y-1">
                  <img src={captures.before} alt="before" className="w-full rounded" />
                  <figcaption className="text-xs text-slate-500">
                    {t('disputes.detail.phase_before')}
                  </figcaption>
                </figure>
              )}
              {captures.after && (
                <figure className="space-y-1">
                  <img src={captures.after} alt="after" className="w-full rounded" />
                  <figcaption className="text-xs text-slate-500">
                    {t('disputes.detail.phase_after')}
                  </figcaption>
                </figure>
              )}
            </div>
          ) : (
            <p className="text-xs text-slate-500">{t('disputes.detail.no_captures')}</p>
          )}
        </div>

        <div>
          <p className="text-slate-500 text-xs">{t('disputes.detail.score_label')}</p>
          {score ? (
            <p>
              {Math.round(score.overall_score * 100)}%{' '}
              <span className="text-xs text-slate-500">({score.model_name})</span>
              {score.suspicious && (
                <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
                  suspicious
                </span>
              )}
            </p>
          ) : (
            <p className="text-xs text-slate-500">{t('disputes.detail.no_score')}</p>
          )}
        </div>

        <div>
          <p className="text-slate-500 text-xs">{t('disputes.detail.validation_label')}</p>
          {staff_validation ? (
            <p className="text-sm">
              <strong>{staff_validation.decision}</strong>
              {staff_validation.reason_code ? ` · ${staff_validation.reason_code}` : ''} ·{' '}
              {Math.round(staff_validation.final_score * 100)}%
              <span className="ml-2 text-xs text-slate-500">
                {t('disputes.detail.decision_at', {
                  datetime: new Date(staff_validation.decided_at).toLocaleString(),
                })}
              </span>
            </p>
          ) : (
            <p className="text-xs text-slate-500">{t('disputes.detail.no_validation')}</p>
          )}
        </div>
      </section>

      {isOpen && (
        <section className="rounded-lg bg-white border border-slate-200 p-3 space-y-3">
          <p className="text-sm font-medium">{t('disputes.detail.resolution_heading')}</p>
          <label className="block text-sm">
            <span className="text-slate-600">{t('disputes.detail.resolution_notes_label')}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => resolve.mutate('resolved_in_favor_diner')}
              disabled={resolve.isPending}
              className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 text-sm"
            >
              {resolve.isPending
                ? t('disputes.detail.resolving')
                : t('disputes.detail.resolve_in_favor_diner')}
            </button>
            <button
              onClick={() => resolve.mutate('resolved_in_favor_restaurant')}
              disabled={resolve.isPending}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm"
            >
              {t('disputes.detail.resolve_in_favor_restaurant')}
            </button>
            <button
              onClick={() => resolve.mutate('closed')}
              disabled={resolve.isPending}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm"
            >
              {t('disputes.detail.resolve_closed')}
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
