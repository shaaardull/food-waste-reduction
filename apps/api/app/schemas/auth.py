from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
    # Phone is required at sign-up so we have both channels for every
    # account — SMS for OTP-based password reset + reward alerts,
    # email for tax invoices. Sprint decision: rather than let people
    # sign up with just an email and be stranded during a password
    # reset (since we haven't wired SMTP-based reset in Phase 1), we
    # take both up front.
    phone: str = Field(min_length=6, max_length=20)
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=100)
    is_adult: bool = Field(description="User confirms they are 18+. Ethics rule 4 (minor protection).")


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class OtpRequestIn(BaseModel):
    phone: str = Field(min_length=6, max_length=20)


class OtpRequestOut(BaseModel):
    request_id: str


class OtpVerifyIn(BaseModel):
    request_id: str
    code: str = Field(min_length=4, max_length=8)


class ForgotPasswordIn(BaseModel):
    """Identifier can be an email or a phone. We look the user up by
    either, then always deliver the reset OTP to their phone. Email
    delivery would need SMTP for a reset link, which is out of scope
    for Phase 1 — SMS is the single channel."""

    identifier: str = Field(min_length=3, max_length=254)


class ForgotPasswordOut(BaseModel):
    request_id: str
    delivery: str = "sms"


class ResetPasswordIn(BaseModel):
    request_id: str
    code: str = Field(min_length=4, max_length=8)
    new_password: str = Field(min_length=8, max_length=128)


class GoogleSignInIn(BaseModel):
    """The Google Identity Services callback returns a `credential`
    field that IS the ID token — we just forward it. Everything else
    (email, sub, name) is extracted server-side from the token so
    the client can't lie about the identity."""

    id_token: str = Field(min_length=32, max_length=4096)


class ChangePasswordIn(BaseModel):
    """Signed-in password rotation. Verifies current_password against
    the stored hash before setting new_password. Distinct from
    reset_password because there's no OTP round-trip — the JWT itself
    is the proof of identity."""

    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    id: UUID
    email: str
    phone: str | None = None
    display_name: str | None = None
    role: str
    email_verified_at: datetime | None = None
    last_login_at: datetime | None = None
    created_at: datetime
    image_retention_days: int = 7

    model_config = {"from_attributes": True}


class UserPatchIn(BaseModel):
    """Self-service knobs the diner can set from Profile (ethics rule 6)."""

    display_name: str | None = Field(default=None, max_length=100)
    image_retention_days: int | None = Field(default=None, ge=7, le=90)


class AuthOut(BaseModel):
    user: UserOut
    token: str
