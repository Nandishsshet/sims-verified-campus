# SIMS — REST API (v1)

Base path: `/api/v1` · JSON · `Authorization: Bearer <access_token>` unless **public**.
Role codes: **S** student · **I** instructor · **C** college admin · **U** university head.
Errors: `{ "error": { "code": "KEY_EXPIRED", "message": "...", "details": [...] } }`. List endpoints accept `?page&limit&q&sort`.
Scope is always resolved server-side (see ARCHITECTURE §4) — ids in URLs outside the caller's scope return **404**.

## 1. Auth (`/auth`)
| Method | Path | Who | Purpose |
|---|---|---|---|
| POST | `/auth/signup/university-head` | public | Create account **and** university → returns University Key |
| POST | `/auth/signup/college-admin` | public | Body incl. `universityKey` → college (pending approval) |
| POST | `/auth/signup/instructor` | public | Body incl. `collegeKey` → membership pending |
| POST | `/auth/signup/student` | public | Account only; join a class afterwards |
| POST | `/auth/login` | public | → access token + refresh cookie |
| POST | `/auth/refresh` | cookie | Rotate refresh token |
| POST | `/auth/logout` | any | Revoke refresh token |
| POST | `/auth/forgot-password` | public | Always 200 (no enumeration) |
| POST | `/auth/reset-password` | public | Single-use token |
| GET / PATCH | `/me` | any | Own profile / change password / avatar |

