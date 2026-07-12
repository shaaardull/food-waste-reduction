"""Celery task for support-team notification when a diner files a dispute.

Modelled after `deliver_bill.py` — the API returns 201 immediately
after inserting the Dispute row, and the actual SMTP round-trip
(which can take 3-5 s or fail on transient DNS blips) is deferred
here. The task retries with the same exponential backoff pattern.

We intentionally do NOT block dispute creation on this email:
- The dispute is already persisted in Postgres before we enqueue.
- The Disputes tab in the dashboard reads directly from Postgres, so
  ops sees the dispute immediately regardless of email delivery.
- The email is a courtesy heads-up to the support inbox, not the
  system of record. A silent SMTP outage is annoying, not catastrophic.
"""
from __future__ import annotations

from uuid import UUID

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.dispute import Dispute
from app.models.meal_session import MealSession
from app.models.restaurant import Restaurant
from app.models.user import User
from app.services.email import render_dispute_email, send_email

log = get_logger(__name__)


def _sync_session() -> Session:
    settings = get_settings()
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    return Session(engine)


def _dashboard_url_for(dispute_id: str) -> str:
    """Deep link to the Disputes tab. We don't have a per-dispute
    route yet on the dashboard (the tab shows them in a list), so
    we just anchor on the list — support agents scan for the dispute
    ID we've already put in the email body."""
    settings = get_settings()
    base = settings.DASHBOARD_BASE_URL.rstrip("/")
    return f"{base}/disputes"


@celery_app.task(
    name="app.tasks.deliver_dispute_email.deliver_dispute_email",
    bind=True,
    max_retries=3,
    default_retry_delay=10,
)
def deliver_dispute_email(self, dispute_id: str) -> None:
    """Compose the support notification and send it.

    Retries 3× with 10s base + exponential backoff on transient SMTP
    errors. A permanent failure is logged but does NOT roll back the
    dispute row — the dashboard is the source of truth.
    """
    settings = get_settings()
    to_addr = settings.SUPPORT_EMAIL_ADDRESS
    if not to_addr:
        log.error("dispute_email_no_support_addr", dispute_id=dispute_id)
        return

    with _sync_session() as db:
        dispute = db.get(Dispute, UUID(dispute_id))
        if dispute is None:
            log.error("dispute_email_row_missing", dispute_id=dispute_id)
            return
        session = db.get(MealSession, dispute.meal_session_id)
        if session is None:
            log.error(
                "dispute_email_session_missing",
                dispute_id=dispute_id,
                meal_session_id=str(dispute.meal_session_id),
            )
            return
        restaurant = db.get(Restaurant, session.restaurant_id)
        if restaurant is None:
            log.error(
                "dispute_email_restaurant_missing",
                dispute_id=dispute_id,
                restaurant_id=str(session.restaurant_id),
            )
            return
        diner = db.get(User, dispute.raised_by_user_id)

        subject, plain_body, html_body = render_dispute_email(
            dispute_id=str(dispute.id),
            session_id=str(session.id),
            # If the diner filed after their session already flipped
            # to `disputed` we still want to know what the session was
            # BEFORE. The router flips status the same commit so we
            # can't recover the prior state here — fall back to the
            # current one, which is 'disputed' for any dispute row.
            session_status_before=session.status,
            table_code=session.table_code,
            reason=dispute.reason,
            restaurant_name=restaurant.name,
            restaurant_address=restaurant.address,
            diner_email=(
                None
                if not diner or diner.email.endswith("@plate-clean.local")
                else diner.email
            ),
            diner_phone=diner.phone if diner else None,
            filed_at_iso=dispute.created_at.isoformat(),
            dashboard_url=_dashboard_url_for(str(dispute.id)),
        )

    # send_email is blocking + never raises → we decide about retries
    # based on the SendResult, mirroring the bill delivery task.
    result = send_email(
        to=to_addr, subject=subject, plain_body=plain_body, html_body=html_body,
    )
    if result.sent:
        log.info("dispute_email_sent", dispute_id=dispute_id, to=to_addr)
        return

    if self.request.retries < self.max_retries:
        log.warning(
            "dispute_email_retrying",
            dispute_id=dispute_id,
            attempt=self.request.retries,
            error=result.error,
        )
        raise self.retry(countdown=10 * (2**self.request.retries))
    log.error(
        "dispute_email_failed_permanently",
        dispute_id=dispute_id,
        error=result.error,
    )
