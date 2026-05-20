import hashlib
import io
from uuid import UUID

import boto3
from botocore.client import Config as BotoConfig
from botocore.exceptions import ClientError
from PIL import Image, UnidentifiedImageError

from app.config import get_settings
from app.errors import ImageInvalid, ImageTooLarge

settings = get_settings()
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5MB per spec


def _client():
    return boto3.client(
        "s3",
        endpoint_url=settings.S3_ENDPOINT or None,
        region_name=settings.S3_REGION,
        aws_access_key_id=settings.S3_ACCESS_KEY,
        aws_secret_access_key=settings.S3_SECRET_KEY,
        config=BotoConfig(signature_version="s3v4"),
    )


def ensure_bucket() -> None:
    s3 = _client()
    try:
        s3.head_bucket(Bucket=settings.S3_BUCKET)
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        if code in ("404", "NoSuchBucket", "NotFound"):
            s3.create_bucket(Bucket=settings.S3_BUCKET)
        else:
            raise


def validate_and_hash(image_bytes: bytes) -> tuple[str, str]:
    """Returns (mime_type, sha256_hex). Raises ImageInvalid/ImageTooLarge."""
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise ImageTooLarge(MAX_IMAGE_BYTES)
    if len(image_bytes) == 0:
        raise ImageInvalid("Empty file")
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            img.verify()
            fmt = (img.format or "").lower()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ImageInvalid("Unrecognized image format") from exc
    if fmt not in {"jpeg", "jpg", "png"}:
        raise ImageInvalid(f"Unsupported format: {fmt}")
    mime = "image/jpeg" if fmt in ("jpeg", "jpg") else "image/png"
    sha = hashlib.sha256(image_bytes).hexdigest()
    return mime, sha


def upload_capture(session_id: UUID, phase: str, image_bytes: bytes, mime: str) -> str:
    key = f"captures/{session_id}/{phase}.{ 'jpg' if mime == 'image/jpeg' else 'png' }"
    s3 = _client()
    s3.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=image_bytes,
        ContentType=mime,
    )
    return key


def signed_url(key: str, expires_seconds: int = 900) -> str:
    s3 = _client()
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.S3_BUCKET, "Key": key},
        ExpiresIn=expires_seconds,
    )


def download(key: str) -> bytes:
    s3 = _client()
    obj = s3.get_object(Bucket=settings.S3_BUCKET, Key=key)
    return obj["Body"].read()


def delete(key: str) -> None:
    s3 = _client()
    s3.delete_object(Bucket=settings.S3_BUCKET, Key=key)
