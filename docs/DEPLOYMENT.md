# Deployment

## Local development environment

This is the reproducible path from a clean Windows machine to a working Postgres instance for
this project. It exists so a grader (or a future you, on a new machine) can stand up the exact
environment this project was built against, without guessing.

The target machine profile is **Windows, 4 GB RAM, no Docker** — a deliberate constraint, not a
limitation. See `docs/PROJECT_PROMPT.md` §3.0 and §3.2 for why the whole architecture is built to
need exactly one service (PostgreSQL) and nothing else.

### Prerequisites

- **Node 20+** (this project was built against 22.19)
- **Git**
- **PostgreSQL 16**

Nothing else. No Docker, no Redis, no message broker — every background-job and pub/sub need is
met by PostgreSQL itself (`job_queue` table, `LISTEN`/`NOTIFY`).

### 1. Install PostgreSQL 16

Install PostgreSQL 16 (the official Windows installer from postgresql.org is the simplest path).
During setup:

- You'll be asked for a password for the `postgres` superuser — remember it, it goes into
  `DATABASE_URL` below.
- Accept the default port, `5432`.

The installer registers PostgreSQL as a Windows service (`postgresql-x64-16`). Confirm it's
running: open `services.msc` and check its status, or from an elevated PowerShell:

```powershell
Get-Service postgresql-x64-16
```

### 2. Create the databases

From a terminal with `psql` on `PATH` (the installer adds it):

```
createdb -U postgres ticket_booking
createdb -U postgres ticket_booking_test
```

Two databases, not one: `ticket_booking` is the application database. `ticket_booking_test` is a
second, real Postgres database that the test suite truncates between runs — the concurrency proof
suite (§6.6 of `docs/PROJECT_PROMPT.md`) needs actual row locks, which a mocked database can't
provide, so tests run against a real instance instead of a mock.

### 3. Tune `postgresql.conf` for a 4 GB machine

Locate the config file — on a default Windows install this is
`C:\Program Files\PostgreSQL\16\data\postgresql.conf` — and set:

```
shared_buffers = 128MB
max_connections = 50
work_mem = 4MB
```

Why these specific values, not Postgres's stock defaults:

- **`shared_buffers = 128MB`** — Postgres's shared memory cache for data pages. The stock default
  scales with detected system RAM; left alone on a 4 GB machine it can claim more memory than this
  project can afford to give up to a background service while a dev server, Vite, and a browser
  are also running. 128MB is enough for a seed dataset of ~200-seat venues (§3.4) without starving
  everything else.
- **`max_connections = 50`** — each connection slot costs real memory whether or not it's in use.
  This project's own pool (`pg.Pool`, `server/src/db/pool.js`) is capped at 10 (see
  `PGPOOL_MAX` in `.env.example`), so 50 total leaves headroom for `psql`, the dedicated `LISTEN`
  client, and manual debugging connections without over-provisioning.
- **`work_mem = 4MB`** — per-sort/per-hash memory, multiplied by however many such operations a
  query plan needs concurrently. This project's queries are simple and indexed (see
  `docs/DB_SCHEMA.md`), so the stock default here already matches the target — nothing to change.

`shared_buffers` and `max_connections` both require a **full restart** to take effect (a config
reload is not enough — they're allocated at server startup). From an **elevated** PowerShell (a
standard user session can edit the config file but cannot stop or start a Windows service):

```powershell
Restart-Service postgresql-x64-16
```

### 4. Authentication

The Windows installer defaults `pg_hba.conf` to `scram-sha-256` password authentication for all
local connections — there's nothing to change here. Unlike Unix, Windows has no peer/socket trust
shortcut for local Postgres connections, so every tool (`psql`, the app, migrations) authenticates
with the password you set in step 1.

### 5. Configure `DATABASE_URL`

```
DATABASE_URL=postgresql://postgres:<your-password>@localhost:5432/ticket_booking
```

This goes in `.env` at the **repo root**, created from `.env.example` (added in P0-5) — not
`server/.env`. `server/src/config/env.js` loads it from there. `client/index.html` (D-53) needs no
env file of its own — it's a static file served by this same server, with no build step and no
`VITE_*`-style variables to configure.

### 6. Install dependencies

From the repo root:

```
npm install
```

This installs and symlinks the `server`/`shared` npm workspaces in one pass — see P0-1 in
`docs/BUILD_LOG.md`. `client/` is a plain static directory (D-53), not a workspace — nothing there
to install.

### 7. Verify

There's no server to boot yet at this stage of the build (that starts at P0-4), so "verify the
environment" means confirming Postgres itself is correctly configured and reachable:

```
psql -U postgres -c "SHOW shared_buffers;" -c "SHOW max_connections;"
psql -U postgres -l
```

