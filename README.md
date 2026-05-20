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

## Quick start (Phase 1)

### 1. Prerequisites

- Docker & Docker Compose (for Postgres / Redis / MinIO)
- Node 20+ and pnpm 9+ (`corepack enable && corepack prepare pnpm@9.12.0 --activate`)
- Python 3.12 (only required for running the API outside Docker)
- An Anthropic API key (the vision model in Phase 1 is Claude Sonnet)

### 2. Configure environment

```bash
cp .env.example .env
# edit .env and set:
#   JWT_SECRET             (32+ characters)
#   ANTHROPIC_API_KEY      (from https://console.anthropic.com)
```

### 3. Bring the stack up

```bash
docker compose -f infra/docker/docker-compose.yml up -d
```

This starts Postgres, Redis, MinIO, the API (with Alembic migrations applied), and a Celery worker.

Seed two restaurants, one staff user each, twenty menu items, and one demo diner:

```bash
docker compose -f infra/docker/docker-compose.yml exec api python -m app.scripts.seed
```

Seeded credentials (dev only — `plate-clean-demo` password for all):

| email | role |
| --- | --- |
| `diner@example.com` | diner |
| `staff1@example.com` | staff @ Spice Trail |
| `staff2@example.com` | staff @ Konkan Kitchen |

### 4. Run the frontends

```bash
pnpm install
pnpm --filter @plate-clean/web dev          # http://localhost:5173
pnpm --filter @plate-clean/dashboard dev    # http://localhost:5174
```

Or run everything in parallel with Turbo:

```bash
pnpm dev
```

### 5. Walk the flow

1. Diner PWA → sign up or log in as `diner@example.com`.
2. Pick a restaurant, type a table code, place an order.
3. Take the before photo with your device camera.
4. (Simulate eating.) Tap "Claim", take the after photo.
5. Switch to the dashboard, sign in as `staff1@example.com`, pick the same restaurant.
6. The session appears in the **Validation queue** — review the before/after images and Approve.
7. The diner sees a redemption code. Paste it into the dashboard's **Redeem code** screen to mark redeemed.

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
```

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