## 2. Keys & joining (`/keys`, `/join`)
| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/keys/mine` | U·C·I | Active key for my scope (university / college / class) + usage stats |
| POST | `/keys/:scope/:id/regenerate` | owner | Rotate (old → `rotated`) |
| POST | `/keys/:scope/:id/revoke` | owner | Revoke without replacement |
| PATCH | `/keys/:id` | owner | Set `expires_at`, `max_uses` |
| GET | `/keys/:id/logs` | owner | Usage log (joins, failed attempts, rotations) |
| ~~POST~~ | ~~`/join/college`~~ | — | **Dropped in Phase 2:** a college admin supplies the University Key at signup (`/auth/signup/college-admin`); the account ↔ college link is 1:1 so there is nothing to join later. |
| POST | `/join/instructor` | I | `{collegeKey, departmentId?}` (also used at instructor signup; re-request after rejection/removal) |
| POST | `/join/class` | S | `{classKey}` → enrollment `pending` (rate-limited) |
| GET | `/join/status` | S·I·C | My current membership state |

### Health (no auth, not rate limited)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness: `{status:"ok"}` while the process is up |
| GET | `/health/ready` | Readiness: `{status:"ready"}` if the database answers, else a bare `503 {status:"unavailable"}` (no error text) |

## 3. University (`/university`) — U
| Method | Path | Purpose |
|---|---|---|
| GET / PATCH | `/university` | Details |
| GET | `/university/colleges` | Colleges with status, score, key info |
| POST | `/university/colleges/:id/approve` · `/suspend` · `/reinstate` | Manage college |
| GET | `/university/leaderboard/colleges` | Ranked by aggregated college score |
| GET | `/university/analytics` | `?collegeId&departmentId&year&semester` — avg CGPA, pass %, attendance, skill readiness, certificates, trends |
| GET | `/university/analytics/heatmap` | college × metric matrix |
| GET | `/university/analytics/yoy` | Year-over-year comparison |
| GET | `/university/top-students` | Top N across university (name, college, score only) |
| GET | `/university/best-departments` | Departments ranked across colleges |
| GET / POST | `/university/announcements` | Broadcast |
| POST | `/university/reports/export` | Bulk PDF/Excel (async job) |

### Phase 6 implementation notes (where the shipped API differs from, or adds to, the table above)

Every route sits behind `protect` + `requireRole('university_head')`, and all data is scoped to the caller's `req.scope.universityId`; a college id of another university is a **404**, never a 403.

| Method | Path | Notes |
|---|---|---|
| GET | `/university` | Profile plus the active University Key (`key.keyValue`, use count, expiry). |
| PATCH | `/university` | Partial update of `name, headTitle, headName, address, contactEmail, contactPhone` (the last three nullable). Empty body → 400. Audited `university.update`. |
| GET | `/university/colleges` | Adds `department_count, student_count, instructor_count, pending_instructors`, `admin_name/email` and the College Key. Pending colleges first. Score and rank are **not** here — use the leaderboard. |
| POST | `/university/colleges/:id/approve` · `suspend` · `reinstate` | `pending → active ⇄ suspended`. Any other transition → **409 `INVALID_STATE`**. Approve issues the College Key and returns it as `collegeKey`. There is **no reject**: the status enum has no `rejected`. |
| GET | `/university/overview` | `totals` (colleges by status, departments, classes, instructors, students, verification queue and stale count), `score`, `risk`, `alertCount`, ranked `colleges`, `inactiveColleges` (pending + suspended), `pendingColleges`, `topStudents`. |
| GET | `/university/colleges/:id` | One college against the university: `rank`/`of`, `summary` (with `behind` > 10 points), `university` averages, `departments`, `sgpaTrend`, `cohorts`, `alerts`, `key`. Works for pending and suspended colleges (they simply have no data). |
| GET | `/university/leaderboard/colleges` | Ranked active colleges; groups without verified data have `score: null`, are listed last and are unranked. Ties share a rank. |
| GET | `/university/best-departments?limit&code` | Departments of all active colleges. `code` (case-insensitive) restricts to one department code. |
| GET | `/university/top-students?limit&collegeId` | **Privacy-limited:** each row is only `rank, name, college, department, score`. Everyone is scored with the system default weights (35/15/15/15/10/10) so colleges compare on equal terms. |
| GET | `/university/analytics` | Filters are `collegeId, departmentCode, admissionYear, semester` (**`departmentCode`, not `departmentId`**: the same code in several colleges is one group). Returns `filters.options`, `summary`, `byCollege`, `byDepartment`, `byYear`, `sgpaTrend`. A foreign `collegeId` → 404. |
| GET | `/university/analytics/heatmap` | `metrics`, the university row, and one row per active college with its seven 0–100 components. |
| GET | `/university/analytics/yoy` | One entry per admission year (`delta` against the previous year) and one series per college. "Year" is the **admission year** (cohort), not the calendar year. |
| GET | `/university/alerts` | Colleges flagged with their reasons and severity (same rules as class alerts, applied to a college), `staleAfterDays`. |
| GET | `/university/insights` | `generatedBy: "rules"`. Fixed rules over verified data; each insight has `id, severity, title, detail, to`. No model is involved. |
| GET / POST | `/university/announcements` | POST `{title, body, pinned}` notifies every college admin (any status), approved instructor and student of an active class; the response has `recipients` and a `breakdown`. |
| PATCH / DELETE | `/university/announcements/:id` | Pin / unpin and delete; another university's id → 404. |
| GET | `/university/export/:kind` | **Replaces `POST /university/reports/export`.** `kind` is `colleges`, `departments` or `cohorts`; synchronous CSV, formula-safe, audited as `report.export`. There is no async PDF / Excel job. |
| GET | `/university/audit-logs?limit&before&action&collegeId` | Every audit row stamped with this university, newest first; `action` is a prefix (e.g. `college.`); `nextBefore` pages backwards. |

All figures use verified data only, from active colleges and active classes with approved enrolments. Nothing is cached: the roll-up is computed on each request.

## 4. College (`/college`) — C
| Method | Path | Purpose |
|---|---|---|
| GET / PATCH | `/college` | Details |
| GET / POST / PATCH / DELETE | `/college/departments[/:id]` | Manage departments |
| GET | `/college/overview` | Departments → classes → instructors tree |
| GET | `/college/instructors` | Incl. activity + verification turnaround |
| POST | `/college/instructors/:id/approve` · `/reject` · `/remove` | Instructor management |
| GET | `/college/leaderboard/students` | `?departmentId&classId&semester` |
| GET | `/college/leaderboard/departments` · `/classes` | Rankings |
| GET | `/college/analytics/departments` | Score 0–100 + 7 components + weak flags |
| GET | `/college/analytics/departments/:id` | Detail: trend by semester, activity timeline |
| GET | `/college/analytics/compare` | `?departmentIds=` comparison chart data |
| GET | `/college/alerts` | At-risk classes |
| GET | `/college/insights` | AI-generated insights |
| GET / POST | `/college/events` · `/college/announcements` | Calendar · broadcast to all classes |
| PUT | `/college/leaderboard-config` | Default weights for classes |
| POST | `/college/reports/accreditation` | NAAC/NBA-style export |

### Phase 5 implementation notes (where the shipped API differs from, or adds to, the table above)

All `/college/*` routes need role `college_admin`; everything except `GET|PATCH /college` is blocked with `ORG_NOT_ACTIVE` until the university head has approved the college. Another college's ids always return 404.

| Method | Path | Notes |
|---|---|---|
| PATCH | `/college` | Partial update of name, address, affiliation, principalName, contactEmail, contactPhone (nullable fields accept `null`). |
| GET | `/college/instructors` | `?status=` optional. Adds `department_name`, `student_count`, `pending_items` (queue now), `turnaround_hours` (median hours to decide, last 90 days, `null` if none) and `last_active`. |
| PATCH | `/college/instructors/:id` | `{ departmentId \| null }`; another college's department → `INVALID_DEPARTMENT`. |
| PATCH / DELETE | `/college/departments/:id` | Partial update (`DEPARTMENT_EXISTS` on a duplicate code). Delete → `DEPARTMENT_IN_USE` (409) while it has classes. `GET` adds `classes`, `students`, `instructors` counts. |
| GET | `/college/overview` | `{ college, totals, score{value, components, weak, metrics, coverage}, risk, alertCount, weights, departments[…classes[]], topStudents }`. `score.value` is `null` until some verified marks or attendance exist. |
| GET | `/college/leaderboard/students` | `?departmentId&classId&semester&q&limit(≤200)&offset` → `{ board, total, weights, weightsSource }`. Everyone is scored with the **college** weights so ranks are comparable across classes. |
| GET | `/college/leaderboard/departments` · `/classes` | Ranked groups (`rank` is `null` for a group with no verified data, listed last); `/classes?departmentId`. |
| GET | `/college/analytics/departments[/:id]` | List adds `behind` (components > 10 points under the college) and `coverage`; detail adds `classes`, `sgpaTrend`, `eventTimeline`, `topStudents`, `rank`/`of`. |
| GET | `/college/analytics/compare` | `?departmentIds=a,b[,c,d]` (2–4; a foreign id → 404). |
| GET | `/college/alerts` | Active classes with `reasons[]` and `severity` (`critical` / `warning`). Rules in SCORING §8. |
| GET | `/college/insights` | `{ generatedBy: "rules", insights[] }` — **rule-based, not an LLM** (each line cites the numbers it is based on). |
| GET / PUT / DELETE | `/college/leaderboard-config` | College default weights (six whole numbers, total 100). Response: `{ weights, source: "college" \| "default", defaults, overridden }` where `overridden` = classes with their own config. Resolution order: class → college → system default. |
| GET / POST | `/college/announcements` | POST `{ title, body, pinned }` notifies every student and every *approved* instructor → `{ announcement, recipients }`. `PATCH /:id { pinned }`, `DELETE /:id`. |
| GET / POST | `/college/events` | GET `?from&to&departmentId`. POST `{ type, title, startsAt, endsAt?, venue?, description?, departmentId? }` publishes **one activity per active class** (of the department, or all) and notifies the enrolled students → `{ created, notified }`; `NO_CLASSES` (400) when there is none. There is no college-level edit/delete — instructors manage their class's copy and its attendance. |
| GET | `/college/export/:kind` | **Replaces `POST /college/reports/accreditation`.** `kind` = `departments \| classes \| students \| instructors \| accreditation`; returns CSV (formula-neutralised), audited as `report.export`. |
| GET | `/college/audit-logs` | `?limit&before&action` (action is a prefix match) → `{ logs, nextBefore }`. Covers every audit row of the college, including instructors' and students' actions. |

Auth note: `POST /auth/refresh` now has its own rate-limit bucket (60/min/IP) instead of sharing the 10/min credential bucket.

## 5. Class (`/classes`) — I (owner)
| Method | Path | Purpose |
|---|---|---|
| POST | `/classes` | Create class → returns Class Key |
| GET / PATCH | `/classes/:id` | Details |
| GET | `/classes/:id/enrollments` | `?status=pending\|approved\|removed&q=` searchable list |
| POST | `/classes/:id/enrollments/:eid/approve` · `/reject` | `{rollNumber?, remarks?}` |
| DELETE | `/classes/:id/enrollments/:eid` | Remove student (`{remarks}`) |
| GET / POST / PATCH | `/classes/:id/subjects[/:sid]` | Subject catalog per semester |
| **Verification** | | |
| GET | `/classes/:id/verifications` | Queue `?type&status&studentId` |
| GET | `/classes/:id/verifications/:vid` | Item + student's evidence (e.g. certificate file) |
| POST | `/classes/:id/verifications/:vid/verify` | |
| POST | `/classes/:id/verifications/:vid/reject` | `{remarks}` required |
| POST | `/classes/:id/verifications/:vid/request-correction` | `{remarks}` required |
| POST | `/classes/:id/verifications/bulk` | Verify many |
| **Data entry** | | |
| POST | `/classes/:id/attendance` | Manual entries (date, subject, per-student status) |
| POST | `/classes/:id/attendance/import` | CSV/Excel → `import_jobs` |
| POST | `/classes/:id/marks` · `/marks/import` | Manual · CSV import |
| GET | `/classes/:id/imports/:jobId` | Status + row-level error report |
| GET | `/classes/:id/imports/template/:kind` | Download CSV template |
| **Analytics** | | |
| GET | `/classes/:id/analytics/overview` | Avg SGPA, pass %, attendance distribution, certificates count |
| GET | `/classes/:id/analytics/subjects` | Subject-wise performance |
| GET | `/classes/:id/analytics/performers` | Top/bottom N |
| GET | `/classes/:id/analytics/at-risk` | Low attendance/marks, dropout band |
| GET | `/classes/:id/analytics/skill-gap` | Class summary per role |
| GET | `/classes/:id/compare` | `?studentIds=a,b` student comparison |
| GET | `/classes/:id/leaderboard` | `?semester=` |
| GET / PUT | `/classes/:id/leaderboard-config` | Weights (sum = 100) |
| **Class life** | | |
| GET / POST / PATCH / DELETE | `/classes/:id/activities[/:aid]` | Department activities |
| POST | `/classes/:id/activities/:aid/publish` | Pushes to every student dashboard + notifications |
| PUT | `/classes/:id/activities/:aid/participants` | Mark attended / winner |
| GET / POST | `/classes/:id/announcements` | |
| GET / POST / PATCH | `/classes/:id/assignments[/:aid]` | Deadline tracker |
| GET / PUT | `/classes/:id/timetable` | |
| GET / POST | `/classes/:id/students/:sid/notes` | Mentoring notes |
| POST | `/classes/:id/parent-notifications` | Email/SMS placeholder (queued log) |
| POST | `/classes/:id/reports/export` | `?format=pdf\|xlsx&kind=` |
| GET | `/classes/:id/audit-logs` | |

### Phase 4 implementation notes (where the shipped API differs from, or adds to, the table above)

All routes below sit behind `requireRole('instructor')` + `requireOwnClass()`: a class id the instructor does not own is a **404**, never a 403.

**Verification** — `GET /verifications` → `{items, pendingByType, pendingTotal}` (`status` defaults to `pending`, `all` allowed; `limit ≤ 200`). `GET /verifications/:vid` → `{request, item, hasFile, history}`; `GET /verifications/:vid/file` streams the certificate. Decisions lock the request row: a second decision is `409 ALREADY_DECIDED`; a withdrawn item is `410 ITEM_GONE`. `POST /verifications/bulk {ids ≤ 100, action, remarks?}` → `{done, failed:[{id, code, message}]}`.

**Data entry** — `GET /attendance/sheet?subjectId&date&period` and `GET /marks/sheet?subjectId&attempt` return the roster pre-filled with what is already stored; `POST /attendance` and `POST /marks` upsert (re-posting corrects) and return `{inserted, updated}`. Instructor-entered rows are stored `verified` and close any open student claim for the same slot.

**CSV import** — `POST /attendance/import` and `POST /marks/import` (multipart field `file`, `?dryRun=1` to validate only). Semantics are **partial success**: valid rows are written, invalid rows are listed in `errorReport:[{row, field, message}]` (first 200; `moreErrors` counts the rest). A file with no valid row is `422` with `status: "failed"`. Errors before parsing: `NO_FILE`, `INVALID_FILE_TYPE`, `INVALID_CSV`, `MISSING_COLUMNS`, `EMPTY_FILE`, `TOO_MANY_ROWS`, `FILE_TOO_LARGE` (413). `GET /imports`, `GET /imports/:jobId`, `GET /imports/template/:kind` (`attendance` | `marks`).

**Roster & analytics** — `GET /students?q=`, `GET /students/:sid`, `PATCH /students/:sid {rollNumber}` (`409 ROLL_NUMBER_TAKEN`), `GET /analytics/overview | subjects | performers | at-risk | skill-gap`, `GET /compare?studentIds=a,b[,c,d]` (2–4). Risk band is `unknown` until a student has verified attendance or marks. `GET /export/:kind` (`students | leaderboard | attendance | marks`) returns CSV and is audited.

**Leaderboard** — `GET /leaderboard?semester=` → `{weights, weightsSource: 'class'|'college'|'default', board}`. `GET|PUT|DELETE /leaderboard-config`: six integer weights that must total exactly 100; `DELETE` falls back to the college default.

**Setup** — `GET|POST /subjects`, `PATCH|DELETE /subjects/:sid` (`409 SUBJECT_IN_USE` once marks or attendance exist), `PATCH /` (class name, current semester, HOD, instructor contact), `GET|PUT /timetable` (`PUT` replaces the whole week atomically; `400 TIMETABLE_OVERLAP`).

**Class life** — announcements, activities (`POST …/publish|unpublish`, `GET|PUT …/participants`), assignments (`GET …/:aid/submissions`, `PUT …/:aid/submissions/:sid {remarks}`), `POST|DELETE /students/:sid/notes[/:nid]` (read through `GET /students/:sid`), `POST|GET /parent-notifications` (queued log; a student without the chosen guardian contact is reported as `failed` with a `problem`), `GET /audit-logs?limit&before&action` (cursor `nextBefore`).

**Not built (listed in §5 above):** `POST /reports/export` (PDF/xlsx) — exports are CSV via `/export/:kind`.

## 6. Student (`/student`) — S
| Method | Path | Purpose |
|---|---|---|
| GET | `/student/dashboard` | Summary: verification counts, attendance %, CGPA, rank, readiness, alerts |
| GET / PATCH | `/student/profile` | Edit → `pending` re-verification |
| POST | `/student/profile/submit` | Send for verification |
| POST | `/student/class/leave` | Withdraw from class |
| **Attendance** | | |
| GET | `/student/attendance` | Subject-wise + overall (verified), monthly calendar `?month=` |
| GET | `/student/attendance/can-miss` | `?threshold=75` calculator |
| POST | `/student/attendance/claims` | Claim a record (needs verification) |
| **Academics** | | |
| GET | `/student/academics` | Semester marks, SGPA, CGPA, backlogs, trend series |
| GET | `/student/academics/predict` | `?targetCgpa=&nextCredits=` GPA predictor |
| POST | `/student/academics/claims` | Self-reported marks for verification |
| **Certificates** | | |
| GET / POST | `/student/certificates` | Multipart upload (PDF/JPG/PNG ≤ 5 MB) |
| PATCH / DELETE | `/student/certificates/:id` | Edit resets status to `pending` |
| POST | `/student/certificates/:id/submit` | Send for verification |
| GET | `/student/certificates/:id/file` | Authenticated download |
| **Portfolio** | | |
| GET / POST / PATCH / DELETE | `/student/portfolio[/:id]` | `?type=project\|internship\|publication` |
| **Activities** | | |
| GET | `/student/activities` | Published department activities + my participation |
| POST | `/student/activities/:id/register` | |
| **Resume** | | |
| GET / POST | `/student/resumes` | List · create (auto-filled from verified data) |
| GET / PUT / DELETE | `/student/resumes/:id` | Content, template, section order |
| GET | `/student/resumes/:id/ats` | ATS score + suggestions |
| POST | `/student/resumes/:id/ai/improve` | `{section, text}` → improved bullets/summary |
| GET | `/student/resumes/:id/pdf` | PDF render |
| GET | `/student/resumes/templates` | 5 templates |
| **Skills** | | |
| GET / POST / PATCH / DELETE | `/student/skills[/:id]` | Manual skills + proficiency |
| GET | `/skills` · `/career-roles` | Catalog (public to authenticated users) |
| PUT | `/student/target-role` | `{roleId}` |
| GET | `/student/skill-gap` | `?roleId=` → radar data, gap %, verified gap %, per-skill table |
| GET | `/student/skill-gap/roadmap` | Courses + timeline |
| GET | `/student/skill-gap/history` | Progress over time |
| **Extras** | | |
| GET | `/student/placement-readiness` | Score + breakdown |
| GET | `/student/leaderboard` | My class board + my rank (names/scores only) |
| GET / POST / PATCH / DELETE | `/student/goals[/:id]` · `/student/study-plan[/:id]` | Goals & planner |
| GET | `/student/timetable` · `/student/assignments` · `/student/announcements` | |
| GET | `/student/badges` | Gamification |
| GET | `/student/suggestions` | Personalised AI suggestions |
| GET | `/student/verification-status` | All my items with status + remarks |

### Phase 3 implementation notes (where the shipped API differs from the table above)
- **Implemented:** every row of §6 **except** `GET /student/resumes/:id/pdf` — PDF export is done in the browser (`window.print()` of the A4 preview, with print CSS), which keeps real text selectable for ATS parsers and avoids a headless-browser dependency. A server-side renderer can be added behind the same route later.
- **Added:** `GET /student/academics/subjects` → `{subjects:[{id,code,name,semester,credits,state:'none'|'unverified'|'passed'|'failed',claimable}]}` (feeds the marks-claim form); `PUT /student/certificates/:id/skills`; `PATCH /student/academics/claims/:id`; `POST /student/assignments/:id/submit`; `GET|POST /student/profile/photo` (JPG/PNG ≤ 1 MB, magic-byte checked).
- **Resume:** `GET /student/resumes/:id` → `{resume, data, base, ats}` where `base` is the auto-generated verified-only content and `data` is `base` merged with the student's edits (the SPA mirrors this merge locally for the live preview). `PUT` returns `{resume, data, ats}` so autosave refreshes the score. `POST …/ai/improve` → `{original, issues:[{code,message}], suggestions:[], quality?, source:'rules'|'llm+rules'}`; it works without any API key (rules), and uses an LLM only when `ANTHROPIC_API_KEY` is set. Max 5 resumes per student. Unverified items **never** reach a resume.
- **Marks / attendance claims** are `unverified` rows in the normal tables and enter the instructor's verification queue; they are excluded from every metric until verified.
- **Leaderboard:** `{board:[{rank,name,total,isMe}], me:{rank,total,components}, classSize, weights}` — no roll numbers or e-mails of classmates are exposed.
- **Leaving a class:** `POST /student/class/leave` sets the enrollment to `removed` with `decided_by = the student`; the student may rejoin with a valid Class Key. A student removed *by the instructor* is blocked from rejoining.
- **Not yet implemented (later phases):** `GET /notifications/stream` (SSE — the UI polls every 60 s), `GET /search`, `/reports/*` exports, `GET /audit-logs`.

## 7. Cross-cutting
| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/notifications` | any | `?unread=true` |
| POST | `/notifications/:id/read` · `/notifications/read-all` | any | |
| GET | `/notifications/stream` | any | **SSE** real-time push |
| GET | `/search` | any | `?q=` — scoped global search (students/classes/colleges as permitted) |
| GET | `/audit-logs` | I·C·U | Scoped by role |
| GET | `/verify/:code` | **public** | Certificate authenticity (QR target): `{valid, holder, title, issuer, verifiedAt}` |
| GET | `/reports/:jobId` | any | Poll / download export job |
| GET | `/health` | public | Liveness |

## 8. Endpoint conventions
- **Idempotent state transitions** (approve/verify) return 409 if already in the target state.
- **Every mutating endpoint** writes an `audit_logs` row; verification endpoints also create a `notifications` row.
- **Rate limits:** `/auth/*` 10/min/IP · `/join/*` 5/10 min/IP+user · default 300/min/user.
- **Uploads:** `multipart/form-data`, field `file`, magic-byte validated.
