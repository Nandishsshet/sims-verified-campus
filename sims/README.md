# SIMS — Student Information Management System

University → College → Class → Student, with key-based onboarding, instructor verification, and role-scoped dashboards.

## Status

| Phase | Status |
|---|---|
| 1 Architecture, schema, ER, API, scoring | ✅ done |
| 2 Backend: auth, keys, joining flow, RBAC | ✅ done |
| 3 Student dashboard (React SPA + student API, resume builder, skill gap) | ✅ done |
| 4 Class / instructor dashboard (verification center, data entry + CSV import, analytics, leaderboard, class life) | ✅ done |
| 5 College dashboard (department scores, instructor management, college analytics, alerts, events & announcements, exports) | ✅ done |
| 6 University dashboard (college approvals, college / department / student leaderboards, cross-college analytics, alerts & insights, announcements, exports & audit) | ✅ done |
| 7 Seed data, testing, deployment (Docker image + compose, production serving, CI, health checks, deployment and testing guides) | ✅ done — image build not yet run, see [docs/TESTING.md](docs/TESTING.md) |

## Docs

| File | What |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, roles, scoping, key system, verification workflow, folder structure, decisions |
| [docs/ER_DIAGRAM.md](docs/ER_DIAGRAM.md) | Mermaid ER diagrams |
| [docs/API.md](docs/API.md) | Full endpoint list (Phases 2–6 implement §1–§6; see the implementation notes under §3, §4, §5 and §6) |
| [docs/SCORING.md](docs/SCORING.md) | Every formula |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker Compose, every setting, HTTPS / proxy, backups, upgrades, security checklist |
| [docs/TESTING.md](docs/TESTING.md) | What every test file covers, what is not covered, manual acceptance checklist |
| [database/schema.sql](database/schema.sql) | PostgreSQL 14+ schema |

## Quick start — full app with demo data (no Docker, no installed Postgres)

Needs Node 18+ (developed on Node 22). Use three terminals:

```bash
# 1 — database: a persistent embedded PostgreSQL on :54330 (schema + catalogue are created on first run)
cd backend && npm install && npm run dev:db

# 2 — API on :4000, then load the demo university once
cd backend && cp .env.example .env     # already points at the embedded DB; set JWT_ACCESS_SECRET
npm start
npm run seed:demo                       # in a third shell, API must be running

# 3 — web app on :5173 (proxies /api to :4000)
cd frontend && npm install && npm run dev
```

Open http://localhost:5173 and sign in (password for all demo accounts: `Demo@12345`):

| Role | Email |
|---|---|
| Student (has a backlog, low CS302 attendance, pending items) | `student@demo.sims.test` |
| Class instructor | `instructor@demo.sims.test` |
| Second instructor (Electronics class: low attendance, stale verifications) | `instructor2@demo.sims.test` |
| College admin (one instructor request is waiting for approval) | `college@demo.sims.test` |
| University head (one college is waiting for approval) | `head@demo.sims.test` |
| Second college's admin (Lakeside, approved, 2024 batch) | `college2@demo.sims.test` |
| Third college's admin (Riverside, left **pending** for the head to approve) | `college3@demo.sims.test` |
| Lakeside's instructor | `instructor3@demo.sims.test` |

All four dashboards (student, instructor, college, university) are complete. The demo university has two active colleges with different strengths and one pending registration, so the University screens have something to rank and compare.

Already seeded before Phase 5 or 6? Just run `npm run seed:demo` again — it detects the existing data and only adds whichever extras are missing (Electronics department, then the Lakeside / Riverside colleges).

> **Database encoding:** the dev database must be UTF-8 (student names in any script). `npm run dev:db` now forces this. If you created `backend/.pgdata-dev` with an earlier build (it defaulted to WIN1252 on Windows), stop it, delete that folder, start `dev:db` again and re-run `npm run seed:demo`. For your own Postgres use `CREATE DATABASE sims ENCODING 'UTF8'`.

## Deploy (Docker)

