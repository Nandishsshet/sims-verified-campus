-- =====================================================================
-- SIMS — Student Information Management System
-- PostgreSQL 14+ schema (v1)
--
-- Run:  psql "$DATABASE_URL" -f database/schema.sql
--
-- Conventions
--   * UUID primary keys (gen_random_uuid)
--   * created_at / updated_at on mutable tables (updated_at via trigger)
--   * "verification" columns on every student-submitted record:
--       verification_status, verified_by, verified_at, verifier_remarks
--     ONLY rows with verification_status = 'verified' feed analytics,
--     leaderboards, skill-gap and the resume.
--   * Hierarchy: universities -> colleges -> classes -> students
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------
-- 0. ENUMS
-- ---------------------------------------------------------------------
CREATE TYPE user_role           AS ENUM ('student','instructor','college_admin','university_head');
CREATE TYPE verification_status AS ENUM ('pending','verified','rejected','correction_requested');
CREATE TYPE membership_status   AS ENUM ('pending','approved','rejected','removed');
CREATE TYPE org_status          AS ENUM ('pending','active','suspended');
CREATE TYPE key_status          AS ENUM ('active','revoked','expired','rotated');
CREATE TYPE key_event           AS ENUM ('created','joined','join_denied','rotated','revoked','expired');
CREATE TYPE verifiable_entity   AS ENUM ('profile','marks','attendance','certificate','project','skill');
CREATE TYPE attendance_status   AS ENUM ('present','absent','late','excused');
CREATE TYPE data_source         AS ENUM ('instructor','csv_import','student');
CREATE TYPE certificate_category AS ENUM ('course','hackathon','internship','sports','workshop','other');
CREATE TYPE portfolio_type      AS ENUM ('project','internship','publication');
CREATE TYPE skill_source        AS ENUM ('manual','certificate','project');
CREATE TYPE activity_type       AS ENUM ('program','event','competition','course','workshop');
CREATE TYPE participation_status AS ENUM ('registered','attended','absent','runner_up','winner');
CREATE TYPE announcement_scope  AS ENUM ('class','college','university');
CREATE TYPE goal_type           AS ENUM ('cgpa','skill','certificate','attendance','custom');
CREATE TYPE insight_severity    AS ENUM ('info','positive','warning','critical');

-- ---------------------------------------------------------------------
-- 0b. Shared trigger: keep updated_at fresh
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. IDENTITY & AUTH
-- =====================================================================
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  password_hash text   NOT NULL,                  -- argon2id / bcrypt, never plaintext
  role          user_role NOT NULL,
  full_name     text   NOT NULL,
  phone         text,
  avatar_url    text,
  is_active     boolean NOT NULL DEFAULT true,
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Refresh-token rotation (store only a hash; reuse of a revoked token => revoke family)
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 2. ORGANISATION HIERARCHY
-- =====================================================================
CREATE TABLE universities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  head_user_id  uuid NOT NULL UNIQUE REFERENCES users(id),   -- one university per head
  name          text NOT NULL,
  head_title    text NOT NULL DEFAULT 'Vice-Chancellor',     -- Chancellor / VC / Head
  head_name     text NOT NULL,
  address       text,
  contact_email citext,
  contact_phone text,
  status        org_status NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE colleges (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university_id  uuid NOT NULL REFERENCES universities(id),
  admin_user_id  uuid NOT NULL UNIQUE REFERENCES users(id),  -- principal / dean account
  name           text NOT NULL,
  address        text,
  affiliation    text,
  principal_name text NOT NULL,
  contact_email  citext,
  contact_phone  text,
  status         org_status NOT NULL DEFAULT 'pending',      -- university head approves
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (university_id, name)
);
CREATE INDEX idx_colleges_university ON colleges(university_id);

CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id  uuid NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  name        text NOT NULL,
  code        text NOT NULL,                                 -- CSE, ECE, MECH ...
  hod_name    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (college_id, code)
);

-- Instructor <-> college membership (college admin approves / removes)
CREATE TABLE college_instructors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id   uuid NOT NULL REFERENCES colleges(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  department_id uuid REFERENCES departments(id),
  status       membership_status NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  decided_by   uuid REFERENCES users(id),
  UNIQUE (college_id, user_id)
);
-- an instructor belongs to at most one college at a time
CREATE UNIQUE INDEX uq_instructor_one_college
  ON college_instructors(user_id) WHERE status IN ('pending','approved');

