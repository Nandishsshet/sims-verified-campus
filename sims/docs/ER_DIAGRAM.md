# SIMS — ER Diagram

Source of truth is [`database/schema.sql`](../database/schema.sql). The diagram is split in three so it stays readable (render with any Mermaid viewer, e.g. GitHub or VS Code).

## A. Identity, hierarchy & keys

```mermaid
erDiagram
  USERS ||--o| UNIVERSITIES : "heads (1:1)"
  USERS ||--o| COLLEGES : "administers (1:1)"
  UNIVERSITIES ||--o{ COLLEGES : has
  COLLEGES ||--o{ DEPARTMENTS : has
  COLLEGES ||--o{ COLLEGE_INSTRUCTORS : employs
  USERS ||--o| COLLEGE_INSTRUCTORS : "is member"
  DEPARTMENTS ||--o{ CLASSES : groups
  COLLEGES ||--o{ CLASSES : hosts
  USERS ||--o{ CLASSES : "instructs"
  CLASSES ||--o{ CLASS_ENROLLMENTS : has
  USERS ||--o{ CLASS_ENROLLMENTS : "student joins"
  UNIVERSITIES ||--o{ ACCESS_KEYS : "scope"
  COLLEGES ||--o{ ACCESS_KEYS : "scope"
  CLASSES ||--o{ ACCESS_KEYS : "scope"
  ACCESS_KEYS ||--o{ KEY_USAGE_LOGS : logs
  ACCESS_KEYS ||--o{ CLASS_ENROLLMENTS : "via_key"
  USERS ||--o{ REFRESH_TOKENS : has
  USERS ||--o{ PASSWORD_RESET_TOKENS : has

  USERS {
    uuid id PK
    citext email UK
    text password_hash
    user_role role
    text full_name
  }
  UNIVERSITIES {
    uuid id PK
    uuid head_user_id FK
    text name
    org_status status
  }
  COLLEGES {
    uuid id PK
    uuid university_id FK
    uuid admin_user_id FK
    text name
    org_status status "pending-active-suspended"
  }
  DEPARTMENTS {
    uuid id PK
    uuid college_id FK
    text code
  }
  CLASSES {
    uuid id PK
    uuid college_id FK
    uuid department_id FK
    uuid instructor_id FK
    smallint admission_year
    smallint passout_year
  }
  ACCESS_KEYS {
    uuid id PK
    text key_value UK "CLS-8F3K-92QA"
    uuid university_id FK "exactly one scope FK"
    uuid college_id FK
    uuid class_id FK
    key_status status
    timestamptz expires_at
    int max_uses
    int use_count
  }
  CLASS_ENROLLMENTS {
    uuid id PK
    uuid class_id FK
    uuid student_id FK
    membership_status status "pending-approved-rejected-removed"
    text roll_number
  }
```

## B. Student data (all verification-gated)

