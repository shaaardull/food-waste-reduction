import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bug, Check, AlertTriangle, Circle } from 'lucide-react';
import { clsx } from 'clsx';
import { api, ApiException } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * BugReport — the staff-facing intake form for issues + a live list
 * of the staff's own past reports so they can see triage state.
 *
 * The form is deliberately small: title, description, severity. No
 * screenshot upload in v1 (that's real infra — S3 presigned URLs,
 * MIME sniffing) and no category picker. Free-text description
 * covers the whole surface area at pilot scale.
 */

type Severity = 'low' | 'medium' | 'high' | 'critical';
type Status = 'open' | 'triaging' | 'in_progress' | 'resolved' | 'wont_fix';

interface BugReportRow {
  id: string;
  restaurant_id: string | null;
  restaurant_name: string | null;
  reported_by_user_id: string;
  reported_by_email: string | null;
  reported_by_display_name: string | null;
  title: string;
  description: string;
  severity: Severity;
  status: Status;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

export function BugReport() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { token, restaurantId } = useAuthStore();
  const qc = useQueryClient();

  useEffect(() => {
    if (!token) navigate('/login');
  }, [token, navigate]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [error, setError] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.post<BugReportRow>(
        '/bug-reports',
        {
          title: title.trim(),
          description: description.trim(),
          severity,
          restaurant_id: restaurantId,
        },
        token,
      ),
    onSuccess: (row) => {
      setSavedTitle(row.title);
      setTitle('');
      setDescription('');
      setSeverity('medium');
      void qc.invalidateQueries({ queryKey: ['bug-reports', 'mine'] });
      setTimeout(() => setSavedTitle(null), 4_000);
    },
    onError: (err: ApiException) => {
      setError(err.message ?? t('bug_report.err_generic'));
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (title.trim().length < 4 || description.trim().length < 8) {
      setError(t('bug_report.err_too_short'));
      return;
    }
    submit.mutate();
  }

  const { data: mine } = useQuery<BugReportRow[]>({
    queryKey: ['bug-reports', 'mine'],
    queryFn: () => api.get<BugReportRow[]>('/bug-reports/mine', token),
    enabled: Boolean(token),
    refetchInterval: 30_000,
  });

  return (
    <section className="flex flex-col gap-5 max-w-[720px]">
      <header>
        <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide row gap-1.5 items-center">
          <Bug size={12} />
          {t('app.nav.report_bug')}
        </div>
        <h1 className="display text-[28px] text-s-ink leading-tight">
          {t('bug_report.title')}
        </h1>
        <p className="text-[13px] text-s-muted mt-1 max-w-[54ch]">
          {t('bug_report.blurb')}
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-s-line bg-s-paper p-5 flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('bug_report.field_title')}
          </span>
          <input
            required
            type="text"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('bug_report.title_placeholder')}
            className="input mt-0"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('bug_report.field_description')}
          </span>
          <textarea
            required
            rows={6}
            maxLength={8000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('bug_report.description_placeholder')}
            className="input mt-0 resize-y"
          />
          <span className="text-[11.5px] text-s-muted">
            {t('bug_report.description_hint')}
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold text-s-ink">
            {t('bug_report.field_severity')}
          </span>
          <div className="row gap-1.5 flex-wrap">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeverity(s)}
                className={clsx(
                  'chip transition capitalize',
                  severity === s
                    ? severityChipClass(s, true)
                    : 'chip-muted hover:bg-s-bg',
                )}
              >
                {t(`bug_report.severity_${s}`)}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        {savedTitle && (
          <p className="row gap-2 items-center text-sm text-sage font-semibold bg-sage-wash/60 border border-sage/20 rounded-md px-3 py-2">
            <Check size={14} />
            {t('bug_report.saved', { title: savedTitle })}
          </p>
        )}

        <div className="row gap-2 pt-1">
          <button
            type="submit"
            disabled={submit.isPending}
            className="btn btn-primary min-h-[42px] text-[14px] px-6 disabled:opacity-55"
          >
            {submit.isPending
              ? t('bug_report.sending')
              : t('bug_report.submit')}
          </button>
        </div>
      </form>

      {/* Own reports list — read-only. Cards mirror the shape used
          in the platform-owner triage view, sans the edit affordances. */}
      {mine && mine.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="display text-[18px] text-s-ink">
            {t('bug_report.mine_heading')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mine.map((row) => (
              <MyBugCard key={row.id} row={row} t={t} />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function severityChipClass(s: Severity, active: boolean): string {
  if (!active) return 'chip-muted';
  switch (s) {
    case 'low':
      return 'chip-sage';
    case 'medium':
      return 'chip-info';
    case 'high':
      return 'chip-amber';
    case 'critical':
      return 'chip-danger';
  }
}

function statusChipClass(s: Status): string {
  switch (s) {
    case 'open':
      return 'chip-amber';
    case 'triaging':
      return 'chip-info';
    case 'in_progress':
      return 'chip-brand';
    case 'resolved':
      return 'chip-sage';
    case 'wont_fix':
      return 'chip-muted';
  }
}

function MyBugCard({
  row,
  t,
}: {
  row: BugReportRow;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const created = new Date(row.created_at).toLocaleDateString();
  return (
    <article className="rounded-lg border border-s-line bg-s-paper p-3 flex flex-col gap-2">
      <div className="row spread items-start gap-2">
        <div className="font-bold text-[14px] text-s-ink line-clamp-2">
          {row.title}
        </div>
        <div className="row gap-1 flex-shrink-0">
          <span className={clsx('chip', severityChipClass(row.severity, true))}>
            {row.severity === 'critical' ? (
              <AlertTriangle size={10} />
            ) : (
              <Circle size={10} />
            )}
            {t(`bug_report.severity_${row.severity}`)}
          </span>
        </div>
      </div>
      <p className="text-[12.5px] text-s-muted line-clamp-3 leading-snug">
        {row.description}
      </p>
      <div className="row spread items-center pt-1 border-t border-s-line/60">
        <span className={clsx('chip', statusChipClass(row.status))}>
          {t(`bug_report.status_${row.status}`)}
        </span>
        <span className="text-[11.5px] text-s-muted">{created}</span>
      </div>
      {row.admin_notes && (
        <div className="text-[12px] text-s-ink bg-s-bg rounded-md px-2.5 py-1.5 border border-s-line/60">
          <span className="font-semibold not-italic">
            {t('bug_report.admin_note_label')}:
          </span>{' '}
          {row.admin_notes}
        </div>
      )}
    </article>
  );
}