CREATE TABLE classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  college_id       uuid NOT NULL REFERENCES colleges(id),
  department_id    uuid NOT NULL REFERENCES departments(id),
  instructor_id    uuid NOT NULL REFERENCES users(id),
  name             text NOT NULL,                            -- e.g. "CSE-A 2022-26"
  branch           text NOT NULL,
  admission_year   smallint NOT NULL,
  passout_year     smallint NOT NULL,
  current_semester smallint NOT NULL DEFAULT 1 CHECK (current_semester BETWEEN 1 AND 12),
  hod_name         text,
  instructor_name  text NOT NULL,
  instructor_phone text,
  instructor_email citext,
  status           org_status NOT NULL DEFAULT 'active',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (passout_year > admission_year)
);
CREATE INDEX idx_classes_college    ON classes(college_id);
CREATE INDEX idx_classes_department ON classes(department_id);
CREATE INDEX idx_classes_instructor ON classes(instructor_id);

-- =====================================================================
-- 3. UNIQUE KEY SYSTEM
--    One row per issued key. Exactly one scope FK is set.
--    Format: PFX-XXXX-XXXX  (UNI- / COL- / CLS-), 8 chars from a
--    32-symbol alphabet w/o ambiguous chars (0/O, 1/I/L) => 40 bits,
--    generated with crypto.randomInt. Online guessing is blocked by
--    rate-limits + approval gates (see docs/ARCHITECTURE.md §5).
-- =====================================================================
CREATE TABLE access_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_value     text NOT NULL UNIQUE,
  university_id uuid REFERENCES universities(id) ON DELETE CASCADE,
  college_id    uuid REFERENCES colleges(id)     ON DELETE CASCADE,
  class_id      uuid REFERENCES classes(id)      ON DELETE CASCADE,
  status        key_status NOT NULL DEFAULT 'active',
  expires_at    timestamptz,                      -- NULL = never expires
  max_uses      integer,                          -- NULL = unlimited
  use_count     integer NOT NULL DEFAULT 0,
  created_by    uuid NOT NULL REFERENCES users(id),
  replaced_by   uuid REFERENCES access_keys(id),  -- set when rotated
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ( (university_id IS NOT NULL)::int
        + (college_id    IS NOT NULL)::int
        + (class_id      IS NOT NULL)::int = 1 ),
  CHECK (key_value ~ '^(UNI|COL|CLS)-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$')
);
-- at most ONE active key per scope object
CREATE UNIQUE INDEX uq_active_key_university ON access_keys(university_id) WHERE status = 'active' AND university_id IS NOT NULL;
CREATE UNIQUE INDEX uq_active_key_college    ON access_keys(college_id)    WHERE status = 'active' AND college_id IS NOT NULL;
CREATE UNIQUE INDEX uq_active_key_class      ON access_keys(class_id)      WHERE status = 'active' AND class_id IS NOT NULL;

CREATE TABLE key_usage_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      uuid REFERENCES access_keys(id) ON DELETE SET NULL,
  attempted_value text,                           -- what was typed (for failed guesses)
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  event       key_event NOT NULL,
  detail      text,
  ip          inet,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_key_logs_key  ON key_usage_logs(key_id, created_at DESC);
CREATE INDEX idx_key_logs_ip   ON key_usage_logs(ip, created_at DESC);

-- Student <-> class membership (instructor approves / removes)
CREATE TABLE class_enrollments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  via_key_id    uuid REFERENCES access_keys(id) ON DELETE SET NULL,
  roll_number   text,
  status        membership_status NOT NULL DEFAULT 'pending',
  remarks       text,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz,
  decided_by    uuid REFERENCES users(id),
  UNIQUE (class_id, student_id)
);
-- a student can hold only one live (pending/approved) enrollment
CREATE UNIQUE INDEX uq_student_one_class
  ON class_enrollments(student_id) WHERE status IN ('pending','approved');
CREATE UNIQUE INDEX uq_roll_in_class
  ON class_enrollments(class_id, roll_number) WHERE roll_number IS NOT NULL AND status = 'approved';
