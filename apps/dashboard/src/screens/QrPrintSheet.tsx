import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/auth';

/**
 * QrPrintSheet — the print-optimised page.
 *
 * Renders every ASSIGNED sticker matching the URL filter as a grid of
 * table-tent cards (4 in × 2.5 in landscape) laid out on A4. Layout
 * and typography are pinned by design spec:
 *
 *   Card       4"×2.5"  landscape, cream body, deep-green QR panel
 *   Fonts      Hanken Grotesk (UI), Fraunces italic (name only),
 *              JetBrains Mono (table code / dots / URL)
 *   Icons      inline SVG (leaf, ticket) — NO emoji
 *
 * QR rendering:
 *   The QR image comes from `api.qrserver.com` — a free public
 *   generator. Zero npm deps. If we ever go offline or need to be
 *   GDPR-clean on the URL logging, swap `<img>` for `qrcode.react`
 *   in one place (`qrSrc`).
 *
 * URL filters (either or both):
 *   ?restaurant=<slug>   → all active stickers for this restaurant
 *   ?batch=<label>       → all active stickers in a batch
 *
 * The diner scans the sticker QR which points at:
 *   <VITE_DINER_APP_BASE_URL>/qr/<token>
 * hitting the QrResolve screen and starting a session.
 */

const DINER_BASE =
  import.meta.env.VITE_DINER_APP_BASE_URL ?? 'http://localhost:5173';

// api.qrserver.com renders at whatever pixel size we ask for. 340×340
// covers the 1.16 in on-card render at 300 dpi with a hair of overshoot
// so scaling doesn't visibly antialias the modules. `margin=1` keeps
// the quiet zone tight, `ecc=M` is the standard medium error-correction
// tier — enough for smudged laminate + phone-camera glare.
const QR_SIZE_PX = 340;
function qrSrc(url: string): string {
  const encoded = encodeURIComponent(url);
  return `https://api.qrserver.com/v1/create-qr-code/?data=${encoded}&size=${QR_SIZE_PX}x${QR_SIZE_PX}&margin=1&ecc=M`;
}

interface QRTokenRow {
  id: string;
  token: string;
  batch_label: string | null;
  state: 'unassigned' | 'assigned' | 'retired';
  restaurant_id: string | null;
  restaurant_name: string | null;
  restaurant_slug: string | null;
  table_code: string | null;
  assigned_at: string | null;
  created_at: string;
}

/**
 * Load Fraunces + Hanken Grotesk + JetBrains Mono from Google Fonts.
 * Injected once via `useEffect` so the browser has the faces before it
 * paints any card. If the CDN is blocked, we fall through to the
 * system-serif / system-sans / ui-monospace fallbacks declared inline.
 */
function useGoogleFonts() {
  useEffect(() => {
    const id = 'qr-print-fonts';
    if (document.getElementById(id)) return;
    const preconnect1 = document.createElement('link');
    preconnect1.rel = 'preconnect';
    preconnect1.href = 'https://fonts.googleapis.com';
    const preconnect2 = document.createElement('link');
    preconnect2.rel = 'preconnect';
    preconnect2.href = 'https://fonts.gstatic.com';
    preconnect2.crossOrigin = 'anonymous';
    const stylesheet = document.createElement('link');
    stylesheet.id = id;
    stylesheet.rel = 'stylesheet';
    stylesheet.href =
      'https://fonts.googleapis.com/css2?' +
      'family=Fraunces:ital,wght@1,600&' +
      'family=Hanken+Grotesk:wght@500;700;800&' +
      'family=JetBrains+Mono:wght@700;800&display=swap';
    document.head.append(preconnect1, preconnect2, stylesheet);
  }, []);
}

