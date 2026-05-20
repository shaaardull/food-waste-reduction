# Plate-Clean Rewards — Build Specification

This is the canonical build document for a vision-AI progressive web app that rewards restaurant diners for finishing their meals. It is written for an engineering agent (Claude Code) to execute against. Read this entire document before starting.

The companion document `plate-clean-rewards-architecture.md` contains the research background and design rationale. This file is the build plan.

---

## 0\. Operating instructions for the agent

- Work in phases. Do not start Phase 2 until Phase 1's acceptance criteria pass.  
- After each major task, run the test suite and the linter before moving on.  
- Commit per logical unit, not per file. Use Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).  
- If a requirement is ambiguous, prefer the simpler interpretation and leave a `// TODO(decision):` comment with the question.  
- Never hardcode secrets. All secrets via environment variables, documented in `.env.example`.  
- The CV model in Phase 1 is a hosted vision-LLM, not a custom model. Do not start training anything in Phase 1\.  
- All times stored as UTC. All money stored as integer minor units (paise/cents).  
- Default language: English. UI must be i18n-ready from day one (no hardcoded user-facing strings outside the locale files).

---

## 1\. Product summary

A PWA that lets a diner photograph their plate after a restaurant meal. A vision model estimates how much of the served food they consumed. If they hit a configurable threshold (default 75%), they unlock a reward — a free dessert, loyalty points, or a discount — redeemable at the table.

**Two user types:** Diners (consumers) and Restaurant staff. **One admin role** for platform operators.

**Key flow:**

1. Diner arrives, scans a QR code on the table.  
2. Order is placed and confirmed in the restaurant's POS or in the app's lightweight menu.  
3. Kitchen captures a "before" photo of the plated dish (or the system uses a reference photo for that menu item).  
4. Diner eats.  
5. Before paying, diner taps "Claim reward" and photographs the plate.  
6. Backend compares before vs after, returns a provisional consumption score.  
7. **A waiter or restaurant manager is notified on the staff dashboard. They visually confirm the diner's plate matches the after-photo and either approve, reject, or adjust the score.** Approval is required before any reward is issued.  
8. If approved and score ≥ threshold, diner gets a redemption code; the same staff member (or another) taps "redeem" on the restaurant tablet to honor it.

The model is an assistant, not the authority. Final say sits with a human at the restaurant.

---

## 2\. Tech stack (locked in)

Pick these. Do not substitute without raising a `TODO(decision)`.

**Monorepo:** pnpm workspaces \+ Turborepo.

**Client (PWA):**

- React 18 \+ TypeScript  
- Vite 5  
- Workbox for service worker / offline cache  
- TanStack Query for server state  
- Zustand for client state  
- Tailwind CSS \+ shadcn/ui for components  
- `react-webcam` or raw `getUserMedia` for camera  
- IndexedDB via `idb` for offline queue

**Backend API:**

- Python 3.12  
- FastAPI  
- SQLAlchemy 2.x (async) \+ Alembic for migrations  
- Pydantic v2 for schemas  
- Uvicorn (dev) / Gunicorn \+ UvicornWorker (prod)  
- Celery \+ Redis for async jobs (image processing, notifications)  
- python-jose for JWT, passlib\[bcrypt\] for password hashing

**Vision service:**

- Phase 1: thin wrapper around the Anthropic API (Claude with vision) — structured output via tool use.  
- Phase 2+: separate FastAPI service running PyTorch / ONNX Runtime on GPU.

**Data:**

- PostgreSQL 16  
- Redis 7  
- S3-compatible object store (AWS S3 in prod, MinIO in dev)

**Infra:**

- Docker \+ docker-compose for local dev  
- GitHub Actions for CI  
- Deployment target: Fly.io for early stages (multi-region, simple)

**Testing:**

- Backend: pytest \+ pytest-asyncio \+ httpx  
- Frontend: Vitest \+ React Testing Library \+ Playwright for e2e  
- Coverage target: 70% on backend logic, smoke tests on frontend

---

## 3\. Monorepo layout

plate-clean/

├── apps/

│   ├── web/                      \# Diner PWA

│   ├── dashboard/                \# Restaurant \+ admin dashboard

│   └── api/                      \# FastAPI backend

├── services/

│   └── vision/                   \# Vision inference service (Phase 2\)

├── packages/

│   ├── shared-types/             \# TypeScript types shared across apps

│   ├── ui/                       \# Shared React components (shadcn-based)

│   └── eslint-config/

├── infra/

│   ├── docker/

