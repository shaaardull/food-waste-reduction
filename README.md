# Plate-Clean Rewards

A progressive web app that rewards restaurant diners for finishing their meals. A vision model
estimates how much was consumed; a staff member at the restaurant approves before any reward is
issued. See [`CLAUDE.md`](./CLAUDE.md) for the full build specification.

> Two human checkpoints per reward: staff approval after the after-photo, and staff redemption when
> the code is presented. The model is an assistant, not the authority.

## Repository layout

```
plate-clean/
├── apps/
│   ├── web/         # Diner PWA (Vite + React + Tailwind + Workbox)
│   ├── dashboard/   # Restaurant + admin dashboard (Vite + React + Tailwind)
│   └── api/         # FastAPI backend (Python 3.12)
├── packages/
│   ├── shared-types/   # TypeScript types shared across apps
│   └── eslint-config/  # Shared ESLint config
├── infra/
│   └── docker/      # docker-compose for local dev
├── .github/workflows/
└── CLAUDE.md        # Canonical build spec
```

## Running locally (one command)

If you have Postgres + Redis already running locally (Homebrew is fine — `brew services start postgresql@15 redis`), the fastest path is:

```bash
# First-time setup (do once)
psql -h localhost -d postgres -c "CREATE USER plate WITH PASSWORD 'plate' CREATEDB; CREATE DATABASE plate_clean OWNER plate;"
(cd apps/api && python3 -m venv .venv && ./.venv/bin/pip install --ignore-requires-python -e ".[dev]" && ./.venv/bin/alembic upgrade head && ./.venv/bin/python -m app.scripts.seed)
(cd services/vision && python3 -m venv .venv && ./.venv/bin/pip install --ignore-requires-python -e ".[dev]")
pnpm install

# Boot everything
./scripts/dev.sh
```

`scripts/dev.sh` checks prerequisites, downloads MinIO to `~/bin` if missing, then boots all five processes (MinIO, services/vision, apps/api, Celery worker, both Vite frontends) with prefixed log streams. Ctrl-C tears the whole thing down.

URLs once it's up:

- **Diner PWA** — http://localhost:5173
- **Staff dashboard** — http://localhost:5174
- **API docs** — http://localhost:8000/docs
- **Vision service docs** — http://localhost:8001/docs
- **MinIO console** — http://localhost:9001 (login: `minioadmin` / `minioadmin`)

Seeded logins (all password `plate-clean-demo`):

| email | role |
| --- | --- |
| `diner@example.com` | diner |
| `staff1@example.com` | staff (manager) @ Spice Trail |
| `staff2@example.com` | staff (manager) @ Konkan Kitchen |
| `admin@example.com` | platform admin (sees the Onboard wizard) |

90-second tour after `./scripts/dev.sh`:

1. Diner PWA → sign in as `diner@example.com`.
2. Pick a restaurant, type a table code like `T-01`, place an order.
3. Take the before photo with your device camera.
4. (Simulate eating.) Tap "Claim", take the after photo.
5. Switch to the dashboard, sign in as `staff1@example.com`, pick the same restaurant.
6. The session appears in the **Validation queue** — review the before/after images and Approve.
7. Back in the diner PWA → pick how you'd like the reward (free dish vs bill discount) → redemption code appears.
8. In the dashboard → **Redeem code** → paste the code → Mark redeemed.

## Running via Docker (alternative)

If you'd rather not install Python + Node natively:

```bash
cp .env.example .env
# edit .env: set JWT_SECRET (32+ chars) and (optional) ANTHROPIC_API_KEY
docker compose -f infra/docker/docker-compose.yml up -d
docker compose -f infra/docker/docker-compose.yml exec api python -m app.scripts.seed
pnpm install
pnpm dev    # runs web + dashboard
```

## Useful commands

```bash
# Backend
pnpm --filter @plate-clean/api dev          # uvicorn with reload
pnpm --filter @plate-clean/api migrate      # alembic upgrade head
pnpm --filter @plate-clean/api seed         # demo data
pnpm --filter @plate-clean/api test         # pytest

# Lints
pnpm lint                                   # ESLint
pnpm lint:copy                              # ethics deny-list check
pnpm typecheck                              # tsc -b across the workspace

# Playwright smoke (diner PWA)
pnpm --filter @plate-clean/web test:e2e:install   # one-time browser download
pnpm --filter @plate-clean/web build              # build the bundle
pnpm --filter @plate-clean/web test:e2e           # boots `vite preview` and runs e2e/*.spec.ts
```

