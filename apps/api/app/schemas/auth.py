from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
    email: EmailStr
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
