from celery import Celery

from app.config import get_settings

_settings = get_settings()

celery_app = Celery(
    "plate_clean",
    broker=_settings.REDIS_URL,
    backend=_settings.REDIS_URL,
    include=["app.tasks.scoring"],
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_acks_late=True,
    task_default_retry_delay=10,
    task_track_started=True,
    worker_max_tasks_per_child=200,
)