│   │   ├── docker-compose.yml

│   │   ├── docker-compose.prod.yml

│   │   └── Dockerfile.\*

│   └── migrations/               \# Alembic migrations (symlinked from apps/api)

├── docs/

│   ├── architecture.md           \# The research doc

│   ├── api.md                    \# OpenAPI excerpt \+ examples

│   └── runbook.md

├── .github/workflows/

├── .env.example

├── package.json

├── pnpm-workspace.yaml

├── turbo.json

└── README.md

---

## 4\. Data model

PostgreSQL schemas. All tables have `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` unless noted. Soft deletes use `deleted_at TIMESTAMPTZ NULL`.

### 4.1 Core tables

**users**

- `email TEXT UNIQUE NOT NULL`  
- `phone TEXT UNIQUE`  
- `display_name TEXT`  
- `password_hash TEXT` (nullable; some users are phone-OTP only)  
- `role TEXT NOT NULL CHECK (role IN ('diner', 'staff', 'admin'))`  
- `email_verified_at TIMESTAMPTZ`  
- `last_login_at TIMESTAMPTZ`

**restaurants**

- `name TEXT NOT NULL`  
- `slug TEXT UNIQUE NOT NULL`  
- `address TEXT NOT NULL`  
- `latitude DOUBLE PRECISION NOT NULL`  
- `longitude DOUBLE PRECISION NOT NULL`  
- `geofence_radius_m INTEGER NOT NULL DEFAULT 100`  
- `timezone TEXT NOT NULL DEFAULT 'UTC'`  
- `currency TEXT NOT NULL DEFAULT 'INR'`  
- `is_active BOOLEAN NOT NULL DEFAULT TRUE`

**restaurant\_staff** (many-to-many users ↔ restaurants)

- `user_id UUID NOT NULL REFERENCES users(id)`  
- `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`  
- `role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'server'))`  
- UNIQUE(user\_id, restaurant\_id)

**menu\_items**

- `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`  
- `name TEXT NOT NULL`  
- `description TEXT`  
- `price_minor INTEGER NOT NULL` (in paise/cents)  
- `category TEXT` (e.g. 'main', 'dessert', 'drink', 'side')  
- `is_reward_eligible BOOLEAN NOT NULL DEFAULT FALSE` (can be given as reward)  
- `is_active BOOLEAN NOT NULL DEFAULT TRUE`  
- `reference_image_url TEXT` (the canonical "before" image for this dish)

**reward\_rules** (per restaurant)

- `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`  
- `name TEXT NOT NULL` (e.g. "Free gulab jamun")  
- `consumption_threshold NUMERIC(3,2) NOT NULL CHECK (consumption_threshold BETWEEN 0 AND 1)` (e.g. 0.75)  
- `reward_menu_item_id UUID NOT NULL REFERENCES menu_items(id)`  
- `daily_redemption_cap_per_user INTEGER NOT NULL DEFAULT 1`  
- `is_active BOOLEAN NOT NULL DEFAULT TRUE`  
- `valid_from TIMESTAMPTZ`  
- `valid_until TIMESTAMPTZ`

### 4.2 Meal session tables

**meal\_sessions**

- `diner_user_id UUID NOT NULL REFERENCES users(id)`  
- `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`  
- `table_code TEXT NOT NULL` (the QR code value)  
- `status TEXT NOT NULL CHECK (status IN ('open', 'before_captured', 'eating', 'after_submitted', 'scored', 'pending_staff_validation', 'staff_approved', 'staff_rejected', 'rewarded', 'expired', 'disputed'))`  
- `started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`  
- `expires_at TIMESTAMPTZ NOT NULL` (default: started\_at \+ 4 hours)  
- `client_lat DOUBLE PRECISION` (where diner claimed reward)  
- `client_lng DOUBLE PRECISION`  
- `device_fingerprint TEXT`

**meal\_session\_items** (what was ordered)

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id) ON DELETE CASCADE`  
- `menu_item_id UUID NOT NULL REFERENCES menu_items(id)`  
- `quantity INTEGER NOT NULL DEFAULT 1`  
- `portion_size TEXT CHECK (portion_size IN ('small', 'regular', 'large'))` (declared by diner at order)  
- `notes TEXT`

**plate\_captures**

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id) ON DELETE CASCADE`  
- `phase TEXT NOT NULL CHECK (phase IN ('before', 'after'))`  
- `image_s3_key TEXT NOT NULL`  
- `image_sha256 TEXT NOT NULL`  
- `captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`  
- `client_lat DOUBLE PRECISION`  
- `client_lng DOUBLE PRECISION`  
- `device_fingerprint TEXT`  
- `nonce TEXT NOT NULL` (server-issued, single-use, fraud check)  
- UNIQUE(meal\_session\_id, phase) — one before, one after per session

