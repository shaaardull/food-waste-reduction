import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Printer } from 'lucide-react';

/**
 * WaitlistPrintSheet — single 4"×4" printable card featuring the
 * per-restaurant waitlist QR. Different flow from the table-QR sheet
 * (which prints one card per assigned sticker) because the waitlist QR
 * is one-per-restaurant. We reuse the same `api.qrserver.com` renderer
 * so we don't take on an npm QR library.
 *
 * URL params: `slug` (required) — encoded into the QR — and `name`
 * (optional) — displayed on the card.
 */

const DINER_BASE =
  import.meta.env.VITE_DINER_APP_BASE_URL ?? 'http://localhost:5173';

const QR_SIZE_PX = 500;
function qrSrc(url: string): string {
  const encoded = encodeURIComponent(url);
  return `https://api.qrserver.com/v1/create-qr-code/?data=${encoded}&size=${QR_SIZE_PX}x${QR_SIZE_PX}&margin=1&ecc=M`;
}

function useGoogleFonts() {
  useEffect(() => {
    const id = 'waitlist-print-fonts';
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

export function WaitlistPrintSheet() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  useGoogleFonts();

  const slug = params.get('slug') ?? '';
  const restaurantName = params.get('name') ?? '';

  const url = useMemo(
    () => `${DINER_BASE.replace(/\/$/, '')}/wait/${slug}`,
    [slug],
  );
  const friendlyUrl = useMemo(() => `plateclean.in/wait/${slug}`, [slug]);

  if (!slug) {
    return (
      <p className="text-sm text-danger p-4">
        {t('dashboard.waitlist_print.missing_slug')}
      </p>
    );
  }

  return (
    <div className="wl-print-root">
      <style>{PRINT_CSS}</style>

      <div className="no-print sticky top-0 z-10 bg-brand text-white px-4 py-2.5 shadow-sh-sm row spread items-center">
        <div>
          <div className="text-[11.5px] uppercase tracking-wide opacity-80">
            {t('dashboard.waitlist_print.eyebrow')}
          </div>
          <div className="font-semibold text-[14px]">
            {t('dashboard.waitlist_print.title')}
          </div>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="row gap-1.5 items-center bg-white text-brand font-semibold text-[13px] rounded-md px-3.5 py-1.5 hover:bg-white/95 transition"
        >
          <Printer size={14} />
          {t('dashboard.waitlist_print.print_button')}
        </button>
      </div>

      <div className="wl-sheet">
        <div className="wl-card">
          <div className="wl-eyebrow">
            {t('dashboard.waitlist_print.card_eyebrow')}
          </div>
          <div className="wl-restaurant">{restaurantName || '—'}</div>
          <div className="wl-qr-box">
            <img
              src={qrSrc(url)}
              alt={`Waitlist QR for ${restaurantName || slug}`}
              className="wl-qr-img"
            />
          </div>
          <p className="wl-copy">{t('dashboard.waitlist_print.card_copy')}</p>
          <div className="wl-friendly-url">{friendlyUrl}</div>
        </div>
      </div>
    </div>
  );
}

const PRINT_CSS = `
  .wl-print-root {
    background: hsl(140 20% 96%);
    min-height: 100vh;
  }
  .wl-sheet {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5in 0;
    max-width: 8.27in;
    margin: 0 auto;
  }
  .wl-card {
    box-sizing: border-box;
    width: 4in;
    height: 4in;
    background: hsl(140 24% 97%);
    border: 1px solid hsl(145 18% 89%);
    border-radius: 0.16in;
    box-shadow: 0 10px 26px -12px rgba(20, 60, 42, 0.28);
    color: hsl(160 18% 14%);
    font-family: 'Hanken Grotesk', -apple-system, 'Segoe UI', system-ui, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 0.28in 0.24in;
    text-align: center;
  }
  .wl-eyebrow {
    font: 800 11.5px/1 'Hanken Grotesk', -apple-system, sans-serif;
    color: hsl(160 8% 40%);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .wl-restaurant {
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic;
    font-weight: 600;
    font-size: 22px;
    line-height: 1.1;
    color: hsl(160 18% 14%);
    max-width: 3.4in;
    overflow-wrap: anywhere;
  }
  .wl-qr-box {
    width: 2in;
    height: 2in;
    background: white;
    border-radius: 0.11in;
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 6px 14px -6px rgba(0, 0, 0, 0.25);
  }
  .wl-qr-img {
    width: 1.85in;
    height: 1.85in;
    image-rendering: pixelated;
    display: block;
  }
  .wl-copy {
    font: 700 13px/1.35 'Hanken Grotesk', -apple-system, sans-serif;
    color: hsl(160 18% 14%);
    margin: 0;
    max-width: 3.4in;
  }
  .wl-friendly-url {
    font: 700 11.5px/1 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    color: hsl(153 46% 33%);
    letter-spacing: 0.02em;
  }

  @media print {
    html, body {
      background: white !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    body * { visibility: hidden !important; }
    .wl-print-root, .wl-print-root * { visibility: visible !important; }
    .wl-print-root {
      position: absolute !important;
      left: 0 !important;
      top: 0 !important;
      right: 0 !important;
      width: 100% !important;
      background: white !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
    .no-print { display: none !important; }
    .wl-sheet { padding: 0 !important; margin: 0.4in auto !important; }
    .wl-card {
      box-shadow: none !important;
      border: 1px dashed #bbb !important;
    }
    .wl-card, .wl-qr-box {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
      color-adjust: exact !important;
    }
    @page { size: A4; margin: 0.3in; }
  }
`;