CREATE INDEX idx_enroll_class_status ON class_enrollments(class_id, status);

-- =====================================================================
-- 4. STUDENT DATA  (every table here is verification-gated)
-- =====================================================================
CREATE TABLE student_profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth  date,
  gender         text,
  address        text,
  guardian_name  text,
  guardian_email citext,
  guardian_phone text,
  summary        text,                                   -- resume summary
  linkedin_url   text,
  github_url     text,
  verification_status verification_status NOT NULL DEFAULT 'pending',
  verified_by    uuid REFERENCES users(id),
  verified_at    timestamptz,
  verifier_remarks text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id   uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  semester   smallint NOT NULL CHECK (semester BETWEEN 1 AND 12),
  code       text NOT NULL,
  name       text NOT NULL,
  credits    numeric(3,1) NOT NULL CHECK (credits >= 0),
  is_lab     boolean NOT NULL DEFAULT false,
  UNIQUE (class_id, semester, code)
);

CREATE TABLE attendance_records (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  attendance_date date NOT NULL,
  period      smallint NOT NULL DEFAULT 1,
  status      attendance_status NOT NULL,
  source      data_source NOT NULL DEFAULT 'instructor',
  claim_note  text,                                      -- student's justification on a claim
  -- instructor/CSV entries are inserted already 'verified'; student claims start 'pending'
  verification_status verification_status NOT NULL DEFAULT 'verified',
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  verifier_remarks text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_attendance_slot UNIQUE (student_id, subject_id, attendance_date, period)
);
CREATE INDEX idx_att_student ON attendance_records(student_id, subject_id);
CREATE INDEX idx_att_class_date ON attendance_records(class_id, attendance_date);

CREATE TABLE marks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id    uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  semester      smallint NOT NULL,                       -- denormalised from subjects for speed
  attempt       smallint NOT NULL DEFAULT 1,             -- >1 = backlog re-attempt
  internal_obtained numeric(5,2) NOT NULL DEFAULT 0,
  internal_max      numeric(5,2) NOT NULL DEFAULT 40,
  external_obtained numeric(5,2) NOT NULL DEFAULT 0,
  external_max      numeric(5,2) NOT NULL DEFAULT 60,
  grade         text,
  grade_points  numeric(3,1),                            -- 0..10, computed server-side
  is_pass       boolean NOT NULL DEFAULT false,
  source        data_source NOT NULL DEFAULT 'instructor',
  verification_status verification_status NOT NULL DEFAULT 'verified',
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  verifier_remarks text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject_id, attempt),
  CHECK (internal_obtained <= internal_max AND external_obtained <= external_max)
);
CREATE INDEX idx_marks_student_sem ON marks(student_id, semester);

-- Cached, recomputed whenever verified marks change
CREATE TABLE semester_results (
  student_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  semester          smallint NOT NULL,
  sgpa              numeric(4,2) NOT NULL,
  credits_registered numeric(5,1) NOT NULL,
  credits_earned    numeric(5,1) NOT NULL,
  cgpa_cumulative   numeric(4,2) NOT NULL,
  backlog_count     smallint NOT NULL DEFAULT 0,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, semester)
);

CREATE TABLE certificates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  category      certificate_category NOT NULL,
  issuer        text NOT NULL,
  issue_date    date,
  credential_url text,
  file_path     text NOT NULL,                           -- local path or S3 key
  file_sha256   text NOT NULL,                           -- tamper detection + duplicate detection
  -- public verification (QR): short code, shown only when verified
  verification_code text UNIQUE,
  verification_status verification_status NOT NULL DEFAULT 'pending',
  verified_by   uuid REFERENCES users(id),
  verified_at   timestamptz,
  verifier_remarks text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, file_sha256)
);
CREATE INDEX idx_cert_student ON certificates(student_id, verification_status);