**consumption\_scores**

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id) ON DELETE CASCADE`  
- `overall_score NUMERIC(4,3) NOT NULL` (0.000 to 1.000)  
- `per_item_scores JSONB NOT NULL` (`[{"menu_item_id": "...", "score": 0.85, "confidence": 0.91}]`)  
- `model_name TEXT NOT NULL` (e.g. "claude-vision-v1", "yolov11-seg-v0.3")  
- `model_version TEXT NOT NULL`  
- `processing_ms INTEGER NOT NULL`  
- `raw_model_output JSONB` (full structured response for debugging)  
- UNIQUE(meal\_session\_id)

**staff\_validations**

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id) ON DELETE CASCADE`  
- `staff_user_id UUID NOT NULL REFERENCES users(id)`  
- `restaurant_id UUID NOT NULL REFERENCES restaurants(id)`  
- `decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'adjusted'))`  
- `model_score NUMERIC(4,3) NOT NULL` (snapshot of the score they reviewed)  
- `final_score NUMERIC(4,3) NOT NULL` (equals model\_score for 'approved', set by staff for 'adjusted', irrelevant for 'rejected')  
- `reason_code TEXT` (required if decision='rejected' or 'adjusted'; see codes below)  
- `notes TEXT` (optional free text)  
- `decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`  
- `decision_latency_ms INTEGER NOT NULL` (time from staff opening review to submitting)  
- UNIQUE(meal\_session\_id)

Reason codes: `plate_not_clean_enough`, `wrong_plate_photographed`, `food_hidden_or_discarded`, `image_quality_issue`, `model_overestimated`, `model_underestimated`, `dispute_with_diner`, `other`.

### 4.3 Reward and fraud tables

