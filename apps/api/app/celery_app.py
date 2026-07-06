from celery import Celery
from celery.schedules import crontab

from app.config import get_settings

_settings = get_settings()

celery_app = Celery(
    "plate_clean",
    broker=_settings.REDIS_URL,
    backend=_settings.REDIS_URL,
    include=[
        "app.tasks.scoring",
        "app.tasks.anomaly",
        "app.tasks.staff_metrics",
        "app.tasks.image_retention",
        "app.tasks.deliver_bill",
    ],
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
    beat_schedule={
        # Fraud signal #10: nightly at 02:30 UTC.
        "score-anomaly-scan-nightly": {
            "task": "fraud.score_anomaly_scan",
            "schedule": crontab(hour=2, minute=30),
        },
        # Ethics rule 8: Monday 03:00 UTC, looks at the prior 7 days.
        "staff-metrics-weekly": {
            "task": "metrics.staff_metrics_weekly",
            "schedule": crontab(hour=3, minute=0, day_of_week="mon"),
        },
        # Ethics rule 6: nightly 03:30 UTC. Purge S3 capture objects whose
        # age has exceeded each owning diner's image_retention_days.
        "image-retention-nightly": {
            "task": "image_retention.purge_expired_captures",
            "schedule": crontab(hour=3, minute=30),
        },
    },
)
