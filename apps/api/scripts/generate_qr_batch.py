"""Mint a batch of QR tokens + render a printable sticker sheet.

Workflow:

  1. Run `python scripts/generate_qr_batch.py --count 40 \\
        --batch-label 2026-q3-a --out qr-batch.pdf --base-url https://plateclean.in`
  2. The script inserts N unassigned `qr_tokens` rows and drops a
     multi-page A4 PDF with 20 QR stickers per page. Each sticker
     shows: the QR (encoding `{base_url}/qr/{token}`), the token in
     mono type underneath (so a broken-camera phone can still type it
     in), and the batch label along the bottom.
  3. Print the PDF on adhesive label sheets, cut, stick in a drawer.
  4. On onboarding day, use the platform command center's QR Tokens
     tab (or curl `POST /api/v1/admin/platform/qr-tokens/{token}/bind`)
     to bind each sticker to a `(restaurant, table)` pair.

Idempotency: this script does NOT reuse existing unassigned tokens.
Every run mints a fresh batch. If you meant to re-render an existing
batch's PDF, use `--reuse-batch <label>` instead of `--count`.

Sheet layout is fixed at 4 columns × 5 rows (20 stickers/page) on A4
because that's what standard Avery-compatible label sheets in the
Indian market use. Change with `--cols` / `--rows` if you're printing
on a different substrate.
"""
from __future__ import annotations

import argparse
import io
import os
import sys
from pathlib import Path

# Allow `python scripts/generate_qr_batch.py` from `apps/api/`.
_HERE = Path(__file__).resolve()
_API_ROOT = _HERE.parent.parent
sys.path.insert(0, str(_API_ROOT))

import qrcode  # noqa: E402
from reportlab.lib.pagesizes import A4  # noqa: E402
from reportlab.lib.units import mm  # noqa: E402
from reportlab.lib.utils import ImageReader  # noqa: E402
from reportlab.pdfgen import canvas  # noqa: E402
from sqlalchemy import create_engine, select  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.models.qr_token import QRToken  # noqa: E402
from app.routers.qr_tokens import _mint_token  # noqa: E402


def mint_batch(
    db: Session, count: int, batch_label: str | None
) -> list[QRToken]:
    """Insert `count` fresh unassigned tokens with the batch label.
    Retries on the astronomically unlikely uniqueness collision."""
    made: list[QRToken] = []
    for _ in range(count):
        for attempt in range(5):
            try:
                row = QRToken(
                    token=_mint_token(),
                    batch_label=batch_label,
                    state="unassigned",
                )
                db.add(row)
                db.flush()
                made.append(row)
                break
            except Exception:
                db.rollback()
                if attempt == 4:
                    raise
    db.commit()
    for r in made:
        db.refresh(r)
    return made


def load_batch(db: Session, batch_label: str) -> list[QRToken]:
    """Load an existing batch (any state) for re-rendering."""
    res = db.execute(
        select(QRToken)
        .where(QRToken.batch_label == batch_label)
        .order_by(QRToken.created_at.asc())
    )
    return list(res.scalars().all())


