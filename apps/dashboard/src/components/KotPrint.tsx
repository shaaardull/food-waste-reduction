/**
 * KOT (Kitchen Order Ticket) printing.
 *
 * Renders one ticket into a hidden iframe and calls the iframe's own
 * window.print(). The iframe carries a 80mm-wide thermal-printer
 * stylesheet so the ticket comes out sized for a Star TSP143 /
 * Epson TM-T88 / any generic ESC/POS thermal printer.
 *
 * When Chrome is launched with `--kiosk-printing`, calling
 * window.print() bypasses the print dialog and just prints to the
 * OS's default printer. On the kitchen tablet you set the thermal
 * printer as default and launch Chrome with that flag; the moment a
 * new order lands, the ticket slides out — no chef interaction.
 * (Off-flag Chrome shows the normal print dialog, which is also
 * fine — one tap and it prints.)
 *
 * There is exactly one hidden iframe mounted at Kitchen screen top.
 * printKotEvent() writes the ticket HTML into it and calls print().
 */

interface KotEventForPrint {
  station: string;
  event_type: 'new' | 'add_on' | 'void' | 'reprint';
  table_code: string;
  created_at: string;
  items_snapshot: Array<{
    name: string;
    quantity: number;
    portion_size: string | null;
    notes: string | null;
  }>;
}

const IFRAME_ID = 'plate-kot-print-frame';

/**
 * Mount once at the top of Kitchen.tsx. Owns the hidden iframe that
 * printKotEvent writes into.
 */
export function AutoPrintFrame() {
  return (
    <iframe
      id={IFRAME_ID}
      title="kot-print-frame"
      aria-hidden="true"
      // 0-size in the layout but still able to print. `display: none`
      // is what breaks it — the iframe needs a live document.
      style={{
        position: 'fixed',
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        border: 0,
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Render one ticket into the hidden iframe and fire its print().
 * Called both from the auto-print loop (on new/add_on events) and
 * from the reprint button.
 */
export function printKotEvent(ev: KotEventForPrint): void {
  const frame = document.getElementById(IFRAME_ID) as HTMLIFrameElement | null;
  if (!frame || !frame.contentWindow || !frame.contentDocument) {
    // Should not happen — AutoPrintFrame is mounted on the Kitchen
    // page. If someone triggers a print from outside that page we
    // silently no-op rather than crash.
    return;
  }
  const doc = frame.contentDocument;
  doc.open();
  doc.write(renderTicketHtml(ev));
  doc.close();
  // Give the iframe a tick to layout, then print. The exact delay
  // isn't critical — 50 ms covers slower tablets without a
  // perceptible lag.
  window.setTimeout(() => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      /* iframe may have been unmounted mid-print */
    }
  }, 50);
}

function renderTicketHtml(ev: KotEventForPrint): string {
  const banner =
    ev.event_type === 'add_on'
      ? '** ADD-ON **'
      : ev.event_type === 'void'
        ? '** VOID **'
        : ev.event_type === 'reprint'
          ? '** REPRINT **'
          : '';
  const time = new Date(ev.created_at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const itemsHtml = ev.items_snapshot
    .map((it) => {
      const portion =
        it.portion_size && it.portion_size !== 'regular'
          ? ` (${escapeHtml(it.portion_size.toUpperCase())})`
          : '';
      const notes = it.notes
        ? `<div class="note">! ${escapeHtml(it.notes)}</div>`
        : '';
      return `
        <div class="item">
          <div class="line">
            <span class="qty">${it.quantity}×</span>
            <span class="name">${escapeHtml(it.name)}${portion}</span>
          </div>
          ${notes}
        </div>
      `;
    })
    .join('');

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8"/>
    <title>KOT ${escapeHtml(ev.table_code)}</title>
    <style>
      /* 80 mm-wide thermal receipt printers give a printable width
         of ~72 mm. Everything sized in mm so it renders identically
         regardless of the driver's DPI setting. */
      @page {
        size: 80mm auto;
        margin: 0;
      }
      html, body {
        margin: 0;
        padding: 0;
        width: 72mm;
        font-family: 'Menlo', 'Consolas', 'Courier New', monospace;
        color: #000;
      }
      body {
        padding: 3mm 4mm 6mm;
        font-size: 12pt;
        line-height: 1.25;
      }
      .banner {
        text-align: center;
        font-weight: 900;
        font-size: 12pt;
        letter-spacing: 1px;
        margin-bottom: 2mm;
      }
      .head {
        text-align: center;
        margin-bottom: 3mm;
      }
      .head .table {
        font-size: 20pt;
        font-weight: 900;
        letter-spacing: 1px;
        margin: 1mm 0;
      }
      .head .meta {
        font-size: 10pt;
      }
      hr {
        border: 0;
        border-top: 1px dashed #000;
        margin: 2mm 0;
      }
      .item {
        margin-bottom: 2mm;
      }
      .line {
        display: flex;
        gap: 2mm;
      }
      .qty {
        min-width: 8mm;
        font-weight: 900;
      }
      .name {
        flex: 1;
        font-weight: 700;
      }
      .note {
        margin-left: 8mm;
        margin-top: 0.5mm;
        font-size: 10pt;
        font-style: italic;
      }
      .footer {
        margin-top: 4mm;
        text-align: center;
        font-size: 9pt;
      }
    </style>
  </head>
  <body>
    ${banner ? `<div class="banner">${banner}</div>` : ''}
    <div class="head">
      <div class="table">${escapeHtml(ev.table_code)}</div>
      <div class="meta">${escapeHtml(ev.station.toUpperCase())} · ${time}</div>
    </div>
    <hr/>
    ${itemsHtml}
    <hr/>
    <div class="footer">— end of ticket —</div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