CREATE TABLE portfolio_items (            -- projects, internships, publications
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         portfolio_type NOT NULL,
  title        text NOT NULL,
  organization text,                                      -- company / journal / venue
  role         text,
  description  text,
  bullets      text[] NOT NULL DEFAULT '{}',              -- resume bullet points
  tech_stack   text[] NOT NULL DEFAULT '{}',
  url          text,
  start_date   date,
  end_date     date,
  verification_status verification_status NOT NULL DEFAULT 'pending',
  verified_by  uuid REFERENCES users(id),
  verified_at  timestamptz,
  verifier_remarks text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_portfolio_student ON portfolio_items(student_id, type);

-- Verification queue / history (polymorphic pointer + status on the entity row)
CREATE TABLE verification_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id     uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id   uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  entity_type  verifiable_entity NOT NULL,
  entity_id    uuid NOT NULL,
  status       verification_status NOT NULL DEFAULT 'pending',
  student_note text,
  reviewer_id  uuid REFERENCES users(id),
  reviewer_remarks text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at  timestamptz
);
CREATE UNIQUE INDEX uq_open_verification
  ON verification_requests(entity_type, entity_id) WHERE status = 'pending';
CREATE INDEX idx_vr_queue ON verification_requests(class_id, status, submitted_at);

-- =====================================================================
-- 5. SKILLS, ROLES, SKILL-GAP, RESUME
-- =====================================================================
CREATE TABLE skills (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL UNIQUE,
  category  text                                         -- language, framework, tool, soft ...
);

CREATE TABLE career_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,                      -- "Web Developer", "Data Analyst"
  description text,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE role_skills (
  role_id         uuid NOT NULL REFERENCES career_roles(id) ON DELETE CASCADE,
  skill_id        uuid NOT NULL REFERENCES skills(id)       ON DELETE CASCADE,
  required_level  smallint NOT NULL CHECK (required_level BETWEEN 1 AND 5),
  weight          numeric(4,2) NOT NULL DEFAULT 1 CHECK (weight > 0),
  PRIMARY KEY (role_id, skill_id)
);

CREATE TABLE student_skills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES skills(id),
  proficiency  smallint NOT NULL CHECK (proficiency BETWEEN 1 AND 5),
  source       skill_source NOT NULL DEFAULT 'manual',
  certificate_id uuid REFERENCES certificates(id)    ON DELETE CASCADE,
  portfolio_id   uuid REFERENCES portfolio_items(id) ON DELETE CASCADE,
  verification_status verification_status NOT NULL DEFAULT 'pending',
  verified_by  uuid REFERENCES users(id),
  verified_at  timestamptz,
  verifier_remarks text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_id, skill_id, source, certificate_id, portfolio_id)
);
-- NULLs are distinct in UNIQUE constraints, so manual entries need their own guard
CREATE UNIQUE INDEX uq_student_skill_manual
  ON student_skills(student_id, skill_id) WHERE source = 'manual';
CREATE INDEX idx_student_skills ON student_skills(student_id);

CREATE TABLE learning_resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  title       text NOT NULL,
  provider    text,
  url         text,
  level       smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),  -- level it teaches up to
  est_hours   smallint
);

CREATE TABLE skill_gap_snapshots (          -- progress tracking: gaps closing over time
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id          uuid NOT NULL REFERENCES career_roles(id),
  gap_percent      numeric(5,2) NOT NULL,
  verified_gap_percent numeric(5,2) NOT NULL,            -- verified-only; used for leaderboard
  details          jsonb NOT NULL DEFAULT '[]',          -- per-skill have/required
  snapshot_date    date NOT NULL DEFAULT current_date,
  UNIQUE (student_id, role_id, snapshot_date)
);