```bash
cp .env.example .env        # set DB_PASSWORD and JWT_ACCESS_SECRET (the file explains how to generate them)
docker compose up -d --build
```

One image serves the API **and** the built web app on `http://localhost:8080`, with PostgreSQL and an uploads volume.
Behind real HTTPS set `APP_URL`, `TRUST_PROXY=1` and keep `COOKIE_SECURE=true`. Full guide, settings, backups and
the go-live security checklist: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Run the backend against your own PostgreSQL

Prerequisites: Node 18+ (developed on Node 22), PostgreSQL 14+ with the `citext` and `pgcrypto` extensions (both ship with standard Postgres).

```bash
cd backend
npm install
cp .env.example .env          # then edit DATABASE_URL and set JWT_ACCESS_SECRET
createdb sims                 # or create the database however you like
npm run db:init               # loads ../database/schema.sql
npm run dev                   # http://localhost:4000/api/v1/health
```

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

No local Postgres? A throw-away one in Docker:

```bash
docker run --name sims-db -e POSTGRES_PASSWORD=sims -e POSTGRES_DB=sims -p 5432:5432 -d postgres:16
```

## Tests

```bash
npm test                    # 105 unit tests (scoring, ATS, roadmap, keys, tokens, RBAC, validation, CSV, risk, college and university roll-ups, HTTP, static serving + production guards)
npm run test:integration    # 92 end-to-end tests (onboarding flow + the student, instructor, college and university APIs, operations) on a temporary embedded PostgreSQL
```

`test:integration` needs no Docker or installed Postgres: it downloads an embedded Postgres binary (dev dependency), loads `schema.sql` into a temp directory, runs the tests, and deletes everything. To use your own empty database instead:

```bash
TEST_DATABASE_URL=postgresql://user:pass@localhost/empty_db node --test tests/integration/*.test.js
```

## Try the flow by hand

```bash
API=http://localhost:4000/api/v1
J='content-type: application/json'

# 1. University head → University Key
curl -s -X POST $API/auth/signup/university-head -H "$J" -d '{
  "fullName":"Dr Rao","email":"vc@uni.test","password":"Passw0rd1",
  "university":{"name":"Demo University"}}'
# → { accessToken, user, university, universityKey: "UNI-XXXX-XXXX" }

# 2. College admin joins with that key → college is "pending"
# 3. Head approves:  POST /university/colleges/:id/approve  → collegeKey
# 4. Instructor signs up with the College Key; admin approves; instructor POST /classes → classKey
# 5. Student signs up, POST /join/class {classKey}; instructor approves
```
`backend/tests/integration/flow.test.js` contains every one of these calls with the exact request bodies.

## What Phase 2 implements

- **Auth:** 4 role signups, login, rotating refresh tokens (httpOnly cookie, reuse detection), logout, forgot/reset password, change password, `/me`.
- **Keys:** generation (`UNI-/COL-/CLS-XXXX-XXXX`), regenerate, revoke, expiry, max-uses, usage logs, uniform error + persistent lockout.
- **Joining:** college → university key, instructor → college key, student → class key; all create *pending* memberships.
- **Approvals:** university head approves/suspends/reinstates colleges (College Key issued on approval); college admin approves/rejects/removes instructors; instructor approves/rejects/removes students.
- **RBAC + scope:** `protect` (JWT + DB-resolved scope), `requireRole`, `requireApprovedInstructor`, `requireActiveCollege`, `requireOwnClass` (404 for foreign ids).
- **Cross-cutting:** audit log rows and in-app notifications for every state change, helmet, CORS allow-list, rate limits, zod validation, consistent JSON errors.

## What Phase 3 implements

