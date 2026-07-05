import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Camera, X, Check } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '../lib/api';
import type { ApiException } from '../lib/api';

/**
 * ScanMenuModal — reusable "photo → Claude → review grid → confirm"
 * flow. Used both by the standalone Menu screen and by the AdminOnboard
 * wizard's menu step.
 *
 * Deliberately does NOT persist. On confirm it hands the reviewed rows
 * back to the parent, which decides whether to:
 *   • hit `POST /menu-items` (Menu screen — persist to the live menu)
 *   • merge into the wizard's local `items` state (AdminOnboard — the
 *     wizard's own Save button handles persistence later)
 */

export type ScannedCategory =
  | 'starter'
  | 'main'
  | 'side'
  | 'bread'
  | 'drink'
  | 'dessert';

export interface ScannedItem {
  name: string;
  price_minor: number;
  category: ScannedCategory | null;
  confidence: number;
}

interface ExtractedItem {
  name: string;
  description: string | null;
  price_minor: number;
  category: string | null;
  confidence: number;
}

interface ExtractionResponse {
  extraction_id: string;
  items: ExtractedItem[];
  detected_currency: string;
  confidence: number;
  notes: string | null;
  processing_ms: number;
  model_name: string;
  model_version: string;
}

const CATEGORIES: ScannedCategory[] = [
  'starter',
  'main',
  'side',
  'bread',
  'drink',
  'dessert',
];

interface ScanReviewRow {
  proposed: ExtractedItem;
  include: boolean;
  editedName: string;
  editedPriceRupees: string;
  editedCategory: ScannedCategory | '';
}

interface Props {
  restaurantId: string;
  token: string | null;
  onClose: () => void;
  /**
   * Fired when the staff clicks Confirm on the review grid. Receives
   * only the rows they left checked, with any inline edits applied.
   * Parent is responsible for persistence.
   */
  onConfirmed: (items: ScannedItem[], extractionId: string) => Promise<void> | void;
}

