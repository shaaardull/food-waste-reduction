import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

interface Bundle {
  session_id: string;
  table_code: string;
  score: number;
  before_image_url: string;
  after_image_url: string;
  ordered_items: Array<{ name: string; quantity: number; portion_size: string | null; notes: string | null }>;
  model_notes: string | null;
  model_confidence: number | null;
  suspicious: boolean;
  fraud_signals: Array<{ signal_type: string; severity: string; details: Record<string, unknown> }>;
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

export function ValidationDetail() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);

  const [adjustedScore, setAdjustedScore] = useState<number | null>(null);
  const [reason, setReason] = useState<string>('plate_not_clean_enough');
  const [notes, setNotes] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const { data: bundle, isLoading } = useQuery({
    queryKey: ['bundle', sessionId],
    queryFn: () => api.get<Bundle>(`/sessions/${sessionId}/validation-bundle`, token),
  });

  const mutate = useMutation({
    mutationFn: (body: { decision: string; final_score?: number; reason_code?: string; notes?: string }) =>
      api.post(`/sessions/${sessionId}/validate`, body, token),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pending'] });
      navigate('/validations');
    },
    onError: (err: ApiException) => setError(err.message),
  });

  if (isLoading || !bundle) return <p className="text-slate-600">Loading…</p>;

  function decide(kind: 'approved' | 'adjusted' | 'rejected') {
    setError(null);
    if (kind === 'adjusted' && adjustedScore === null) {
      setError('Pick a score before submitting an adjustment.');
      return;
    }
    mutate.mutate({
      decision: kind,
      final_score: kind === 'adjusted' ? adjustedScore ?? undefined : undefined,
      reason_code: kind !== 'approved' ? reason : undefined,
      notes: notes || undefined,
    });
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Table {bundle.table_code}</h1>
        <span className="text-sm bg-slate-100 px-2 py-0.5 rounded">
          model score {Math.round(bundle.score * 100)}%
        </span>
        {bundle.suspicious && (
          <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded">
            possible tampering
          </span>
        )}
        {bundle.model_confidence !== null && bundle.model_confidence < 0.75 && (
          <span className="text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
            low confidence
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <figure className="space-y-1">
          <img src={bundle.before_image_url} alt="before" className="w-full rounded-lg" />
          <figcaption className="text-xs text-slate-500">Before</figcaption>
        </figure>
        <figure className="space-y-1">
          <img src={bundle.after_image_url} alt="after" className="w-full rounded-lg" />
          <figcaption className="text-xs text-slate-500">After</figcaption>
        </figure>
      </div>

      <section className="rounded-lg bg-white border border-slate-200 p-3 space-y-2">
        <p className="text-sm font-medium">Ordered items</p>
        <ul className="text-sm text-slate-600 list-disc pl-5">
          {bundle.ordered_items.map((i, idx) => (
            <li key={idx}>
              {i.quantity}× {i.name}{' '}
              <span className="text-xs text-slate-500">
                ({i.portion_size ?? 'regular'})
              </span>
              {i.notes ? ` — ${i.notes}` : ''}
            </li>
          ))}
        </ul>
        {bundle.model_notes && (
          <p className="text-xs text-slate-500">Model notes: {bundle.model_notes}</p>
        )}
        {bundle.fraud_signals.length > 0 && (
          <div className="text-xs text-amber-700 space-y-1">
            <p className="font-medium">Fraud signals</p>
            <ul className="list-disc pl-5">
              {bundle.fraud_signals.map((f, idx) => (
                <li key={idx}>
                  {f.signal_type} ({f.severity})
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="rounded-lg bg-white border border-slate-200 p-3 space-y-3">
        <label className="block text-sm">
          <span className="text-slate-600">Reason (for adjust / reject)</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          >
            {REASON_CODES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">Adjusted score (only if adjusting)</span>
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={adjustedScore ?? ''}
            onChange={(e) => setAdjustedScore(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
            placeholder="0.0–1.0"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2"
          />
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => decide('approved')}
            disabled={mutate.isPending}
            className="rounded-md bg-brand-600 hover:bg-brand-700 text-white px-4 py-2"
          >
            Approve
          </button>
          <button
            onClick={() => decide('adjusted')}
            disabled={mutate.isPending}
            className="rounded-md border border-slate-300 px-4 py-2"
          >
            Adjust
          </button>
          <button
            onClick={() => decide('rejected')}
            disabled={mutate.isPending}
            className="rounded-md border border-red-300 text-red-700 px-4 py-2"
          >
            Reject
          </button>
          <button
            onClick={() =>
              api
                .post(`/sessions/${sessionId}/validate/escalate`, { notes: notes || 'unsure' }, token)
                .then(() => navigate('/validations'))
                .catch((err: ApiException) => setError(err.message))
            }
            disabled={mutate.isPending}
            className="rounded-md border border-amber-300 text-amber-800 px-4 py-2"
          >
            Escalate
          </button>
        </div>
      </section>
    </section>
  );
}