def render_pdf(
    tokens: list[QRToken],
    *,
    out_path: Path,
    base_url: str,
    batch_label: str | None,
    cols: int = 4,
    rows: int = 5,
) -> None:
    """Lay out `tokens` on A4 pages as a printable sticker sheet.

    Each cell contains:
      - A centred QR (encoding `{base_url}/qr/{token}`).
      - The token in monospace underneath (fallback for broken
        cameras).
      - The batch label + page tag along the bottom of the sheet.
    """
    page_w, page_h = A4
    # 6mm outer margin — the printer's paper feed nibbles a little
    # so we leave breathing room. Cell size derives from the margin.
    outer_margin = 6 * mm
    cell_w = (page_w - 2 * outer_margin) / cols
    cell_h = (page_h - 2 * outer_margin - 12 * mm) / rows  # 12mm footer
    qr_size = min(cell_w, cell_h) - 12 * mm  # leave room for the label

    c = canvas.Canvas(str(out_path), pagesize=A4)
    per_page = cols * rows
    total_pages = (len(tokens) + per_page - 1) // per_page

    for page_idx in range(total_pages):
        page_tokens = tokens[page_idx * per_page : (page_idx + 1) * per_page]

        for cell_idx, tok in enumerate(page_tokens):
            col = cell_idx % cols
            row = cell_idx // cols
            # ReportLab origin is bottom-left. Flip row so we lay
            # top-to-bottom, which is what a human reads.
            cell_x = outer_margin + col * cell_w
            cell_y = page_h - outer_margin - (row + 1) * cell_h

            # ── QR image ──
            url = f"{base_url.rstrip('/')}/qr/{tok.token}"
            qr = qrcode.QRCode(
                version=None,
                error_correction=qrcode.constants.ERROR_CORRECT_M,
                box_size=10,
                border=1,
            )
            qr.add_data(url)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)

            img_x = cell_x + (cell_w - qr_size) / 2
            img_y = cell_y + (cell_h - qr_size) / 2 + 4 * mm
            c.drawImage(ImageReader(buf), img_x, img_y, qr_size, qr_size)

            # ── token underneath ──
            c.setFont("Courier-Bold", 10)
            c.drawCentredString(
                cell_x + cell_w / 2,
                cell_y + 3 * mm,
                tok.token,
            )

        # ── page footer ──
        c.setFont("Helvetica", 8)
        footer = (
            f"Plate-Clean Rewards · batch {batch_label or '(no label)'}"
            f" · page {page_idx + 1} of {total_pages}"
        )
        c.drawCentredString(page_w / 2, outer_margin / 2, footer)
        c.showPage()

    c.save()


def _database_url_sync() -> str:
    """Reuse whatever DATABASE_URL_SYNC the app already computes so
    the script honours the same env override the API uses."""
    return get_settings().DATABASE_URL_SYNC


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Mint QR-token inventory + render a printable PDF sheet.",
    )
    ap.add_argument(
        "--count", type=int, default=None, help="How many tokens to mint."
    )
    ap.add_argument(
        "--reuse-batch",
        type=str,
        default=None,
        help="Re-render an existing batch's PDF (no new tokens minted).",
    )
    ap.add_argument(
        "--batch-label",
        type=str,
        default=None,
        help="Human-readable tag for this print run (e.g. '2026-q3-a').",
    )
    ap.add_argument(
        "--out",
        type=str,
        required=True,
        help="Path for the output PDF.",
    )
    ap.add_argument(
        "--base-url",
        type=str,
        default=os.environ.get(
            "QR_BASE_URL", "http://localhost:5173"
        ),
        help=(
            "Domain the QR codes point at. In dev this defaults to the "
            "diner PWA on localhost:5173; in prod pass "
            "https://plateclean.in or your equivalent."
        ),
    )
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--rows", type=int, default=5)
    args = ap.parse_args()

    if not args.count and not args.reuse_batch:
        ap.error("Pass either --count N (mint fresh) or --reuse-batch LABEL (re-render).")
    if args.count and args.reuse_batch:
        ap.error("Pass exactly one of --count / --reuse-batch, not both.")

    engine = create_engine(_database_url_sync(), future=True)
    with Session(engine, future=True) as db:
        if args.reuse_batch:
            tokens = load_batch(db, args.reuse_batch)
            if not tokens:
                print(
                    f"No tokens found for batch label {args.reuse_batch!r}. "
                    "Did you type it correctly?",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            tokens = mint_batch(db, args.count, args.batch_label)

    out_path = Path(args.out).resolve()
    render_pdf(
        tokens,
        out_path=out_path,
        base_url=args.base_url,
        batch_label=args.batch_label or args.reuse_batch,
        cols=args.cols,
        rows=args.rows,
    )
    print(
        f"✓ Rendered {len(tokens)} stickers → {out_path}\n"
        f"  Batch label: {args.batch_label or args.reuse_batch or '(none)'}\n"
        f"  Encoded URL: {args.base_url.rstrip('/')}/qr/<token>\n\n"
        f"Next: print, cut, stock. Bind at onboarding via:\n"
        f"  POST /api/v1/admin/platform/qr-tokens/<token>/bind\n"
        f"    {{'restaurant_id': ..., 'table_code': 'T-01'}}"
    )


if __name__ == "__main__":
    main()
