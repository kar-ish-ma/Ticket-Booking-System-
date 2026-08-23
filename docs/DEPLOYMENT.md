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
`server/.env`. `server/src/config/env.js` loads it from there, since there's currently only one
thing in this monorepo that needs environment variables; a separate `client/.env` for Vite's own
`VITE_*`-prefixed vars is a P7-1 concern. Never commit `.env` — it's excluded by `.gitignore`.

### 6. Install dependencies

From the repo root:

```
npm install
```

This installs and symlinks all three npm workspaces (`server`, `client`, `shared`) in one pass —
see P0-1 in `docs/BUILD_LOG.md`.

### 7. Verify

There's no server to boot yet at this stage of the build (that starts at P0-4), so "verify the
environment" means confirming Postgres itself is correctly configured and reachable:

```
psql -U postgres -c "SHOW shared_buffers;" -c "SHOW max_connections;"
psql -U postgres -l
```

The first command should report `128MB` and `50`. The second should list both `ticket_booking`
and `ticket_booking_test` among the databases.
