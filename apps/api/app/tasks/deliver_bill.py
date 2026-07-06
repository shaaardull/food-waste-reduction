"""Celery task for asynchronous bill delivery.

Split from the sessions router so the API request returns 202 in
< 100 ms — real SMTP round-trips can take 3-5 seconds and blocking
the request handler on that is a bad UX. Task updates the bill row's
delivery_status + delivered_via + sent_at on success, or delivery_error
on failure. Retries with exponential backoff up to 3 times.
"""
from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.celery_app import celery_app
from app.config import get_settings
from app.logging import get_logger
from app.models.bill import Bill
from app.models.restaurant import Restaurant
from app.services.email import dispatch_bill_delivery

log = get_logger(__name__)


def _sync_session() -> Session:
    """Celery workers use the sync engine — async DB in a task adds
    complexity without benefit here. Matches the pattern used by the
    scoring / staff-metrics tasks."""
    settings = get_settings()
    engine = create_engine(settings.DATABASE_URL_SYNC, future=True)
    return Session(engine)


@celery_app.task(
    name="app.tasks.deliver_bill.deliver_bill",
    bind=True,
    max_retries=3,
    default_retry_delay=10,
)
def deliver_bill(
    self,
    bill_id: str,
    *,
    via: str,
    target_email: str | None = None,
    target_phone: str | None = None,
) -> None:
    """Send the bill via the requested channel(s) and stamp the row.

    Retried up to 3 times with 10s base delay on transient errors
    (SMTP timeouts, DNS blips). A permanent failure (bad credentials,
    misconfigured SMTP) sets delivery_status='failed' and the reason
    onto delivery_error — the caller sees this in the API response
    on the follow-up GET."""
    with _sync_session() as db:
        bill = db.get(Bill, UUID(bill_id))
        if bill is None:
            log.error("deliver_bill_not_found", bill_id=bill_id)
            return
        restaurant = db.get(Restaurant, bill.restaurant_id)
        if restaurant is None:
            log.error("deliver_bill_restaurant_missing", bill_id=bill_id)
            bill.delivery_status = "failed"
            bill.delivery_error = "restaurant row missing"
            db.commit()
            return

        result = dispatch_bill_delivery(
            bill=bill,
            restaurant=restaurant,
            via=via,
            target_email=target_email,
            target_phone=target_phone,
        )
        any_landed = result["email_sent"] or result["sms_sent"]
        if any_landed:
            bill.delivery_status = "sent"
            bill.sent_at = datetime.now(UTC)
            # `delivered_via` reflects what actually landed on any
            # channel, not what was requested. If only email worked in
            # a 'both' request, we mark it 'email' so the audit trail
            # is honest.
            if result["email_sent"] and result["sms_sent"]:
                bill.delivered_via = "both"
            elif result["email_sent"]:
                bill.delivered_via = "email"
            else:
                bill.delivered_via = "sms"
            bill.delivery_error = None
            db.commit()
            log.info(
                "bill_delivered",
                bill_id=bill_id,
                via=bill.delivered_via,
            )
            return

        # Nothing landed. If we've got retries left, throw to trigger
        # Celery's backoff. Otherwise permanent failure.
        bill.delivery_error = result.get("error") or "unknown error"
        if self.request.retries < self.max_retries:
            db.commit()
            log.warning(
                "bill_delivery_retrying",
                bill_id=bill_id,
                attempt=self.request.retries,
                error=bill.delivery_error,
            )
            raise self.retry(countdown=10 * (2**self.request.retries))
        bill.delivery_status = "failed"
        db.commit()
        log.error(
            "bill_delivery_failed",
            bill_id=bill_id,
            error=bill.delivery_error,
        )
