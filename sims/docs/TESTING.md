# Testing

## Run everything

```bash
cd backend
npm test                    # 105 unit tests — no database
npm run test:integration    # 92 end-to-end tests — temporary embedded PostgreSQL, deleted afterwards
cd ../frontend && npm run build   # the web app must compile
```

`test:integration` needs no Docker or installed Postgres: it starts an embedded PostgreSQL in a temp folder, loads
`database/schema.sql`, runs `tests/integration/*.test.js`, and removes everything. To use your own empty database:
`TEST_DATABASE_URL=postgresql://… node --test tests/integration/*.test.js`.

CI (`.github/workflows/ci.yml`) is set up to run the same on every push and pull request, plus `npm audit` on
production dependencies, and to build the Docker image and boot it against a real PostgreSQL (not yet run — see below).

## What is covered

| File | Tests | What it proves |
|---|---|---|
| `scoring.test.js` | 12 | Grade points and pass rules, credit-weighted SGPA/CGPA, GPA predictor, attendance calculators, skill-gap weighting, leaderboard weights and tie-breaking, placement readiness, weak-metric flags, dropout-risk bands |
| `keygen.test.js` | 5 | Key alphabet (no look-alike characters), `PFX-XXXX-XXXX` format, uniqueness over 20 000 draws, input normalisation, same pattern as the schema's `CHECK` |
| `security.test.js` | 13 | Token signing / expiry / tampering, role guards, 404-not-403 for foreign classes, pending instructors and colleges blocked, password policy, sign-up strips unknown fields, error shapes, security headers |
| `student-logic.test.js` | 12 | Mark derivation and the external-minimum rule, SGPA/CGPA and backlog clearing, ATS resume score, skill roadmap, bullet / summary improvement, suggestions, badges from verified data only |
| `class-logic.test.js` | 12 | CSV parsing and export (quotes, CRLF, BOM, line numbers, formula neutralisation) and class insights (dropout-risk reasons, "unknown" instead of "high" without data) |
| `college-logic.test.js` | 25 | Department / college score, weak and "behind" flags, ranking with ties and no-data groups, class alerts, insights |
| `university-logic.test.js` | 15 | University roll-up (pooled, filters, cohorts), SGPA trend, university insights and their grammar |
| `static.test.js` | 11 | Serving the built web app (SPA fallback, cache headers, 404 for missing assets, no path traversal), CSP, no inline script in `index.html`, refusal to boot production with the placeholder secret, demo seed refuses production |
| `integration/flow.test.js` | 19 | The onboarding chain University → College → Class → Student with keys, approvals, lock-outs, sessions |
| `integration/student.test.js` | 19 | Student API: dashboard, attendance, marks, certificates (upload, dedupe, QR verify), skills, resume, isolation |
| `integration/instructor.test.js` | 21 | Verification centre, data entry, CSV import, analytics, leaderboard, class life, isolation between classes |
| `integration/college.test.js` | 16 | College dashboard: departments, instructors, alerts, events, announcements, exports, audit, isolation between colleges |
| `integration/university.test.js` | 14 | University dashboard: approvals lifecycle, rankings, analytics filters, heat-map, exports, audit, announcements, privacy of top-students, isolation between universities and roles |
| `integration/ops.test.js` | 3 | Readiness probe (and that it leaks nothing on failure), housekeeping of expired tokens |

The integration files for the college and university dashboards check that **a user can only see data inside their
own scope** (foreign ids are 404, other roles get `ROLE_FORBIDDEN`), and the roll-up logic tests check that **only
verified data counts** in scores and rankings.

## Not covered by automated tests

- **No browser (UI) automation.** The screens were checked by hand in a browser (desktop and phone width, light and
  dark) after each phase; there is no Playwright/Cypress suite. Adding one for sign-in, join-a-class, verify-an-item and
  the university approval is the most valuable next test investment.
- **No load or performance test.** All aggregates are computed live per request.
- **The Docker image** is defined to be built and smoke-tested by the CI workflow, but that workflow has not been run
  yet (the files were written on a machine without a running Docker daemon). Run `docker compose up -d --build` once
  yourself and then the checklist below. What *was* verified without Docker: the same server started with
  `NODE_ENV=production` serving the built web app, headers, cache rules, sign-in and several pages in a real browser.
- The optional LLM path of the resume assistant (needs `ANTHROPIC_API_KEY`) is implemented but not exercised.

## Manual acceptance checklist (after any deployment)

Use the demo data (`npm run seed:demo`, password `Demo@12345`) on a **non-production** instance.

**Everyone**
- [ ] Sign in, reload the page (still signed in), sign out. Wrong password shows an error.
- [ ] Light / dark toggle survives a reload, with no flash of the wrong theme.
- [ ] Phone width (375 px): no horizontal page scroll on any page; the menu opens.

**Student** (`student@demo.sims.test`)
- [ ] Dashboard shows attendance, SGPA, backlog warning; a pending item shows "awaiting verification".
- [ ] Upload a certificate → it shows *pending*; after the instructor verifies it, the public `/verify/<code>` page confirms it.
- [ ] **View file** on a certificate opens the PDF in a new tab (this goes through the production Content-Security-Policy — check it once on the real build).
- [ ] Resume builder: create from verified data, change template, download/print as PDF.

**Instructor** (`instructor@demo.sims.test`)
- [ ] Verification centre: verify one item, reject one with a remark; the student is notified.
- [ ] Data entry: mark attendance for a day; import a marks CSV (dry-run first).

**College admin** (`college@demo.sims.test`)
- [ ] Approve the pending instructor; the ECE department is flagged; publish an event and an announcement.

**University head** (`head@demo.sims.test`)
- [ ] Approve *Riverside Arts & Science College*; it gets a College Key. Suspend and reinstate Lakeside: it leaves and re-enters the rankings.
- [ ] Leaderboards, heat-map and filters respond; the top-students list shows no e-mail addresses.
- [ ] Send an announcement; a student sees it on their dashboard.
- [ ] Download a CSV export; it appears in the audit log.

**Operations**
- [ ] `GET /api/v1/health/ready` returns 200; stop the database container and it returns 503.
- [ ] Restart the app container: you stay signed in; uploaded files are still there (volume).