export function QrPrintSheet() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { token: authToken, user } = useAuthStore();

  useGoogleFonts();

  const batch = params.get('batch') ?? '';
  const restaurantSlug = params.get('restaurant') ?? '';

  const { data, isLoading, error } = useQuery({
    queryKey: ['qr-print', batch, restaurantSlug],
    queryFn: async () => {
      const qs = new URLSearchParams();
      qs.set('state', 'assigned');
      if (batch.trim()) qs.set('batch', batch.trim());
      const rows = await api.get<QRTokenRow[]>(
        `/admin/platform/qr-tokens?${qs.toString()}`,
        authToken,
      );
      // Restaurant filter is client-side — the backend endpoint
      // scopes by batch + state but not restaurant slug. Fine at
      // pilot scale (<1000 stickers per query).
      return restaurantSlug
        ? rows.filter((r) => r.restaurant_slug === restaurantSlug)
        : rows;
    },
    enabled: Boolean(authToken),
  });

  const rows = useMemo(() => data ?? [], [data]);

  if (user?.role !== 'admin') {
    return (
      <p className="text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 max-w-[440px] mx-auto mt-8">
        {t('qr_tokens.admin_only')}
      </p>
    );
  }

  return (
    <div className="qr-print-root">
      <style>{PRINT_CSS}</style>

      {/* Screen-only header. Hidden at print time via .no-print. */}
      <div className="no-print sticky top-0 z-10 bg-brand text-white px-4 py-2.5 shadow-sh-sm row spread items-center">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide opacity-80">
            {t('qr_print.eyebrow')}
          </div>
          <div className="font-semibold text-[14px]">
            {t('qr_print.title', { count: rows.length })}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          disabled={rows.length === 0 || isLoading}
          className="row gap-1.5 items-center bg-white text-brand font-semibold text-[13px] rounded-md px-3.5 py-1.5 hover:bg-white/95 transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Printer size={14} />
          {t('qr_print.print_button')}
        </button>
      </div>

      {/* Always-visible sheet header. Prints too — proves the
          component reached the print engine and helps an operator
          eyeball what's on the sheet before cutting. Also lays out
          diagnostic state ("Loading…", error, or nothing to print)
          so a blank pre-render still shows *something* on paper. */}
      <div className="qr-sheet-header">
        <div className="qr-sheet-header-title">
          {t('qr_print.sheet_header_title')}
        </div>
        <div className="qr-sheet-header-meta">
          {isLoading
            ? t('qr_print.loading')
            : error
              ? (error as Error).message
              : rows.length === 0
                ? t('qr_print.empty_title')
                : t('qr_print.sheet_header_count', { count: rows.length })}
        </div>
      </div>

      {/* Background-graphics reminder — Chrome ships with this OFF
          by default. Without it, coloured panels / pills / chips
          strip to white in the print. `-webkit-print-color-adjust`
          is supposed to override, but Chrome's actual behaviour is
          inconsistent, so we surface the hint out loud. */}
      {!isLoading && rows.length > 0 && (
        <div className="no-print mx-6 my-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 leading-snug">
          <strong>{t('qr_print.print_hint_title')}</strong>{' '}
          {t('qr_print.print_hint_body')}
        </div>
      )}

      {isLoading && (
        <p className="no-print text-s-muted text-[13px] px-6 py-6">
          {t('qr_print.loading')}
        </p>
      )}
      {error && (
        <p className="no-print text-sm text-danger bg-danger-wash border border-danger/20 rounded-md px-3 py-2 mx-6 my-4">
          {(error as Error).message}
        </p>
      )}

      {/* Empty state — visible on BOTH screen and print (no `no-print`
          class). Previously this was hidden from print, so hitting
          Print with zero assigned stickers produced a truly blank
          preview and the operator had no idea why. Now the same
          message appears on the printed page. */}
      {!isLoading && rows.length === 0 && (
        <div className="qr-empty-print">
          <p className="text-[14px] font-semibold text-s-ink">
            {t('qr_print.empty_title')}
          </p>
          <p className="text-[12.5px] text-s-muted mt-1 max-w-[52ch]">
            {t('qr_print.empty')}
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="qr-sheet">
          {rows.map((row) => (
            <QrCard key={row.id} row={row} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Inline leaf glyph for the brand row. Sized to the 16 × 16 badge box
 * so the icon reads at print scale — a lucide-react `<Leaf/>` at the
 * same dimensions renders too thin on paper.
 */
function LeafIcon({ size = 10 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
      <path d="M2 21c0-3 1.85-5.36 5.08-6" />
    </svg>
  );
}

/**
 * Inline ticket glyph for the reward chip — replaces the emoji so
 * cross-platform print doesn't render an OS-specific colour glyph.
 */
function TicketIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
    >
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2" />
      <path d="M13 17v2" />
      <path d="M13 11v2" />
    </svg>
  );
}

function QrCard({
  row,
  t,
}: {
  row: QRTokenRow;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const url = `${DINER_BASE.replace(/\/$/, '')}/qr/${row.token}`;
  // Friendly URL rendered on the card as a branded footer. Decorative
  // only — the QR itself encodes the tokenised deep-link above.
  const friendlyUrl = `plate-clean.app/t/${row.table_code ?? '—'}`;
  return (
    <div className="qr-card">
      {/* ── Left: deep-green QR panel ───────────────────────────── */}
      <div className="qr-card-left">
        {/* Two organic blob decorations offset outside their corners.
            Fill is a low-alpha white so it reads on the gradient
            without introducing extra ink. */}
        <span className="qr-blob qr-blob-a" aria-hidden />
        <span className="qr-blob qr-blob-b" aria-hidden />
        <div className="qr-code-box">
          <img
            src={qrSrc(url)}
            alt={`QR code for table ${row.table_code}`}
            className="qr-card-img"
            loading="eager"
          />
        </div>
        <div className="qr-table-pill">
          {t('qr_print.table_pill', { code: row.table_code ?? '—' })}
        </div>
      </div>

      {/* ── Right: cream info panel ─────────────────────────────── */}
      <div className="qr-card-right">
        <div className="qr-brand-row">
          <span className="qr-brand-badge" aria-hidden>
            <LeafIcon size={10} />
          </span>
          <span className="qr-brand-label">
            {t('qr_print.card_eyebrow')}
          </span>
        </div>
        <div className="qr-card-name">{row.restaurant_name ?? '—'}</div>
        <ol className="qr-card-steps">
          <li>
            <span className="qr-step-num">1</span>
            <span className="qr-step-text">{t('qr_print.step_order')}</span>
          </li>
          <li>
            <span className="qr-step-num">2</span>
            <span
              className="qr-step-text"
              dangerouslySetInnerHTML={{
                __html: t('qr_print.step_photos_rich'),
              }}
            />
          </li>
          <li>
            <span className="qr-step-num">3</span>
            <span
              className="qr-step-text"
              // Rich version carries an explicit <br/> before the
              // reward phrase so it always breaks at the same point
              // regardless of font metric jitter across browsers.
              dangerouslySetInnerHTML={{
                __html: t('qr_print.step_reward_rich'),
              }}
            />
          </li>
        </ol>
        {/* Footer is stacked, not a row — the reward chip and URL
            each need their own line at 500px width to avoid wrap. */}
        <div className="qr-footer">
          <div className="qr-reward-chip">
            <TicketIcon size={10} />
            <span>{t('qr_print.reward_chip')}</span>
          </div>
          <div className="qr-friendly-url">{friendlyUrl}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline print stylesheet — pinned to the design spec:
 *   Card    4"×2.5" landscape, radius 0.16in, cream body
 *   Left    1.72in, diagonal green gradient, two blob decorations
 *   Right   flex, padded 0.19in 0.22in 0.16in
 *
 * All dimensions expressed in inches so the print output matches the
 * spec 1:1 regardless of screen DPI. On A4 (8.27"×11.69") we fit
 * 2 across × 4 down = 8 cards per sheet with a 0.35in page margin.
 */
const PRINT_CSS = `
  .qr-print-root {
    background: hsl(140 20% 96%);
    min-height: 100vh;
  }
  /* Always-visible sheet header — never has no-print, so it's the
     one thing we're guaranteed to see on paper regardless of state.
     Doubles as an on-screen title block and a diagnostic surface
     when the query is loading / errored / empty. */
  .qr-sheet-header {
    max-width: 7in;
    margin: 0.3in auto 0.2in;
    padding: 0 0.2in;
    text-align: center;
    color: hsl(160 18% 14%);
    font-family: 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
  }
  .qr-sheet-header-title {
    font-weight: 800;
    font-size: 16px;
    letter-spacing: 0.02em;
    color: hsl(153 46% 33%);
  }
  .qr-sheet-header-meta {
    font-weight: 500;
    font-size: 13px;
    color: hsl(160 8% 40%);
    margin-top: 4px;
  }
  /* Empty-state box — visible in print so an operator who hit
     Print with zero bound stickers sees a clear "why is this blank"
     message instead of ghost pages. */
  .qr-empty-print {
    max-width: 6in;
    margin: 0.3in auto;
    padding: 0.3in 0.35in;
    border: 1px dashed #bbb;
    border-radius: 0.16in;
    background: white;
    text-align: center;
    color: hsl(160 18% 14%);
  }
  .qr-empty-print p {
    margin: 0;
    color: hsl(160 18% 14%);
  }
  .qr-empty-print p + p {
    margin-top: 6px;
    color: hsl(160 8% 40%);
    font-size: 12.5px;
  }
  .qr-sheet {
    display: grid;
    grid-template-columns: repeat(2, 4in);
    justify-content: center;
    gap: 0.18in 0.18in;
    padding: 0.5in 0;
    max-width: 8.27in;
    margin: 0 auto;
  }

  /* ── Card ────────────────────────────────────────────────────── */
  /* overflow: hidden is REQUIRED here — it does two jobs:
       1. Clips the QR panel's blob decorations so they don't
          leak past the card's rounded corners.
       2. Backstops the info panel: even if a future edit removes
          .qr-card-right's min-width: 0, this clip prevents visual
          bleed into the neighbouring card in the grid.
     Do not remove without moving both responsibilities elsewhere. */
  .qr-card {
    box-sizing: border-box;
    width: 4in;
    height: 2.5in;
    background: hsl(140 24% 97%);
    border: 1px solid hsl(145 18% 89%);
    border-radius: 0.16in;
    box-shadow: 0 10px 26px -12px rgba(20, 60, 42, 0.28);
    color: hsl(160 18% 14%);
    font-family: 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
    display: flex;
    flex-direction: row;
    align-items: stretch;
    overflow: hidden;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* ── Left panel: deep-green with diagonal gradient ───────────── */
  .qr-card-left {
    position: relative;
    flex: 0 0 1.72in;
    background: linear-gradient(165deg, hsl(153 46% 33%) 0%, hsl(153 50% 25%) 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.14in;
    gap: 0.12in;
    overflow: hidden;
  }
  .qr-blob {
    position: absolute;
    background: rgba(255, 255, 255, 0.08);
    /* Organic non-circle radius — echoes the diner PWA blob motif. */
    border-radius: 44% 56% 58% 42% / 56% 44% 56% 44%;
    pointer-events: none;
  }
  .qr-blob-a {
    width: 0.97in;   /* ~70px at 72dpi CSS ref */
    height: 0.97in;
    top: -0.35in;
    left: -0.35in;
  }
  .qr-blob-b {
    width: 0.69in;   /* ~50px */
    height: 0.69in;
    bottom: -0.25in;
    right: -0.25in;
  }
  .qr-code-box {
    position: relative;
    width: 1.32in;
    height: 1.32in;
    background: white;
    border-radius: 0.11in;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 6px 14px -6px rgba(0, 0, 0, 0.35);
  }
  .qr-card-img {
    width: 1.16in;
    height: 1.16in;
    image-rendering: pixelated;
    display: block;
  }
  .qr-table-pill {
    position: relative;
    background: hsl(78 64% 50%);
    color: #213311;
    font: 800 13px/1 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0.06in 0.14in;
    border-radius: 999px;
    transform: rotate(-2deg);
  }

  /* ── Right panel: cream info ─────────────────────────────────── */
  /* min-width: 0 is load-bearing — without it, the reward chip and
     URL (both white-space: nowrap) inflate the flex item's min-content
     past its 2.28in allotment, and even though .qr-card clips with
     overflow: hidden, the content still visibly pushes toward the
     grid gap on the way out. Belt + suspenders: keep overflow: hidden
     on .qr-card AND min-width: 0 here so the fix survives future
     refactors that remove one or the other. */
  .qr-card-right {
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.19in 0.22in 0.16in;
    display: flex;
    flex-direction: column;
    gap: 0.06in;
    text-align: left;
    background: hsl(140 24% 97%);
    overflow: hidden;
  }
  .qr-brand-row {
    display: flex;
    align-items: center;
    gap: 0.07in;
  }
  .qr-brand-badge {
    width: 16px;
    height: 16px;
    background: hsl(153 46% 33%);
    color: white;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transform: rotate(-6deg);
  }
  .qr-brand-label {
    font: 800 11px/1 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
    color: hsl(160 8% 40%);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .qr-card-name {
    font-family: 'Fraunces', Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 600;
    font-size: 21px;
    line-height: 1.05;
    color: hsl(160 18% 14%);
    margin-top: 0.02in;
    overflow-wrap: anywhere;
  }
  .qr-card-steps {
    list-style: none;
    padding: 0;
    margin: 0.04in 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.05in;
  }
  .qr-card-steps li {
    display: flex;
    align-items: flex-start;
    gap: 0.08in;
    /* Let the text child shrink below its intrinsic width so long
       phrases (e.g. "Finish your plate → unlock a reward") wrap
       inside the right panel instead of overflowing. */
    min-width: 0;
  }
  .qr-step-num {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: hsl(153 40% 95%);
    color: hsl(153 46% 33%);
    font: 800 10px/16px 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    text-align: center;
  }
  .qr-step-text {
    font: 500 11.5px/1.22 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
    color: hsl(160 18% 14%);
    /* Belt + suspenders with the parent's min-width: 0 — force a
       wrap opportunity even on words joined by "→" (which browsers
       treat as unbreakable in some fonts). */
    min-width: 0;
    flex: 1 1 auto;
    overflow-wrap: anywhere;
  }
  .qr-step-text strong,
  .qr-step-text b {
    font-weight: 800;
    color: hsl(153 50% 25%);
  }

  /* ── Footer: stacked chip + URL, horizontally centred in the info
     panel. align-items: center handles the flex column axis; the
     text-align: center is belt-and-suspenders for any inline content
     inside the flex children. */
  .qr-footer {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.05in;
  }
  .qr-reward-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.06in;
    background: hsl(36 90% 93%);
    color: hsl(28 78% 44%);
    font: 700 10.5px/1 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
    padding: 0.055in 0.12in;
    border-radius: 999px;
    white-space: nowrap;
  }
  .qr-friendly-url {
    font: 700 10.5px/1 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: hsl(153 46% 33%);
    white-space: nowrap;
  }

  /* ── Print rules ─────────────────────────────────────────────── */
  @media print {
    html, body {
      background: white !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    /* NUCLEAR OPTION: hide the entire outer app shell in print.
       The dashboard mounts this screen inside a Tailwind layout
       (.s-app > main.flex-1.max-w-screen-md) whose parent
       constraints (min-h-full, flex-1, max-width) can push the
       print content off the page or invent ghost pages before
       our own CSS gets a chance to run. Using the classic
       "visibility on parent, visibility visible on target" trick
       we scrub everything above .qr-print-root, then float our
       root at the top of the page in absolute position so we
       escape the parent flex/flow entirely. */
    body * {
      visibility: hidden !important;
    }
    .qr-print-root,
    .qr-print-root * {
      visibility: visible !important;
    }
    .qr-print-root {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      right: 0 !important;
      width: 100% !important;
      background: white !important;
      /* Kill min-height in print — otherwise an empty container
         forces one or two ghost pages of blank white. */
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .no-print { display: none !important; }

    /* SINGLE-COLUMN in print. On A4 with 0.3in margins, printable
       width is ~7.67in — a 2-column layout (2×4in + gap = 8.18in)
       overflows the printable area, and Chrome responds by pushing
       the centred grid entirely off-page, producing a blank preview.
       One card per row prints reliably on both A4 and Letter, and
       matches how these will be cut anyway. */
    .qr-sheet {
      display: block !important;
      max-width: none !important;
      padding: 0 !important;
      margin: 0 !important;
    }
    .qr-card {
      /* Stacked vertically. margin auto centres each card on the
         printable row. 0.18in bottom gap holds between cards; page
         break behavior stays sane thanks to break-inside: avoid. */
      margin: 0 auto 0.18in !important;
      box-shadow: none !important;
      border: 1px dashed #bbb !important;
    }
    /* Force browsers to render backgrounds — Chrome/Safari otherwise
       drop the gradient + coloured chips "to save toner" unless the
       user manually enables "Background graphics" in the print
       dialog. print-color-adjust: exact overrides on modern engines. */
    .qr-card,
    .qr-card-left,
    .qr-card-right,
    .qr-table-pill,
    .qr-reward-chip,
    .qr-step-num,
    .qr-brand-badge,
    .qr-blob {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    @page {
      size: A4;
      margin: 0.3in;
    }
  }
`;