- **Student API** (`/student/*`): dashboard, profile + photo, attendance (calendar, can-miss calculator, claims), academics (SGPA/CGPA, backlogs, GPA predictor, marks claims), certificates (upload, SHA-256 de-dupe, magic-byte checks, QR verification via public `/verify/:code`), projects/internships/publications, skills, skill-gap + roadmap + history, placement readiness, badges, class leaderboard, goals/study plan/timetable/assignments, announcements, activities, verification status, notifications, leave/rejoin class.
- **Resume builder:** 5 templates, auto-filled from *verified* data only, drag-and-drop section order, live A4 preview, autosave, ATS score with fixes, rule-based "improve" (optional LLM refinement when `ANTHROPIC_API_KEY` is set), print-to-PDF.
- **Skill-gap analyzer:** radar, two gap numbers (declared vs. verified), per-skill evidence, week-by-week roadmap, progress history.
- **Web app** (`frontend/`: Vite + React 19 + Tailwind v4 + Recharts): login/signup for all four roles, join-class gate, light/dark mode, responsive layout, notifications.

## What Phase 4 implements

- **Verification center** (`/classes/:id/verifications`): one queue for profile, marks, attendance, certificates, projects and skills; verify / reject / request-correction (remarks required for the last two), bulk verify (each item its own transaction), certificate file preview, decision history. Every decision is audited and notifies the student; only `verified` items reach analytics, leaderboards and resumes.
- **Data entry:** attendance sheet (subject + date + period, P/A/L/E per student, re-saving corrects), marks sheet (internal/external, regular or supplementary attempt). Entries by the instructor are saved as verified and supersede any open student claim.
- **CSV import** (attendance, marks): download a template, dry-run validation, then import. Partial success — valid rows are saved, invalid rows come back as a row-level error report; ≤ 1 MB / 5 000 rows; spreadsheet-formula cells are neutralised on export.
- **Analytics:** overview, subject performance, top / needs-support students, at-risk students with reasons, class skill-gap summary, side-by-side student comparison.
- **Leaderboard:** weighted score (default 35/15/15/15/10/10) with a per-class weights editor (whole numbers, must total 100) and reset; per-semester view; CSV export.
- **Students:** searchable roster, per-student detail (rank breakdown, subject attendance, semester results, certificates, projects, dropout-risk reasons), roll-number edit, mentoring notes, guardian messages.
- **Class setup & life:** subjects, weekly timetable (overlap check), class settings; announcements, activities (draft → publish, participants), assignments with submission tracking, guardian messages (queued log), join requests and Class Key rotate / revoke, class audit log with CSV exports.

## What Phase 5 implements

- **Overview** (`/college/overview`): KPIs (students, classes, instructors, verification queue with stale count), the college score with its seven components and weak flags, dropout-risk split, the department → class → instructor tree, top students and rule-based insights.
- **Department performance:** one formula at every level (students → class → department → college, [docs/SCORING.md §8](docs/SCORING.md)). Department detail shows components against the college average, "behind college" flags (> 10 points), SGPA by semester, event timeline, classes and top students; a compare view overlays 2–4 departments.
- **Leaderboards:** students (department / class / semester filters, search, paging), classes and departments; college-wide **default weights** editor (whole numbers totalling 100) that every class without its own weights inherits.
- **Instructors:** approve / reject / remove, department assignment, and per-instructor workload: classes, students, items in the queue, median verification turnaround (90 days) and last activity.
- **Alerts & insights:** classes flagged for attendance < 75 %, ≥ 30 % of students at medium/high risk, pass rate < 70 %, no verified data, or verifications waiting > 7 days — each with its reasons. Insights are generated by fixed rules and cite their numbers (no model involved).
- **Events & announcements:** an event is published as one activity per active class (whole college or one department) and the students are notified; instructors then mark attendance, which feeds "event participation". Announcements go to every student and approved instructor, can be pinned and deleted.
- **Reports & audit:** CSV exports (departments, classes, students, instructors, accreditation summary — formula-safe and audited) and the college-wide audit log with filters and paging. College profile and College Key (rotate / revoke) live under College settings.
- A college that is still **pending, rejected or suspended** sees a waiting screen instead of the dashboards.

## What Phase 6 implements

