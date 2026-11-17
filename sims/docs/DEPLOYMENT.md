# Deployment

SIMS ships as **one container image** (the API *and* the built web app) plus PostgreSQL. The API serves the web
app itself, so users reach everything on one origin: no CORS to configure, and the refresh-token cookie is first-party.

```
browser ──https──▶ reverse proxy (TLS) ──http──▶ app :4000 ──▶ PostgreSQL 14+
                                                   └─ /app/backend/uploads  (volume: certificates, photos)
```

## 1. Quick start with Docker Compose

Needs Docker with the Compose plugin. (The Dockerfile and compose file validate with `docker compose config`, but the
image itself has not been built by the author yet — if the first build fails, that is a bug to report, not your setup.)

```bash
cp .env.example .env
```

Edit `.env` and set the two required values (compose refuses to start without them):

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"      # → DB_PASSWORD
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" # → JWT_ACCESS_SECRET
```

```bash
docker compose up -d --build
docker compose ps            # app should become "healthy"
```

Open `http://localhost:8080`. For a plain-http trial on your own machine set `COOKIE_SECURE=false` in `.env` first,
otherwise the browser will not keep the sign-in cookie (see §3).

On first start the container creates the schema and loads the catalogue (skills, roles, courses, badges). On later
starts it leaves your data alone and only refreshes the catalogue (idempotent).

**The first account.** There are no built-in users. Open the app → *Create an account* → **University Head**: that
creates the university and its University Key. Colleges, instructors and students then join with keys
(University → College → Class → Student). For a throw-away demo with sample data instead:

```bash
docker compose exec -e ALLOW_DEMO_SEED=yes app node scripts/seed-demo.js
```

The demo accounts use a **published password** — never do this on a real deployment. The seed refuses to run when
`NODE_ENV=production` unless you pass `ALLOW_DEMO_SEED=yes`.

## 2. Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — (required) | PostgreSQL connection string. Compose builds it from `DB_PASSWORD`. |
| `JWT_ACCESS_SECRET` | — (required) | ≥ 32 characters. In production the server **refuses to start** if it still looks like the placeholder from `.env.example`. Rotating it signs everyone out of their current access token (refresh cookies keep working). |
| `NODE_ENV` | `development` | Must be `production` when deployed (the image sets it). |
| `PORT` | `4000` | Port inside the container. |
| `APP_URL` | `http://localhost:5173` | Public address of the web app; used in password-reset links. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated browser origins allowed to call the API. With the bundled web app this is just your public URL. |
| `TRUST_PROXY` | `0` | Number of proxies in front of the app. **Set to `1` behind one proxy**, otherwise every user shares the proxy's IP and the rate limits and key lock-outs hit everyone at once. |
| `COOKIE_SECURE` | `true` in production | `Secure` flag on the refresh cookie, and the CSP `upgrade-insecure-requests` / HSTS headers. Keep `true` behind https; `false` only for a plain-http trial. |
| `FRONTEND_DIST` | built-in path in production | Folder with the built web app; `off` serves the API only (e.g. if you host the SPA on a CDN — then `CORS_ORIGIN` must list that origin and the cookie needs `SameSite` consideration). |
| `ACCESS_TOKEN_TTL` | `15m` | Access-token lifetime. |
| `REFRESH_TOKEN_TTL_DAYS` | `14` | Sign-in lifetime without activity. |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost (4–15). |
| `KEY_MAX_FAILED_ATTEMPTS` | `10` | Wrong key guesses (per IP or account) in 15 minutes before a lock-out. |

## 3. HTTPS and a reverse proxy

Terminate TLS in front of the app. With **Caddy** (automatic certificates):

```
sims.example.edu {
    reverse_proxy app:4000
}
```

or **nginx**:

```nginx
location / {
    proxy_pass http://app:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 6m;            # certificate uploads are limited to 5 MB
}
```

Then in `.env`: `APP_URL=https://sims.example.edu`, `TRUST_PROXY=1`, `COOKIE_SECURE=true`.

**"I sign in but get thrown back to the login page"** is almost always `COOKIE_SECURE=true` while the site is opened
over plain `http://` (the browser drops a Secure cookie), or a missing `TRUST_PROXY` behind a proxy. Browsers treat
`localhost` as secure, so `http://localhost:8080` works even with `COOKIE_SECURE=true`; `http://192.168.x.x` does not.