## Deploying to staging

`/.github/workflows/deploy-staging.yml` deploys to Fly.io on every push to
`main`. Before the first run, set these repo secrets in GitHub:

| secret | what it is |
| --- | --- |
| `FLY_API_TOKEN` | output of `fly auth token` for the deploy bot |
| `STAGING_DATABASE_URL_SYNC` | psycopg URL to the staging Postgres — the migrate job uses it |
| `STAGING_BASE_URL` | `https://…` of the staging diner PWA — Playwright runs against it after the deploy |

The workflow expects four Fly apps to exist (create once with `fly launch`):

- `plate-clean-api-staging`
- `plate-clean-vision-staging`
- `plate-clean-web-staging`
- `plate-clean-dashboard-staging`

## Phase 1 status

What's wired up in this scaffold (see CLAUDE.md §9 for the full deliverable list):

- ✅ Monorepo + Turborepo + workspace packages
- ✅ FastAPI backend with the section-4 schema (Alembic migration `0001_initial_schema`)
- ✅ Auth: email/password + phone OTP (console provider in dev)
- ✅ Meal session lifecycle, capture endpoints with single-use nonces, geofence + duplicate-hash + velocity fraud signals
- ✅ Anthropic vision module + Celery scoring task that hands off to staff validation
- ✅ Staff validation endpoints + dashboard UI (queue, before/after review, approve/adjust/reject/escalate)
- ✅ Reward issuance gated by staff approval, redemption + void flows
- ✅ Diner PWA: scan/order/capture/wait-for-staff/redemption screens, Workbox PWA manifest
- ✅ Copy-lint deny list (ethics rule 7) and code-level enforcement of the threshold floor (rule 1)
- ✅ docker-compose, GitHub Actions CI
- ✅ Perceptual-hash continuity check in the scoring task (fraud signal #6)
- ✅ Daily score-distribution anomaly Celery beat job (fraud signal #10)
- ✅ Weekly staff metrics with 4-week 2× median alert (ethics rule 8 rolling alert)
- ✅ Standalone `services/vision` microservice with pluggable backends — Phase 2 §6.2
- ✅ Real YOLOv8/v11-seg backend (`VISION_BACKEND=yolo`) — COCO-class food/container segmentation + LAB-space food-pixel coverage. See [`services/vision/README.md`](./services/vision/README.md).
- ✅ Label Studio data-labelling pipeline — export/import CLIs + labelling config XML + tracking table for fine-tuning the YOLO backend on real restaurant food. See [`services/vision/labeling/README.md`](./services/vision/labeling/README.md).
- ✅ Self-service restaurant owner onboarding — `POST /api/v1/onboard/restaurant` + `/onboard` dashboard screen. A stranger can sign up as the owner of a brand-new restaurant and finish menu/reward/staff setup without a platform admin.
- ✅ **72 tests passing** across `apps/api` + `services/vision`; ruff clean
- ✅ **End-to-end live smoke verified**: diner signup → before/after capture (MinIO) → Celery picks up `vision.score_meal_session` → services/vision fetches signed URLs from MinIO → stub backend returns 0.8 → ConsumptionScore persisted → staff approves → reward `PLATE-XXXX` → staff redeems. Logs confirm every hop.

## Locked-in product decisions

See CLAUDE.md §12 for the full text. Summary of the five Phase 1 decisions:

- **Reward type** — Diner picks `menu_item` (free dish) or `bill_discount` (same value off next bill at the same restaurant) at claim time. No UPI payouts in Phase 1.
- **Reward validity** — Day 0–15: full value. Day 16–30: half value. Day 31+: expired. `POST /rewards/:code/choose-type` lets the diner switch type before redemption.
- **Multi-tenancy** — Single app at `plate-clean.app`, restaurant-scoped theming loaded per restaurant slug.
- **POS integration** — Manual entry via the in-app menu for the pilot. POS integrations (Petpooja / urbanpiper) deferred to Phase 3.
- **Cuisine** — North Indian + coastal Konkan (matches the seed).
- **Country** — India: INR, Asia/Kolkata, msg91 OTP in prod (console in dev), DPDP Act privacy text.