- **Overview** (`/university/overview`): college counts by status, a banner for registrations waiting for approval, the university score with its seven components and weak flags, dropout-risk split, the ranked colleges, top students and rule-based insights.
- **College approvals:** approve a pending college (this issues its College Key), suspend or reinstate an active one. A suspended college keeps its data but drops out of every ranking and total; its staff and students are blocked. Each college has a detail page: rank against the others, components next to the university average, "behind university" flags (> 10 points), departments, admission cohorts, SGPA by semester, the reasons it is flagged, its profile and key.
- **Leaderboards:** colleges (the same score formula applied to everyone in the college, [docs/SCORING.md §8](docs/SCORING.md)); departments across all colleges, filterable by department code so every college's "CSE" can be compared; top students university-wide. Students are scored with the system default weights so colleges compare on equal terms, and the list exposes only **name, college, department and score** — no e-mail or roll number.
- **Cross-college analytics:** filters by college, department code, admission year and semester; breakdown by college, by department code (same code in several colleges is one row) and by batch; a college × component **heat-map**; year-over-year score per batch and per college; average SGPA by semester.
- **Alerts & insights:** colleges flagged for the same reasons as classes at college level, plus university-level rules (colleges waiting or suspended, stale verifications, a college more than 10 points behind on a component, low event participation, colleges with no classes). Rules, not a model; every line cites its numbers.
- **Announcements:** one broadcast reaches every college admin, approved instructor and student of an active class; students also see it on their dashboard. Pin, unpin, delete; another university can never see or touch it.
- **Reports & audit:** CSV exports (colleges, departments, admission years — formula-safe and audited) and the university-wide audit log with action and college filters and paging.
- **Settings:** university profile and University Key (rotate, revoke, expiry, max uses).

## Known limits (deliberate, tracked for later phases)

- Phase 6: the roll-up is computed live on every request (a university-sized data set will want the `metric_snapshots` cache of SCORING §10, which is not built); insights are rules, not an LLM; there is no way to **reject** a college registration (the status enum has no `rejected`; leave it pending or suspend it after approval); exports are CSV only (no async PDF / Excel jobs); a university cannot edit a college's profile, only see it; the year-over-year view compares batches that are at different semesters, so use it for direction, not exact growth.
- Phase 5: the college roll-up is computed live on every request (fine for a college-sized data set; the `metric_snapshots` cache and the nightly "trend" insights of SCORING §10 are not built); insights are rules, not an LLM; events cannot be edited or deleted from the college screen (instructors edit their class's copy); accreditation export is a CSV summary, not a NAAC/NBA-formatted PDF.
- Phase 4: there is no student-roster CSV import (students join with the Class Key); mentoring notes marked "shareable" are stored but not yet shown to students; exports are CSV only (no PDF / Excel); guardian messages are a queued log (e-mail goes through the mail stub, SMS is not wired).

- The optional LLM path of the resume assistant is implemented but not exercised by the tests (no API key in CI); the rule-based path is.
- Certificate/photo files are stored on local disk (`backend/uploads`, a volume in Docker); deleting a record does not yet delete its file; several app instances would need a shared volume or S3/GCS.
- Notifications are polled every 60 s (no SSE yet); resume PDF is browser print, not server-rendered.
- Phase 7: there is **no migration runner** (`database/schema.sql` is a baseline; schema changes need hand-written SQL); rate limits are per process (one app instance is the supported shape); e-mail is a stub, so password-reset links are only printed to the log; there is no automated browser (UI) test suite; the Docker image and the CI workflow have not been run yet. Details: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) §4 and §6, [docs/TESTING.md](docs/TESTING.md).

- Refresh-token reuse detection is strict: two browser tabs refreshing with the *same* cookie at the same instant will sign the user out. A short grace window can be added if this proves annoying.
- Login, signup and password-reset are rate-limited per IP (10 / minute); session resume (`/auth/refresh`, called on every page load) has its own 60 / minute bucket. There is no per-account login lockout yet.
- Mail is a console/outbox stub (`src/utils/mailer.js`) — plug in SMTP/SES in Phase 7.
- Removing an instructor suspends their classes; moving a class to another instructor is not implemented.
- A student removed by an instructor cannot rejoin; one who left voluntarily can.