```mermaid
erDiagram
  USERS ||--o| STUDENT_PROFILES : has
  CLASSES ||--o{ SUBJECTS : offers
  USERS ||--o{ ATTENDANCE_RECORDS : has
  SUBJECTS ||--o{ ATTENDANCE_RECORDS : for
  USERS ||--o{ MARKS : has
  SUBJECTS ||--o{ MARKS : for
  USERS ||--o{ SEMESTER_RESULTS : "cached SGPA/CGPA"
  USERS ||--o{ CERTIFICATES : uploads
  USERS ||--o{ PORTFOLIO_ITEMS : "projects / internships / publications"
  USERS ||--o{ VERIFICATION_REQUESTS : submits
  CLASSES ||--o{ VERIFICATION_REQUESTS : "queue"
  SKILLS ||--o{ STUDENT_SKILLS : ""
  USERS ||--o{ STUDENT_SKILLS : has
  CERTIFICATES ||--o{ STUDENT_SKILLS : "evidence"
  PORTFOLIO_ITEMS ||--o{ STUDENT_SKILLS : "evidence"
  CAREER_ROLES ||--o{ ROLE_SKILLS : requires
  SKILLS ||--o{ ROLE_SKILLS : ""
  SKILLS ||--o{ LEARNING_RESOURCES : "taught by"
  USERS ||--o| STUDENT_TARGET_ROLES : targets
  CAREER_ROLES ||--o{ STUDENT_TARGET_ROLES : ""
  USERS ||--o{ SKILL_GAP_SNAPSHOTS : "progress over time"
  USERS ||--o{ RESUMES : builds
  USERS ||--o{ STUDENT_GOALS : sets
  STUDENT_GOALS ||--o{ STUDY_PLAN_ITEMS : ""
  USERS ||--o{ STUDENT_BADGES : earns
  BADGES ||--o{ STUDENT_BADGES : ""

  VERIFICATION_REQUESTS {
    uuid id PK
    uuid class_id FK
    uuid student_id FK
    verifiable_entity entity_type "profile marks attendance certificate project skill"
    uuid entity_id "polymorphic"
    verification_status status
    text reviewer_remarks
  }
  MARKS {
    uuid id PK
    uuid student_id FK
    uuid subject_id FK
    smallint attempt "gt 1 means backlog retry"
    numeric internal_obtained
    numeric external_obtained
    numeric grade_points
    verification_status verification_status
  }
  CERTIFICATES {
    uuid id PK
    uuid student_id FK
    certificate_category category
    text file_sha256 "duplicate and tamper check"
    text verification_code UK "QR payload"
    verification_status verification_status
  }
  STUDENT_SKILLS {
    uuid id PK
    smallint proficiency "1-5"
    skill_source source "manual certificate project"
  }
  ROLE_SKILLS {
    smallint required_level "1-5"
    numeric weight
  }
```

## C. Class life, analytics & cross-cutting

```mermaid
erDiagram
  CLASSES ||--o{ ACTIVITIES : publishes
  ACTIVITIES ||--o{ ACTIVITY_PARTICIPANTS : tracks
  USERS ||--o{ ACTIVITY_PARTICIPANTS : joins
  CLASSES ||--o{ ANNOUNCEMENTS : "scope=class"
  COLLEGES ||--o{ ANNOUNCEMENTS : "scope=college"
  UNIVERSITIES ||--o{ ANNOUNCEMENTS : "scope=university"
  CLASSES ||--o{ ASSIGNMENTS : sets
  ASSIGNMENTS ||--o{ ASSIGNMENT_SUBMISSIONS : receives
  CLASSES ||--o{ TIMETABLE_ENTRIES : schedules
  CLASSES ||--o{ MENTORING_NOTES : ""
  USERS ||--o{ PARENT_NOTIFICATIONS : ""
  CLASSES ||--o| LEADERBOARD_CONFIGS : "weights"
  COLLEGES ||--o| LEADERBOARD_CONFIGS : "default weights"
  USERS ||--o{ DROPOUT_RISK_SCORES : ""
  USERS ||--o{ NOTIFICATIONS : receives
  USERS ||--o{ AUDIT_LOGS : "acts"
  CLASSES ||--o{ IMPORT_JOBS : ""

  METRIC_SNAPSHOTS {
    uuid id PK
    text level "student class department college university"
    uuid entity_id
    smallint semester
    date period "for trend charts"
    jsonb metrics
    numeric score "0-100"
  }
  AUDIT_LOGS {
    bigint id PK
    uuid actor_id FK
    text action "marks.verify key.rotate student.remove"
    uuid class_id "scope columns"
    uuid college_id
    uuid university_id
    jsonb metadata
  }
  AI_INSIGHTS {
    uuid id PK
    text level
    uuid entity_id
    insight_severity severity
    text message
  }
```

## D. Notes

- **Scope derivation views:** `v_student_scope` (student → class → department → college → university), `v_attendance_by_subject`, `v_attendance_overall` (verified rows only).
- **Integrity enforced by the DB (not just app code):**
  - exactly one scope FK per `access_keys` / `announcements` / `leaderboard_configs` row (`CHECK`);
  - ≤ 1 active key per university / college / class (partial unique index);
  - a student has ≤ 1 live (pending/approved) enrollment; an instructor belongs to ≤ 1 live college;
  - leaderboard weights must sum to 100;
  - duplicate certificate file per student rejected (`UNIQUE(student_id, file_sha256)`);
  - only one open verification request per entity.
- **No scores on entity tables** — all composites live in `metric_snapshots`.