-- Which role a student is currently targeting (feeds class/college skill-gap rollups)
CREATE TABLE student_target_roles (
  student_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES career_roles(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resumes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'My Resume',
  template_key  text NOT NULL DEFAULT 'classic',         -- classic|modern|compact|academic|minimal
  target_role_id uuid REFERENCES career_roles(id),
  section_order text[] NOT NULL DEFAULT
    '{summary,education,skills,projects,experience,certificates,achievements}',
  content       jsonb NOT NULL DEFAULT '{}',             -- user edits layered over verified data
  ats_score     smallint CHECK (ats_score BETWEEN 0 AND 100),
  ats_report    jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_resumes_student ON resumes(student_id);

-- =====================================================================
-- 6. CLASS LIFE: activities, announcements, assignments, timetable
-- =====================================================================
CREATE TABLE activities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  college_id  uuid NOT NULL REFERENCES colleges(id),     -- denormalised for roll-ups
  department_id uuid NOT NULL REFERENCES departments(id),
  type        activity_type NOT NULL,
  title       text NOT NULL,
  description text,
  venue       text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  is_published boolean NOT NULL DEFAULT false,           -- publish => appears on students' dashboards
  published_at timestamptz,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_activities_class ON activities(class_id, starts_at);

CREATE TABLE activity_participants (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  student_id  uuid NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  status      participation_status NOT NULL DEFAULT 'registered',
  remarks     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, student_id)
);

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         announcement_scope NOT NULL,
  class_id      uuid REFERENCES classes(id)      ON DELETE CASCADE,
  college_id    uuid REFERENCES colleges(id)     ON DELETE CASCADE,
  university_id uuid REFERENCES universities(id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text NOT NULL,
  is_pinned     boolean NOT NULL DEFAULT false,
  author_id     uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ( (class_id IS NOT NULL)::int + (college_id IS NOT NULL)::int
        + (university_id IS NOT NULL)::int = 1 )
);

CREATE TABLE assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id  uuid REFERENCES subjects(id) ON DELETE SET NULL,
  title       text NOT NULL,
  description text,
  due_at      timestamptz NOT NULL,
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE assignment_submissions (
  assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  submitted_at  timestamptz,
  file_path     text,
  grade_remarks text,
  PRIMARY KEY (assignment_id, student_id)
);

CREATE TABLE timetable_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- 1 = Monday
  starts_at   time NOT NULL,
  ends_at     time NOT NULL,
  room        text,
  CHECK (ends_at > starts_at)
);

CREATE TABLE mentoring_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id    uuid NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  instructor_id uuid NOT NULL REFERENCES users(id),
  note          text NOT NULL,
  visible_to_student boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE parent_notifications (         -- email/SMS placeholder log
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  reason      text NOT NULL,                              -- low_attendance, poor_marks, custom
  message     text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',             -- queued|sent|failed
  sent_by     uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 7. STUDENT EXTRAS: goals, study plan, badges
-- =====================================================================
CREATE TABLE student_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         goal_type NOT NULL,
  title        text NOT NULL,
  target_value numeric(6,2),
  current_value numeric(6,2),
  deadline     date,
  is_done      boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE study_plan_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id      uuid REFERENCES student_goals(id) ON DELETE SET NULL,
  title        text NOT NULL,
  planned_date date NOT NULL,
  duration_min smallint NOT NULL DEFAULT 60,
  is_done      boolean NOT NULL DEFAULT false
);

CREATE TABLE badges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,                       -- 'ATTENDANCE_STREAK_30', 'TOP_3'
  name        text NOT NULL,
  description text NOT NULL,
  icon        text
);

CREATE TABLE student_badges (
  student_id  uuid NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  badge_id    uuid NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, badge_id)
);

-- =====================================================================
-- 8. ANALYTICS CACHE, LEADERBOARD CONFIG, AI INSIGHTS
-- =====================================================================
-- Leaderboard weights (percent, must sum to 100). Class level is configurable by the
-- instructor; the college may set a default for its classes.
CREATE TABLE leaderboard_configs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id      uuid UNIQUE REFERENCES classes(id)  ON DELETE CASCADE,
  college_id    uuid UNIQUE REFERENCES colleges(id) ON DELETE CASCADE,
  w_marks       smallint NOT NULL DEFAULT 35,
  w_attendance  smallint NOT NULL DEFAULT 15,
  w_certificates smallint NOT NULL DEFAULT 15,
  w_skills      smallint NOT NULL DEFAULT 15,
  w_resume      smallint NOT NULL DEFAULT 10,
  w_activity    smallint NOT NULL DEFAULT 10,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((class_id IS NOT NULL)::int + (college_id IS NOT NULL)::int = 1),
  CHECK (w_marks + w_attendance + w_certificates + w_skills + w_resume + w_activity = 100),
  CHECK (w_marks >= 0 AND w_attendance >= 0 AND w_certificates >= 0
     AND w_skills >= 0 AND w_resume >= 0 AND w_activity >= 0)
);

