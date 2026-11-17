# SIMS — Scoring Formulas

Implemented and unit-tested in [`backend/src/services/scoring.js`](../backend/src/services/scoring.js).
**All inputs are VERIFIED data only.** All composite scores are on a 0–100 scale.

## 1. Academics

| Metric | Formula |
|---|---|
| Total % | `(internal + external) / (internal_max + external_max) × 100` |
| Pass | total ≥ 40 % **and** external ≥ 40 % of external max (configurable) |
| Grade points | ≥90→10, ≥80→9, ≥70→8, ≥60→7, ≥50→6, ≥45→5, ≥40→4, else 0 |
| SGPA | `Σ(credits × grade_points) / Σ credits` for a semester |
| CGPA | `Σ(semester_credits × SGPA) / Σ semester_credits`; a cleared backlog replaces the failed attempt (highest `attempt`) |
| Backlog | subject whose latest attempt is a fail |
| Pass % (class) | students with zero failed latest-attempts in the semester ÷ students with results |

**GPA predictor** — SGPA needed next semester to reach target CGPA:

```
required = (target × (C_done + C_next) − CGPA × C_done) / C_next
feasible = required ≤ 10          (required ≤ 0 ⇒ target already guaranteed)
```
Example: CGPA 7.5 over 100 credits, 25 credits next, target 7.8 → `(7.8×125 − 750)/25 = 9.0`.

## 2. Attendance

```
attendance % = attended / held × 100        attended = present + late + excused
alert        = overall % < 75   (threshold configurable)

classes you can still miss  = floor( (100·a − T·h) / T )                 (a = attended, h = held, T = threshold %)
classes to attend to recover = ceil( (T·h − 100·a) / (100 − T) )          (consecutive classes)
```
Example: a=40, h=50, T=75 → miss ≤ 3 (40/53 = 75.5 %, 40/54 = 74.1 %).

## 3. Skill gap

For target role *R* with required skills `(level_i ∈ 1..5, weight_i)` and the student's best level `have_i` per skill:

```
coverage_i = min(have_i, level_i) / level_i          (over-qualification isn't rewarded)
readiness  = Σ weight_i · coverage_i / Σ weight_i × 100
skill gap % = 100 − readiness
```
`have_i` = max proficiency across sources. Two variants are stored per snapshot:
- **gap_percent** — verified + self-declared manual skills (student's personal view, flagged as self-declared).
- **verified_gap_percent** — verified sources only → used by leaderboards, class/college/university analytics.

Roadmap: for each skill with `coverage < 1`, pick `learning_resources` that teach up to `level_i`, order by `weight × (1 − coverage)` descending, schedule using `est_hours` ÷ the student's weekly study hours → timeline. Progress = trend of `skill_gap_snapshots`.

## 4. Component scores

| Component | Formula |
|---|---|
| **Marks** | `SGPA/10 × 100` (selected semester) or `CGPA/10 × 100` (overall) |
| **Attendance** | attendance % (cap 100) |
| **Certificates** | `min(100, Σ points / 50 × 100)`; points: internship 15, hackathon 12, course 8, workshop 5, sports 5, other 3 |
| **Skills** | `100 − verified skill gap %` |
| **Resume** | latest resume's ATS score (0–100) — see §6 |
| **Activity** | `min(100, Σ points / 60 × 100)`; points: attended 10, runner-up 18, winner 25, registered-only 0 |

## 5. Class leaderboard

```
score = 0.35·Marks + 0.15·Attendance + 0.15·Certificates + 0.15·Skills + 0.10·Resume + 0.10·Activity
```
- Weights are configurable per class (`leaderboard_configs`), **must be integers ≥ 0 that sum to 100** (DB `CHECK` + `assertWeights`). A college may set defaults for its classes.
- Semester filter: Marks and Attendance use that semester's data; the other components are cumulative.
- **Ranking:** score ↓ → CGPA ↓ → attendance ↓ → name ↑. Equal scores share a rank (1, 2, 2, 4).
- **College leaderboard** uses the same per-student score with each class's weights normalised to the *college default weights*, so students from different classes are comparable. Department and class rankings are the same list grouped.

## 6. Resume ATS score (implemented in Phase 3)

| Check | Pts |
|---|---:|
| Required keywords of the target role found in skills/bullets (`matched / total`) | 30 |
| Section completeness (summary, education, skills, projects/experience, certificates) | 20 |
| Quantified bullets (contain numbers/%/₹/users…) — share of bullets | 15 |
| Strong action verbs at bullet start — share of bullets | 10 |
| Length & density (1 page ≈ 350–700 words; penalise walls of text) | 10 |
| Contact completeness (email, phone, LinkedIn/GitHub) | 5 |
| ATS-safe format (standard headings, no tables/images in chosen template) | 10 |

Each failed check returns a human suggestion ("Add numbers to 3 bullets"). AI rewriting is an optional layer on top; the score itself is deterministic.

## 7. Placement readiness

```
raw = 0.30·Marks(CGPA) + 0.20·SkillReadiness + 0.15·Certificates
    + 0.15·Portfolio + 0.10·Resume + 0.10·Attendance
placement readiness = clamp( raw − 5 × active_backlogs , 0, 100 )
Portfolio = min(100, internships×40 + projects×20 + publications×20)
```

## 8. Department & college score

Seven metrics, normalised to 0–100 then weighted:

| Metric | Normalisation | Weight |
|---|---|---:|
| Average SGPA | `SGPA/10 × 100` | 25 |
| Attendance | average % | 20 |
| Pass % | % | 20 |
| Certificates per student | `min(100, certs_per_student / 3 × 100)` | 10 |
| Placement readiness | average | 10 |
| Skill gap | `100 − average gap %` | 10 |
| Event participation | % of students attending ≥ 1 published event in the period | 5 |

`score = Σ weight × normalised / 100`.
**Weak metric** = normalised value `< 60` → rendered red, plus listed in "where this department is lagging". Metrics also compare to the college mean (flag if > 10 points below).
**College score** applies the same formula to all the college's students pooled (student-weighted), making colleges comparable on the university leaderboard. **Instructor turnaround** = median(`reviewed_at − submitted_at`) over `verification_requests` — reported alongside, not part of the score.

**As implemented (Phase 5, `backend/src/modules/colleges/college.insights.js`):**
- A group is *students → class → department → college*; the same `summarise()` runs at every level on the same verified-only student metrics.
- Average SGPA = mean of each student's **latest** semester SGPA, over students who have verified marks. Attendance = mean of verified attendance % over students who have any. Pass % = students with no active backlog ÷ students with verified marks. Certificates = verified certificates ÷ **all** students. Skill gap = mean verified gap over students with a target role (100 if nobody chose one). Event participation = students with ≥ 1 *attended / runner-up / winner* mark at a published activity ÷ all students.
- **Missing data counts as 0** (e.g. no verified attendance ⇒ no credit), but a group with neither verified marks nor verified attendance has **no score** (`null`, "No data yet") and is listed last, unranked, instead of being ranked as a failure.
- Ties share a rank (1, 1, 3). "Behind college" = more than 10 points below the college component.
- **Class alerts** fire for: no verified data; average attendance < 75 %; ≥ 30 % of the students whose risk is known at medium/high risk; pass % < 70; any verification pending > 7 days. `critical` = two or more reasons or attendance < 65 %, otherwise `warning`.
- Student leaderboard at college level uses the college default weights (§5) for every student, whatever the class's own configuration.

**University roll-up (Phase 6, `backend/src/modules/universities/university.insights.js`):**
- The university is one more level above the college: the same `summarise()` over **every verified student of every active college** (pooled, student-weighted — *not* a mean of college scores, so a 6-student college cannot weigh as much as a 600-student one). Colleges that are pending or suspended, and classes that are not active, contribute no students, so they cannot move a ranking.
- A college is scored by the same formula over its own students, and ranked against the other colleges with the same rules as before: no verified data ⇒ `score: null`, listed last and unranked; ties share a rank. "Behind university" = more than 10 points below the university component.
- **Students are ranked with the system default weights** (§5: 35/15/15/15/10/10), not each college's or class's own, so students of different colleges are compared on one scale. Only name, college, department and score leave the API.
- **Departments with the same code are one group** in university analytics (every college's "CSE"); the leaderboard of departments still lists each college's own department separately.
- **Cohorts are admission years.** The year-over-year view compares batches, which are at different semesters, so a difference between two batches is a direction, not a like-for-like growth figure. Average SGPA by semester averages each semester over the students who have it.
- **College alerts** reuse the class rules (no data, attendance < 75 %, ≥ 30 % medium/high risk, pass % < 70, verifications pending > 7 days) applied to the whole college. University insights add: colleges waiting for approval or suspended, stale verifications, a college more than 10 points behind the university on a component, event participation under 30 %, and colleges with no active class.
- Computed live per request; the `metric_snapshots` cache (§10) is not built.

## 9. At-risk & dropout risk (heuristic v1)

```
f_att   = clamp((85 − attendance%) / 45, 0, 1)
f_perf  = clamp((7 − SGPA) / 4, 0, 1)
f_trend = clamp((prevSGPA − SGPA) / 2, 0, 1)
f_back  = min(1, backlogs / 4)
f_eng   = 1 − ActivityScore/100
risk    = 100 × (0.35 f_att + 0.30 f_perf + 0.15 f_trend + 0.10 f_back + 0.10 f_eng)
band    = low (<30) · medium (30–60) · high (>60)
```
"At-risk student" in class analytics = attendance < 75 % **or** SGPA < 5 **or** band = high. Factors are stored with each score so the UI can explain *why*.

## 10. Trend insights (e.g. "CSE attendance dropped 8 % this month")

Nightly job compares the latest `metric_snapshots` against the one ~30 days (or one semester) earlier per department/class. Rule: `|Δ| ≥ 5` points → insight, severity `warning` if negative and ≥ 5, `critical` if ≥ 10, `positive` if improving ≥ 5. The numbers are computed; an LLM is only used (optionally) to phrase them.