**rewards**

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id)`  
- `reward_rule_id UUID NOT NULL REFERENCES reward_rules(id)`  
- `redemption_code TEXT UNIQUE NOT NULL` (8-char human-readable, e.g. "PLATE-X7B2")  
- `issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`  
- `expires_at TIMESTAMPTZ NOT NULL`  
- `redeemed_at TIMESTAMPTZ`  
- `redeemed_by_user_id UUID REFERENCES users(id)` (the staff member who redeemed it)  
- `voided_at TIMESTAMPTZ`  
- `voided_reason TEXT`

**fraud\_signals**

- `meal_session_id UUID REFERENCES meal_sessions(id)`  
- `user_id UUID REFERENCES users(id)`  
- `signal_type TEXT NOT NULL` (see signal types below)  
- `severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'block'))`  
- `details JSONB NOT NULL`

Signal types: `geofence_violation`, `time_between_captures_too_short`, `duplicate_image_hash`, `image_metadata_mismatch`, `score_distribution_anomaly`, `velocity_anomaly`, `manual_flag`.

**disputes**

- `meal_session_id UUID NOT NULL REFERENCES meal_sessions(id)`  
- `raised_by_user_id UUID NOT NULL REFERENCES users(id)`  
- `reason TEXT NOT NULL`  
- `status TEXT NOT NULL CHECK (status IN ('open', 'resolved_in_favor_diner', 'resolved_in_favor_restaurant', 'closed'))`  
- `resolved_by_user_id UUID REFERENCES users(id)`  
- `resolved_at TIMESTAMPTZ`  
- `resolution_notes TEXT`

### 4.4 Indexes (required)

- `meal_sessions(diner_user_id, started_at DESC)` — diner's history  
- `meal_sessions(restaurant_id, status, started_at DESC)` — restaurant ops view  
- `meal_sessions(restaurant_id, status) WHERE status='pending_staff_validation'` — staff validation queue (partial index for hot path)  
- `rewards(redemption_code)` — already unique  
- `rewards(meal_session_id)` — already FK  
- `plate_captures(image_sha256)` — duplicate detection  
- `fraud_signals(user_id, created_at DESC)`

---

## 5\. API contract

Base URL: `/api/v1`. JSON in, JSON out. All authenticated endpoints require `Authorization: Bearer <jwt>`.

### 5.1 Auth

POST   /auth/register              { email, password, display\_name } → { user, token }

POST   /auth/login                 { email, password }              → { user, token }

POST   /auth/otp/request           { phone }                        → { request\_id }

POST   /auth/otp/verify            { request\_id, code }             → { user, token }

GET    /auth/me                                                     → { user }

POST   /auth/logout

### 5.2 Restaurants (public reads, admin writes)

GET    /restaurants                ?lat=\&lng=\&radius\_km=            → \[{ restaurant }\]

GET    /restaurants/:slug                                           → { restaurant }

GET    /restaurants/:id/menu                                        → \[{ menu\_item }\]

POST   /restaurants                (admin)                          → { restaurant }

PATCH  /restaurants/:id            (owner)                          → { restaurant }

### 5.3 Meal sessions (the core flow)

POST   /sessions

       Body: { table\_code, restaurant\_id }

       Returns: { session\_id, expires\_at, before\_capture\_nonce }

       Side effect: status='open', expires\_at=now+4h

POST   /sessions/:id/items

       Body: { items: \[{ menu\_item\_id, quantity, portion\_size, notes? }\] }

       Returns: { session }

       Constraint: only allowed in status='open'

POST   /sessions/:id/captures/before

       Multipart: image (jpeg/png, max 5MB), nonce, client\_lat, client\_lng, device\_fingerprint

       Returns: { capture\_id, image\_s3\_key }

       Constraint: nonce must match issued; status moves to 'before\_captured'

       Geofence check: if client\_lat/lng outside restaurant radius, log fraud\_signal but allow (kitchen capture exempts when staff token is used)

POST   /sessions/:id/captures/after

       Multipart: image, nonce, client\_lat, client\_lng, device\_fingerprint

       Returns: { capture\_id, processing\_status: 'queued' }

       Side effect: enqueues Celery task to score; status='after\_submitted'

       After scoring completes, status moves to 'pending\_staff\_validation' (never directly to 'rewarded')

       A real-time event is pushed to the restaurant dashboard staff channel

GET    /sessions/:id

       Returns: { session, items, captures, score?, reward? }

       Polled by client after submitting after-capture

GET    /sessions/:id/score

       Returns: { score, breakdown, reward? }

       Long-poll friendly; 202 if still processing

POST   /sessions/:id/dispute

       Body: { reason }

       Returns: { dispute\_id }

### 5.4 Rewards

GET    /rewards                    (diner) → \[{ reward }\]      \# diner's own rewards

GET    /rewards/:code              (staff) → { reward, session, score }

POST   /rewards/:code/redeem       (staff) → { reward }        \# marks redeemed

POST   /rewards/:code/void         (staff) → { reward }        \# with reason

### 5.5 Restaurant dashboard

GET    /restaurants/:id/dashboard/summary  ?range=7d → analytics blob

GET    /restaurants/:id/dashboard/sessions ?status=\&from=\&to=

GET    /restaurants/:id/dashboard/disputes ?status=open

POST   /restaurants/:id/reward-rules

PATCH  /restaurants/:id/reward-rules/:rule\_id

### 5.6 Staff validation (the human-in-the-loop)

GET    /restaurants/:id/validations/pending

       (staff) Returns: \[{ session\_id, table\_code, score, score\_age\_seconds,

                          before\_image\_url, after\_image\_url, ordered\_items,

                          model\_notes, model\_confidence, fraud\_signals }\]

       Sorted oldest-first. Polled every 5s by the dashboard, or pushed via SSE/WebSocket.

GET    /sessions/:id/validation-bundle

       (staff) Returns full review payload for one session — same shape as above

               but with signed S3 URLs valid for 15 minutes.

POST   /sessions/:id/validate

       (staff)

       Body: { decision: 'approved' | 'rejected' | 'adjusted',

               final\_score?: number,    // required if decision='adjusted', 0-1

               reason\_code?: string,    // required if decision='rejected' or 'adjusted'

               notes?: string }

       Returns: { session, validation, reward? }

       Side effects:

         \- 'approved': session.status='staff\_approved'; if final\_score \>= threshold, reward issued and status moves to 'rewarded'; otherwise status stays 'staff\_approved' and diner gets a "thanks, no reward this time" message.

         \- 'adjusted': as approved but uses staff's final\_score.

         \- 'rejected': session.status='staff\_rejected'; no reward; diner notified with reason\_code.

       Constraints:

         \- Only staff of this restaurant can call this.

         \- Session must be in status='pending\_staff\_validation'.

         \- Idempotent: a second call with the same decision is a no-op; a conflicting call returns 409\.

POST   /sessions/:id/validate/escalate

       (staff)

       Body: { notes }

       Returns: { session }

       Side effect: status='pending\_staff\_validation' remains but session is tagged

                    'escalated' for manager review. Used when a server is unsure.

### 5.7 Standard error envelope

{

  "error": {

    "code": "GEOFENCE\_VIOLATION",

    "message": "Capture location is outside restaurant geofence.",

    "details": { "distance\_m": 850, "max\_m": 100 }

  }

}

Error codes (non-exhaustive): `INVALID_NONCE`, `SESSION_EXPIRED`, `WRONG_SESSION_STATUS`, `GEOFENCE_VIOLATION`, `DUPLICATE_CAPTURE`, `RATE_LIMITED`, `INSUFFICIENT_PERMISSIONS`, `MODEL_UNAVAILABLE`, `IMAGE_TOO_LARGE`, `IMAGE_INVALID`, `VALIDATION_ALREADY_DECIDED`, `VALIDATION_REQUIRES_FINAL_SCORE`, `VALIDATION_REQUIRES_REASON_CODE`, `NOT_RESTAURANT_STAFF`.

---

## 6\. Vision service spec

### 6.1 Phase 1 implementation

The vision service is a Python module inside `apps/api` (not a separate service yet). It exposes:

async def score\_meal\_session(session\_id: UUID) \-\> ConsumptionScore:

    """Loads before+after captures, runs the model, persists the score."""

Internally, it calls the Anthropic API with both images and a structured-output tool definition:

TOOL\_DEFINITION \= {

    "name": "report\_consumption",

    "description": "Report per-dish consumption analysis from before/after plate images.",

    "input\_schema": {

        "type": "object",

        "required": \["overall\_consumption", "per\_item", "confidence", "notes"\],

        "properties": {

            "overall\_consumption": {

                "type": "number", "minimum": 0, "maximum": 1,

                "description": "Estimated fraction of served food consumed (0=untouched, 1=clean plate)."

            },

            "per\_item": {

                "type": "array",

                "items": {

                    "type": "object",

                    "required": \["dish\_name", "consumption", "confidence"\],

                    "properties": {

                        "dish\_name": {"type": "string"},

                        "consumption": {"type": "number", "minimum": 0, "maximum": 1},

                        "confidence": {"type": "number", "minimum": 0, "maximum": 1}

                    }

                }

            },

            "confidence": {"type": "number", "minimum": 0, "maximum": 1},

            "notes": {

                "type": "string",

                "description": "Any observations: occlusion, lighting issues, suspicious patterns, mismatched dishes."

            },

            "suspicious": {

                "type": "boolean",

                "description": "Set true if the after-image appears unrelated to the before-image, or shows signs of tampering."

            }

        }

    }

}

Prompt template (`apps/api/app/vision/prompts.py`):

You are analyzing two photos of a restaurant plate.

\- Image 1 was taken BEFORE the meal (food as served).

\- Image 2 was taken AFTER the meal (what remains).

The ordered items are:

{ordered\_items\_yaml}

Your task: estimate the fraction of food consumed.

Rules:

\- Distinguish edible food remaining from non-edible residue (bones, shells, peels, sauce smears).

\- Report per-dish consumption when possible; otherwise an overall figure.

\- Confidence reflects image quality, occlusion, and ambiguity, not your model's general capability.

\- Set "suspicious" true if the after-image is clearly a different plate, location, or scene.

\- Be conservative on dish identification — if the after-image is too blurry or off-angle to be sure, lower confidence rather than guessing.

Return only the report\_consumption tool call.

Model: `claude-sonnet-4-5` (or latest Sonnet) for Phase 1 cost balance. Configurable via `VISION_MODEL` env var.

### 6.2 Phase 2 implementation

A separate service in `services/vision/` exposing:

POST /infer

Body: { before\_image\_url, after\_image\_url, expected\_dishes: \[{name, reference\_image\_url?}\] }

Returns: same shape as the Phase 1 tool output

Stack: FastAPI \+ PyTorch \+ Ultralytics YOLOv11-seg or Mask R-CNN. GPU instance. Triton if scaling.

The API doesn't change — only the implementation behind `score_meal_session` swaps out.

### 6.3 Confidence handling

Every scored session goes to staff validation, so the model's confidence affects *how* the case is presented, not *whether* it's reviewed:

- If `confidence >= 0.75` and not `suspicious`: present to staff as a normal validation case with the model's score pre-selected.  
- If `confidence < 0.75`: present with a "Low model confidence" banner. The staff member should look more carefully and is more likely to use 'adjusted'.  
- If `suspicious=true`: present with a red "Possible tampering" banner and the related `fraud_signal` details inline. Create `fraud_signal` with severity `block` so the case is also visible in the fraud queue.  
- If the overall score is below threshold but within 0.1 of it: the staff UI nudges with "diner came close — consider a smaller token reward" but the decision is still theirs.

The model is advisory. The staff member's decision is authoritative and is what gets persisted as `final_score`.

---

## 7\. Fraud and abuse mitigations (must implement in Phase 1\)

These are not optional. Build them as you build the happy path.

1. **Camera-only capture.** The client MUST use `getUserMedia` and submit images directly. The backend rejects any `plate_capture` POST that lacks a valid server-issued nonce.  
2. **Single-use nonces.** Each `POST /sessions` returns a `before_capture_nonce`. After `before` is captured, the response includes an `after_capture_nonce`. Each nonce: server-signed, expires in 15 minutes for before / 30 minutes for after, single use.  
3. **Geofence check.** Both captures must be within `restaurant.geofence_radius_m` of the restaurant's lat/lng. Configurable per restaurant. Default 100m. Violations create `fraud_signal` with severity `warning` (info-only in Phase 1 to learn the false-positive rate; tighten to `block` after 1 month of data).  
4. **Time-window check.** After-capture must be at least 5 minutes after before-capture and at most 4 hours after. Outside: `fraud_signal`.  
5. **Duplicate image hash check.** `image_sha256` indexed; if the same hash appears in two sessions ever, both flagged.  
6. **Perceptual hash continuity.** Background (non-food area of the plate/table) must match between before and after. Use `imagehash.phash` and require Hamming distance ≤ 8\. Run this in the same Celery task that scores; if it fails, set fraud\_signal severity `block`.  
7. **Velocity limits.** Per user: max 3 sessions/day, max 1 reward/restaurant/day, max 10 captures/hour. Returns `RATE_LIMITED` 429\.  
8. **Reward cap.** Per `reward_rule`, `daily_redemption_cap_per_user` enforced atomically (use Redis incr with TTL or a DB advisory lock).  
9. **Mandatory staff validation.** Every after-capture is reviewed by restaurant staff on the dashboard before any reward is issued. This is the strongest single fraud defense. Staff see the before image, the after image, the diner's actual plate at the table, the model's score, and any fraud signals, and approve / adjust / reject. The reward is then redeemed by staff in a second action. Two human checkpoints per reward.  
10. **Score distribution monitoring.** Daily Celery job: for any user whose last 10 scores are all ≥ 0.95, create `fraud_signal` for manual review.

Every fraud check that fires creates a row in `fraud_signals` regardless of whether it blocks. This is the data we use to tune later.

---

## 8\. Ethics rules (must enforce in code, not just docs)

1. **Threshold floor: 70%.** No restaurant can configure a `consumption_threshold > 0.95` or `< 0.50`. DB CHECK constraint \+ API validation. Rationale: a 100% threshold encourages overeating; a 50% threshold is meaningless.  
     
2. **Portion-size declaration.** The order endpoint REQUIRES `portion_size` for every item the restaurant has marked as having multiple sizes. Default offered to the diner is "small". The UI must make small the prominent choice, not large.  
     
3. **No streak gamification.** Do not build streak counters, "X days clean plate" badges, or daily login pressure. Sustainability metrics ("you saved 0.4 kg CO₂e this month") are fine and encouraged.  
     
4. **Minor protection.** Users under 18 cannot sign up. Add age confirmation at registration. If a user reports being a parent ordering for a child, the child does not get an account, the parent does, and the reward is non-transferable.  
     
5. **Opt-out is one tap.** A "delete my data" button in profile that triggers full deletion (anonymize sessions, drop images) within 7 days. This is GDPR / DPDP Act baseline.  
     
6. **Image retention.** Default: 7 days. Configurable per user up to 90 days for those who opt in to "improve the model with my plates". Celery cron runs nightly to purge expired image objects from S3 and clear the `image_s3_key` field.  
     
7. **Body-image-safe copy.** No user-facing copy may reference body, weight, calories, "guilt", "shame", or "you should have finished". UI copy must pass a linter check (`pnpm run lint:copy`) that fails on a deny-list of terms. The deny-list lives in `apps/web/src/lib/copy-lint.ts`.  
     
8. **Staff validation accountability.** Every staff decision is logged with the staff user id, model score, final score, reason code, and decision latency. The restaurant dashboard surfaces per-staff approval-rate and override-rate metrics weekly. If a staff member's rejection rate exceeds 2x the restaurant median for 4 weeks running, an alert is raised for the restaurant owner. This is to catch staff who routinely deny rewards (cost-saving abuse) or routinely approve everything regardless of model score (favoritism / friend collusion). Staff cannot validate their own meal sessions — the API rejects if `staff_user_id == diner_user_id`.  
     
9. **Diner recourse.** If a staff member rejects or adjusts a score, the diner is told the reason (the reason code, translated to plain language) and may raise a dispute. Disputes go to the restaurant owner first, then to platform admin if unresolved within 48 hours. Disputes are tracked in the `disputes` table; the data feeds into the per-staff metrics above.

---

## 9\. Build phases and acceptance criteria

### Phase 1 — Pilot (target: 6 weeks)

Goal: two restaurants, one cuisine, one reward tier, one city. Validate the diner flow and measure waste reduction.

**Deliverables:**

- Monorepo scaffold and CI green  
- Database migrations and seed data for 2 restaurants, 1 staff user each, 20 menu items  
- Auth (email/password \+ phone OTP)  
- The full meal session flow end-to-end with Anthropic-API-based vision  
- Single reward rule per restaurant working  
- **Staff validation flow: pending queue on dashboard, side-by-side before/after image review, approve/adjust/reject actions with reason codes, real-time updates (polling acceptable in Phase 1, SSE in Phase 2\)**  
- Diner-side waiting state UI with copy like "Your server is reviewing — usually under a minute"  
- Restaurant dashboard with: validation queue (primary view), pending redemptions list, sessions table, summary cards  
- Fraud mitigations 1, 2, 3, 4, 5, 7, 9, 10 from section 7 (all except perceptual-hash continuity and score distribution daily job)  
- All ethics rules from section 8, including staff accountability metrics (basic version; the 4-week alert can be Phase 2\)  
- PWA installable on iOS and Android, passes Lighthouse PWA audit  
- One-tap delete account  
- Deployed to Fly.io staging environment

**Acceptance criteria:**

- A diner can complete the full flow (sign up → scan QR → order → before capture → after capture → **staff validation** → reward → redeem) in under 7 minutes including eating time skipped.  
- The score-from-Anthropic round trip is under 8 seconds at p95.  
- The staff validation queue updates within 5 seconds of an after-capture being scored.  
- A staff member cannot validate their own diner account's session (enforced and tested).  
- The geofence check correctly rejects a fake capture from outside the restaurant in tests.  
- 100% of API endpoints have at least one integration test, including all four staff validation outcomes (approved, adjusted, rejected, escalated).  
- README explains how to spin up the whole stack with `pnpm dev` after `pnpm install` and `docker compose up`.

### Phase 2 — Custom model and scale (target: weeks 7–24)

- Data labeling pipeline (Label Studio integration)  
- Migrate vision logic from inline Anthropic-API call to standalone `services/vision`  
- Train and deploy a YOLOv11-seg model fine-tuned on collected restaurant data  
- A/B test the custom model against the LLM baseline; ship whichever wins on accuracy \+ cost  
- Perceptual-hash continuity check (signal 6\)  
- Score distribution daily job (signal 10 hardened)  
- 10 restaurants live  
- Restaurant onboarding self-service (no platform admin needed)  
- Multi-language support: English, Hindi, Marathi (i18n keys complete; translations as available)

### Phase 3 — Production hardening (target: weeks 25–52)

- POS integrations (Petpooja, urbanpiper, etc.)  
- Depth sensor support where available (iOS LiDAR via WebXR depth API behind a feature flag)  
- Anonymous mode (sessions without account creation; reward via SMS)  
- Sustainability reporting for restaurants (monthly PDF: kg waste reduced, kg CO₂e avoided)  
- Public analytics page (aggregate, no PII)

---

## 10\. Environment variables

`.env.example`:

\# Core

NODE\_ENV=development

LOG\_LEVEL=info

\# Database

DATABASE\_URL=postgresql+asyncpg://plate:plate@localhost:5432/plate\_clean

REDIS\_URL=redis://localhost:6379/0

\# Auth

JWT\_SECRET=change\_me\_min\_32\_chars

JWT\_EXPIRY\_HOURS=24

OTP\_PROVIDER=msg91   \# or 'twilio', or 'console' for dev

OTP\_API\_KEY=

\# Object storage

S3\_ENDPOINT=http://localhost:9000   \# MinIO in dev, blank for AWS

S3\_REGION=us-east-1

S3\_BUCKET=plate-clean-images

S3\_ACCESS\_KEY=

S3\_SECRET\_KEY=

\# Vision (Phase 1\)

ANTHROPIC\_API\_KEY=

VISION\_MODEL=claude-sonnet-4-5

VISION\_TIMEOUT\_SECONDS=30

\# Vision (Phase 2\)

VISION\_SERVICE\_URL=http://localhost:8001

VISION\_SERVICE\_TIMEOUT\_SECONDS=15

\# Fraud

GEOFENCE\_DEFAULT\_RADIUS\_M=100

GEOFENCE\_MODE=warn   \# 'warn' or 'block'

MAX\_SESSIONS\_PER\_USER\_PER\_DAY=3

MAX\_CAPTURES\_PER\_HOUR=10

\# Frontend

VITE\_API\_BASE\_URL=http://localhost:8000/api/v1

VITE\_SENTRY\_DSN=

---

## 11\. CI requirements

GitHub Actions workflows:

1. `.github/workflows/ci.yml` — runs on every PR:  
   - `pnpm install`  
   - `pnpm lint` (all apps)  
   - `pnpm typecheck`  
   - `pnpm test`  
   - `pnpm lint:copy` (the ethics deny-list check)  
   - Python: `ruff check`, `mypy`, `pytest --cov`  
   - Build all Docker images (don't push)  
2. `.github/workflows/deploy-staging.yml` — on merge to `main`:  
   - Build and push images  
   - Run Alembic migrations on staging  
   - Deploy to Fly.io staging  
   - Run Playwright smoke tests against staging  
3. `.github/workflows/deploy-prod.yml` — on tag `v*`:  
   - Same as staging plus manual approval gate

---

## 12\. Open decisions to confirm before starting

These were left intentionally undecided. Raise them, don't guess:

- **Payments:** Phase 1 has no payments. Are rewards purely menu items, or do we ever issue cash discounts? Affects whether we need a payments integration.  
- **Multi-tenancy model:** is there one app for all restaurants (we assume yes), or do chains want their own branded PWA? Affects domain/PWA manifest strategy.  
- **POS integration timing:** if a launch restaurant already uses a POS, do we wait for integration or scrape orders manually for the pilot?  
- **Cuisine for pilot:** the prompt examples and menu seed should match the actual pilot cuisine. Default: North Indian. Confirm.  
- **Country for pilot:** affects OTP provider, currency, timezone defaults, legal text. Default: India.

---

## 13\. First-day task list for the agent

Execute these in order. Stop and report after each milestone.

1. Initialize the monorepo: pnpm workspaces, Turborepo, root `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `.prettierrc`, `.eslintrc`.  
2. Create `apps/api` FastAPI project with `pyproject.toml`, basic `main.py`, healthcheck endpoint, and a passing pytest.  
3. Set up `docker-compose.yml` with Postgres 16, Redis 7, MinIO. Verify `docker compose up` brings everything healthy.  
4. Add SQLAlchemy \+ Alembic. Create the migration for tables in section 4\. Run it. Add a seed script that creates 2 restaurants, 1 staff user each, 20 menu items.  
5. Implement auth endpoints (5.1) with email/password and a stubbed OTP that logs to console in dev.  
6. Implement `POST /sessions` and `POST /sessions/:id/items` (5.3 first two endpoints) with full validation.  
7. Implement S3 client wrapper for MinIO, then the two capture endpoints with nonce validation, image hashing, and storage.  
8. Wire up Celery \+ Redis, write the scoring task that calls Anthropic with both images and the tool definition from section 6.1, persists the score, and **transitions the session to `pending_staff_validation`**. The reward is NOT created here — that happens in step 10 after staff approval.  
9. Scaffold `apps/web` with Vite \+ React \+ Tailwind \+ Workbox. Build the camera screen and the session-status screen (which includes a "waiting for staff review" state with polling). Wire to API. Get the diner side of the happy path working in localhost.  
10. Scaffold `apps/dashboard` with two primary screens: (a) the **validation queue** showing pending sessions sorted oldest-first with before/after images side-by-side, score, fraud signals, and approve/adjust/reject buttons with the reason-code modal, and (b) the redemption-code lookup and redeem flow. Implement reward creation as a side effect of approval at score ≥ threshold.  
11. Stop and demo end-to-end: diner signs up, orders, captures before, eats (simulated), captures after, sees "waiting for staff", staff dashboard shows the session, staff approves, diner sees reward code, staff redeems. Then proceed to fraud mitigations and ethics enforcement.

Build it small, build it solid, test as you go.  
