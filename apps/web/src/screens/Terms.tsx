import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import { LangToggle } from '../components/LangToggle';

/**
 * Read-only viewer for a legal document (Diner ToS, Research Consent,
 * Privacy Policy). Fetches the currently effective version's markdown
 * from GET /documents/:type/current and renders it. No auth required.
 *
 * Route: /terms/:docType where docType is a URL-friendly alias mapped
 * to the backend's document_type value. Keeps user-visible URLs short.
 * Any unknown alias renders a plain "unknown document" fallback rather
 * than 500ing.
 */
const ALIAS_TO_BACKEND: Record<string, string> = {
  diner: 'diner_tos',
  research: 'research_consent',
  privacy: 'privacy_policy',
};

interface CurrentDocument {
  document_type: string;
  version: string;
  effective_from: string;
  content_markdown: string;
}

export function Terms() {
  const { docType } = useParams<{ docType: string }>();
  const { t } = useTranslation();
  const backendType = docType ? ALIAS_TO_BACKEND[docType] : undefined;

  const [doc, setDoc] = useState<CurrentDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!backendType) {
      setLoading(false);
      setError('unknown_document');
      return;
    }
    async function load(type: string) {
      try {
        const res = await api.get<CurrentDocument>(
          `/documents/${type}/current`,
        );
        if (!cancelled) setDoc(res);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'fetch_failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load(backendType);
    return () => {
      cancelled = true;
    };
  }, [backendType]);

  return (
    <div className="d-screen min-h-full bg-paper">
      <div className="px-5 pt-4 spread">
        <Link
          to="/"
          className="btn-tertiary !min-h-0 !p-1 inline-flex items-center gap-1.5"
          aria-label="Back"
        >
          <ArrowLeft size={20} />
        </Link>
        <LangToggle />
      </div>

      <div className="max-w-2xl mx-auto px-5 pt-4 pb-16">
        {loading && (
          <p className="text-muted text-sm">{t('terms.loading')}</p>
        )}
        {error && (
          <p className="text-danger text-sm bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
            {error === 'unknown_document'
              ? t('terms.unknown')
              : t('terms.load_error')}
          </p>
        )}
        {doc && (
          <>
            <div className="text-[11px] font-semibold text-muted uppercase tracking-wide mb-2">
              {t('terms.eyebrow_version', { version: doc.version })}
            </div>
            {/* Rendered as pre-wrapped monospace-safe markdown — this
                keeps the page ship-ready without pulling a markdown
                renderer. The source is a curated legal document, not
                arbitrary user content, so no sanitisation is needed. */}
            <article
              className="prose prose-sm max-w-none whitespace-pre-wrap font-sans text-[14.5px] leading-[1.65] text-ink"
              style={{ fontFamily: 'inherit' }}
            >
              {doc.content_markdown}
            </article>
          </>
        )}
      </div>
    </div>
  );
}