The first command should report `128MB` and `50`. The second should list both `ticket_booking`
and `ticket_booking_test` among the databases.

---

## Production deployment (Render)

One service to deploy, not two — D-53 already collapsed the client into `client/index.html`,
served by the same Express process (`express.static`), so there is no separate frontend deploy
target the way the original React/Vite plan (docs/PROJECT_PROMPT.md §3.1) would have needed. The
Blueprint at `render.yaml` (repo root) provisions both pieces this needs: the web service and a
managed Postgres database. This section is the click-through steps around it — the parts that
have to happen in a browser, not in code.

### 1. Push to GitHub

Render deploys from a Git repository it can see. This repo already has a GitHub remote
(`origin`) — confirm `phase/4-booking-qr` (the branch `render.yaml` deploys, see its own comment)
is pushed and current:

```
git push origin phase/4-booking-qr
```

### 2. Create a Render account

[render.com](https://render.com) → sign up (GitHub OAuth is the fastest path, and it's also what
step 3 needs anyway to grant Render read access to the repo). No credit card required for the
`free` plan tiers this Blueprint uses.

### 3. New Blueprint

Render dashboard → **New +** → **Blueprint** → select this repo. Render reads `render.yaml` from
the repo root and shows a preview of what it's about to create: one Web Service
(`ticket-booking-system`) and one PostgreSQL database (`ticket-booking-db`). Confirm — it
provisions both, wires `DATABASE_URL` from the database to the service automatically
(`fromDatabase` in `render.yaml`), and generates real random values for `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`, and `QR_SIGNING_SECRET` (`generateValue: true`) — nothing to type in by hand.

The **first deploy will fail its health check** for one reason, expected and explained below: the
Postgres database and the web service provision in parallel, and the web service's own
`startCommand` runs migrations against it. If the database isn't fully ready the instant the first
deploy attempts to connect, that attempt fails; Render's automatic retry on the next push (step 5)
succeeds once the database has settled. Don't chase this as a bug on a first-ever deploy.

### 4. Set `API_URL` and `WEB_URL` (the one manual step)

`render.yaml` deliberately leaves these two `sync: false` — Render only assigns this service's
public URL (`https://ticket-booking-system-XXXX.onrender.com`, the suffix is random) once the
service exists, so there's no way to write the real value into `render.yaml` ahead of time. After
the first deploy:

1. Open the web service in the Render dashboard — its URL is shown at the top.
2. **Environment** tab → add `API_URL` and `WEB_URL`, both set to that exact URL (no trailing
   slash).
3. Save — Render redeploys automatically with the new values.

Until this is done, the app still boots (env.js's own `http://localhost:3000` defaults are valid
URLs, just wrong ones for this deployment — see Decisions Ledger D-56), but CORS will reject
browser requests from the real deployed origin, and any waitlist-offer email's claim link will
point at `localhost`, not the live URL.

### 5. Verify

- `https://<your-service>.onrender.com/health` → `{"success":true,"data":{"status":"ok"},...}`
- `https://<your-service>.onrender.com/` → the seat-map client loads, `GET /events` shows the two
  demo events `seed.js#seedDemoCatalogue()` creates automatically on first boot (see `render.yaml`'s
  `startCommand` comment for why migrate+seed run on every deploy, not just once).
- Log in as `customer@ticketbooking.test` / `Password123!` (same demo credentials as local dev,
  `server/src/db/seed.js`) and run the hold → confirm → QR flow for real.
- **Render's free web-service tier spins the instance down after ~15 minutes idle** and takes
  30-60s to wake on the next request — the very first request after a quiet period will time out
  or hang in a browser before the cold start finishes. This is a platform limit, not an app bug;
  see the Risk register's "Free-tier host sleeps" row in `docs/BUILD_LOG.md`. `DEMO.md` (P10-7,
  not yet built) should warn a grader about it explicitly.

### What's intentionally NOT configured

- **Real SMTP.** `SMTP_HOST` stays unset in `render.yaml` on purpose — `mail/mailer.js` treats an
  empty `SMTP_HOST` as "use Ethereal" regardless of `NODE_ENV`, so every email this app sends
  still genuinely renders and sends; a grader reads the Ethereal preview URL from this service's
  Render log stream instead of a real inbox. Wire a real provider (Brevo, Resend, ...) only for an
  actual production deployment, not a graded demo.
- **A custom domain.** The `onrender.com` subdomain is fine for grading; Render's own docs cover
  adding one if this ever becomes a real deployment.
- **Render's paid tiers.** `free` on both the web service and the database keeps this at $0/month,
  at the cost of the cold-start behavior noted above and Render's free Postgres databases expiring
  after 90 days of inactivity (a genuine limit worth knowing about, not something this Blueprint
  can configure around).