-- Pre-computed metrics for any level; written by the nightly job and by event hooks.
-- level = 'student' | 'class' | 'department' | 'college' | 'university'
CREATE TABLE metric_snapshots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level       text NOT NULL CHECK (level IN ('student','class','department','college','university')),
  entity_id   uuid NOT NULL,
  semester    smallint,                                   -- NULL = overall
  period      date NOT NULL DEFAULT current_date,         -- snapshot day (for trends)
  metrics     jsonb NOT NULL,                             -- {avgSgpa, attendance, passPct, ...}
  score       numeric(5,2),                               -- 0..100 composite
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (level, entity_id, semester, period)
);
CREATE INDEX idx_metric_lookup ON metric_snapshots(level, entity_id, period DESC);

CREATE TABLE dropout_risk_scores (
  student_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period      date NOT NULL DEFAULT current_date,
  risk_score  numeric(5,2) NOT NULL CHECK (risk_score BETWEEN 0 AND 100),
  band        text NOT NULL CHECK (band IN ('low','medium','high')),
  factors     jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (student_id, period)
);

CREATE TABLE ai_insights (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level       text NOT NULL CHECK (level IN ('student','class','college','university')),
  entity_id   uuid NOT NULL,
  severity    insight_severity NOT NULL DEFAULT 'info',
  message     text NOT NULL,                              -- "CSE attendance dropped 8% this month"
  data        jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_insights_entity ON ai_insights(level, entity_id, created_at DESC);

-- =====================================================================
-- 9. CROSS-CUTTING: notifications, audit, bulk import
-- =====================================================================
CREATE TABLE notifications (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type      text NOT NULL,                                -- verification_done, announcement, join_request ...
  title     text NOT NULL,
  body      text,
  link      text,                                         -- front-end route to open
  is_read   boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role  user_role,
  action      text NOT NULL,                              -- 'marks.verify', 'key.rotate', 'student.remove'
  entity_type text,
  entity_id   uuid,
  -- scope columns make "show me everything in my class/college" a cheap indexed query
  class_id    uuid,
  college_id  uuid,
  university_id uuid,
  metadata    jsonb NOT NULL DEFAULT '{}',                -- before/after, remarks
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_class   ON audit_logs(class_id, created_at DESC);
CREATE INDEX idx_audit_college ON audit_logs(college_id, created_at DESC);
CREATE INDEX idx_audit_actor   ON audit_logs(actor_id, created_at DESC);

CREATE TABLE import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id    uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('attendance','marks','students')),
  file_name   text NOT NULL,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  total_rows  integer,
  ok_rows     integer,
  error_report jsonb NOT NULL DEFAULT '[]',               -- [{row, field, message}]
  created_by  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- =====================================================================
-- 10. VIEWS  (single source of truth for "who belongs where" and verified-only data)
-- =====================================================================
-- Student -> class -> department -> college -> university (approved enrollments only)
CREATE VIEW v_student_scope AS
SELECT e.student_id,
       e.roll_number,
       c.id            AS class_id,
       c.department_id AS department_id,
       c.college_id    AS college_id,
       col.university_id AS university_id
FROM class_enrollments e
JOIN classes  c   ON c.id = e.class_id
JOIN colleges col ON col.id = c.college_id
WHERE e.status = 'approved';

-- Verified-only attendance per student & subject
CREATE VIEW v_attendance_by_subject AS
SELECT student_id, subject_id, class_id,
       count(*) FILTER (WHERE status IN ('present','late','excused')) AS attended,
       count(*)                                                       AS held,
       round(100.0 * count(*) FILTER (WHERE status IN ('present','late','excused'))
             / NULLIF(count(*), 0), 2)                                AS percentage
FROM attendance_records
WHERE verification_status = 'verified'
GROUP BY student_id, subject_id, class_id;

-- Verified-only attendance overall
CREATE VIEW v_attendance_overall AS
SELECT student_id,
       sum(attended) AS attended,
       sum(held)     AS held,
       round(100.0 * sum(attended) / NULLIF(sum(held), 0), 2) AS percentage
FROM v_attendance_by_subject
GROUP BY student_id;

-- =====================================================================
-- 11. updated_at triggers
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','universities','colleges','classes','student_profiles','marks',
    'certificates','portfolio_items','resumes'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON %1$s
         FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

COMMIT;