export function ScanMenuModal({ restaurantId, token, onClose, onConfirmed }: Props) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'upload' | 'extracting' | 'review'>('upload');
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [rows, setRows] = useState<ScanReviewRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setStep('extracting');
    try {
      const form = new FormData();
      form.append('image', file, file.name);
      const res = await api.post<ExtractionResponse>(
        `/restaurants/${restaurantId}/menu-items/extract`,
        form,
        token,
      );
      setExtractionId(res.extraction_id);
      const initial: ScanReviewRow[] = res.items.map((it) => ({
        proposed: it,
        include: it.confidence >= 0.75,
        editedName: it.name,
        editedPriceRupees: String(Math.round(it.price_minor / 100)),
        editedCategory: (it.category as ScannedCategory) ?? '',
      }));
      setRows(initial);
      setStep('review');
    } catch (err) {
      const apiErr = err as ApiException;
      setError(apiErr?.message ?? t('menu_editor.scan_generic_error'));
      setStep('upload');
    }
  }

  async function confirm() {
    setError(null);
    setConfirming(true);
    try {
      const picks: ScannedItem[] = rows
        .filter((r) => r.include)
        .map((r) => ({
          name: r.editedName.trim().slice(0, 120),
          price_minor: Math.max(0, Math.round(Number(r.editedPriceRupees) * 100) || 0),
          category: (r.editedCategory || null) as ScannedCategory | null,
          confidence: r.proposed.confidence,
        }));
      await onConfirmed(picks, extractionId ?? '');
    } catch (err) {
      const apiErr = err as ApiException;
      setError(apiErr?.message ?? t('menu_editor.scan_generic_error'));
    } finally {
      setConfirming(false);
    }
  }

  const selectedCount = rows.filter((r) => r.include).length;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-[720px] max-h-[90vh] bg-s-paper border border-s-line rounded-lg flex flex-col shadow-pop overflow-hidden">
        <div className="px-5 py-4 border-b border-s-line row spread items-start">
          <div>
            <div className="text-[12px] font-semibold text-s-muted dev uppercase tracking-wide">
              {t('app.nav.menu')}
            </div>
            <h2 className="display text-[22px] text-s-ink leading-tight">
              {t('menu_editor.scan_title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label={t('menu_editor.cancel')}
            className="w-8 h-8 rounded-md hover:bg-s-bg flex items-center justify-center text-s-muted"
          >
            <X size={16} />
          </button>
        </div>

        {step === 'upload' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 py-10 px-6">
            <div className="w-16 h-16 rounded-md bg-brand-wash text-brand flex items-center justify-center">
              <Camera size={28} />
            </div>
            <p className="text-[14px] text-s-muted text-center max-w-[36ch]">
              {t('admin.menu.scan_hint')}
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png"
              capture="environment"
              onChange={onFile}
              className="hidden"
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="btn btn-primary min-h-[48px] px-5 text-[15px]"
            >
              <Camera size={18} />
              {t('menu_editor.scan_step_upload')}
            </button>
            {error && (
              <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mt-2">
                {error}
              </p>
            )}
          </div>
        )}

        {step === 'extracting' && (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16">
            <div className="w-12 h-12 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            <p className="text-[14px] text-s-muted">
              {t('menu_editor.scan_step_extracting')}
            </p>
          </div>
        )}

        {step === 'review' && (
          <>
            <div className="px-5 py-3 border-b border-s-line">
              <div className="font-semibold text-[14px] text-s-ink">
                {t('menu_editor.scan_step_review')}
              </div>
              <div className="text-[12.5px] text-s-muted mt-0.5">
                {t('menu_editor.scan_step_review_hint')}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {rows.length === 0 && (
                <p className="text-s-muted text-sm px-5 py-8 text-center">
                  {t('menu_editor.scan_confirm_zero')}
                </p>
              )}
              {rows.map((r, i) => (
                <ReviewRow
                  key={i}
                  row={r}
                  onToggle={() =>
                    setRows((prev) =>
                      prev.map((x, j) =>
                        j === i ? { ...x, include: !x.include } : x,
                      ),
                    )
                  }
                  onChange={(patch) =>
                    setRows((prev) =>
                      prev.map((x, j) => (j === i ? { ...x, ...patch } : x)),
                    )
                  }
                />
              ))}
            </div>
            {error && (
              <p className="mx-5 my-2 text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2">
                {error}
              </p>
            )}
            <div className="px-5 py-3 border-t border-s-line row gap-2 bg-s-paper">
              <button
                onClick={onClose}
                className="btn btn-outline flex-1 min-h-[44px] text-[14px]"
              >
                {t('menu_editor.cancel')}
              </button>
              <button
                onClick={confirm}
                disabled={selectedCount === 0 || confirming}
                className="btn btn-primary flex-1 min-h-[44px] text-[14px] disabled:opacity-50"
              >
                <Check size={16} />
                {selectedCount === 0
                  ? t('menu_editor.scan_confirm_zero')
                  : t('menu_editor.scan_confirm_n', { count: selectedCount })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ReviewRow({
  row,
  onToggle,
  onChange,
}: {
  row: ScanReviewRow;
  onToggle: () => void;
  onChange: (patch: Partial<ScanReviewRow>) => void;
}) {
  const { t } = useTranslation();
  const conf = row.proposed.confidence;
  const tone = conf >= 0.85 ? 'sage' : conf >= 0.5 ? 'amber' : 'danger';
  const chipLabel =
    conf >= 0.85
      ? t('menu_editor.scan_confidence_high')
      : conf >= 0.5
        ? t('menu_editor.scan_confidence_medium')
        : t('menu_editor.scan_confidence_low');
  return (
    <div className="px-5 py-3 border-b border-s-line row gap-3 items-start">
      <input
        type="checkbox"
        checked={row.include}
        onChange={onToggle}
        className="mt-1 accent-brand"
      />
      <div className="flex-1 flex flex-col gap-2 min-w-0">
        <div className="row gap-2 items-center">
          <input
            value={row.editedName}
            onChange={(e) => onChange({ editedName: e.target.value })}
            className="flex-1 rounded-md border border-s-line bg-white px-2.5 py-1.5 text-[13.5px] font-semibold text-s-ink focus:border-brand focus:outline-none"
          />
          <span
            className={clsx(
              'chip',
              tone === 'sage' && 'chip-sage',
              tone === 'amber' && 'chip-amber',
              tone === 'danger' && 'chip-danger',
            )}
          >
            {chipLabel}
          </span>
        </div>
        <div className="row gap-2">
          <div className="row gap-1 items-center">
            <span className="text-[12px] text-s-muted">₹</span>
            <input
              value={row.editedPriceRupees}
              onChange={(e) => onChange({ editedPriceRupees: e.target.value })}
              type="number"
              min={0}
              className="w-24 rounded-md border border-s-line bg-white px-2 py-1 text-[13px] tnum text-s-ink focus:border-brand focus:outline-none"
            />
          </div>
          <select
            value={row.editedCategory}
            onChange={(e) =>
              onChange({ editedCategory: e.target.value as ScannedCategory | '' })
            }
            className="rounded-md border border-s-line bg-white px-2 py-1 text-[13px] text-s-ink focus:border-brand focus:outline-none"
          >
            <option value="">—</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`admin.menu.category.${c}`, { defaultValue: c })}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
