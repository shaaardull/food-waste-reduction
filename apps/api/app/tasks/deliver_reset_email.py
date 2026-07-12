"""Celery task for password-reset-code email delivery.

Mirrors deliver_bill / deliver_dispute_email: the API returns 200 on
/auth/forgot-password immediately, and the email round-trip happens
here on the worker. Retries 3× with exponential backoff on transient
SMTP failures.

The task takes the OTP code as-is, not a reference to Redis, because
- the Redis entry might expire (5 min TTL) before a retry lands, and
- rehydrating from Redis in a task means a race where an attacker
  who verifies the OTP first steals the code from a retry.

Since the code is short-lived and single-use anyway (verify_otp
deletes it on success), passing it through Celery is safe enough.
"""
from __future__ import annotations

from app.celery_app import celery_app
from app.logging import get_logger
from app.services.email import render_password_reset_email, send_email

log = get_logger(__name__)


@celery_app.task(
    name="app.tasks.deliver_reset_email.deliver_reset_email",
    bind=True,
    max_retries=3,
    default_retry_delay=10,
)
def deliver_reset_email(self, email: str, code: str) -> None:
    """Send the 6-digit reset code to the diner's email."""
    subject, plain, html = render_password_reset_email(email=email, code=code)
    result = send_email(to=email, subject=subject, plain_body=plain, html_body=html)
    if result.sent:
        log.info("reset_email_sent", to=email)
        return
    if self.request.retries < self.max_retries:
        log.warning(
            "reset_email_retrying",
            to=email,
            attempt=self.request.retries,
            error=result.error,
        )
        raise self.retry(countdown=10 * (2**self.request.retries))
    log.error("reset_email_failed_permanently", to=email, error=result.error)