## 4. Data, backups and upgrades

State lives in two places: the **database** and the **uploads volume** (certificate PDFs, photos). Back up both.

```bash
# database (custom format: restore with pg_restore)
docker compose exec -T db pg_dump -U sims -Fc sims > sims-$(date +%F).dump
# uploads
docker run --rm -v sims_uploads:/data -v "$PWD":/out alpine tar czf /out/uploads-$(date +%F).tgz -C /data .

# restore into an empty database
docker compose exec -T db pg_restore -U sims -d sims --clean --if-exists < sims-2026-11-16.dump
```

(The volume is named `<project>_uploads`; check with `docker volume ls`.) A database dump without the uploads
volume leaves certificate records whose files are missing, and vice versa — restore them together.

**Upgrading the app:** `git pull && docker compose up -d --build`. Existing data is untouched.

**Schema changes.** `database/schema.sql` is a single baseline and **there is no migration runner yet**
(`database/migrations/` is empty). The loader refuses to touch an existing schema, so a release that changes tables
needs a hand-written SQL file applied with `psql` before the new image starts. Before relying on SIMS for long-lived
data, adopt a migration tool (node-pg-migrate, Flyway, Atlas…) and move the baseline into it.

**Housekeeping** runs by itself: expired refresh and reset tokens are deleted at start-up and every six hours.

## 5. Health checks and logs

| Endpoint | Meaning | Use for |
|---|---|---|
| `GET /api/v1/health` | the process is up | liveness |
| `GET /api/v1/health/ready` | up **and** the database answers (a bare 503 otherwise, no details) | readiness / load-balancer checks; the image's `HEALTHCHECK` |

Logs go to stdout/stderr (`docker compose logs -f app`). The audit trail of *business* events (approvals, data changes,
exports) is in the database: `audit_logs`, shown in each dashboard's Reports & audit page.

## 6. Scaling and known operational limits

- **One app instance is the supported shape.** Rate limits are held in each process's memory, so with several instances
  every limit is multiplied; the key lock-out counters are in the database and are shared. To run more than one
  instance, give the rate limiter a shared store (e.g. Redis) first.
- **Uploads are on local disk.** Several instances need a shared volume, or move `utils/upload.js` to S3/GCS. Deleting a
  record does not delete its file.
- **E-mail is a stub** (`utils/mailer.js` logs the message): password-reset links are not actually sent until a real
  mail transport is wired in. Notifications are polled every 60 s, not pushed.
- **Aggregates are computed live** per request (no snapshot cache); fine for thousands of students, plan caching beyond that.

## 7. Security checklist before going live

- [ ] `JWT_ACCESS_SECRET` and `DB_PASSWORD` are unique random values, not shared and not in git (`.env` is git-ignored).
- [ ] The site is served over **https only**; `COOKIE_SECURE=true`; `APP_URL` is the https address.
- [ ] `TRUST_PROXY` matches your proxy chain.
- [ ] The database port is **not** published to the internet (compose does not publish it).
- [ ] No demo data (`head@demo.sims.test` …) exists in the database.
- [ ] Backups are scheduled **and a restore has been tried**.
- [ ] **Anyone who can reach the sign-up page can create a new University (as its head).** That is the multi-tenant
      design (one deployment, many universities), but for a single-institution install restrict the sign-up page at
      the proxy or add an invitation step.
- [ ] Review the CSP in `backend/src/app.js` if you add external scripts, fonts or images — the policy allows only
      the app's own origin (plus `data:`/`blob:` images).
- [ ] Keep the base images and npm dependencies patched (CI runs `npm audit` on production dependencies).

What the app already does: bcrypt password hashing, short-lived access tokens + rotating httpOnly refresh cookies with
reuse detection, role-based access with per-request scoping (a foreign id is a 404), helmet security headers and a
strict CSP, rate limits on sign-in / refresh / key redemption, persistent key lock-outs, uploads validated by their real
file type and de-duplicated by SHA-256, CSV exports neutralised against spreadsheet formulas, and an audit log.
