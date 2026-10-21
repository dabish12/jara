-- =====================================================================
-- DDEO-SRATMS - Dembi Dollo Education Office
-- Student Roster and Transcript Management System - database schema
-- Roles: Education Office admin (monitor + statistics), school admin, home room teacher, subject teacher
-- SQLite syntax. Window functions (RANK) need SQLite 3.25+ or MySQL 8+.
--
-- The web app keeps the same structure in the browser (IndexedDB).
-- Use this file when the data is moved to a real SQL server.
-- =====================================================================

PRAGMA foreign_keys = ON;

-- Education Office super admin
CREATE TABLE IF NOT EXISTS super_admin (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL DEFAULT 'admin',
    password_hash TEXT NOT NULL
);

-- Schools: every school has its own admin account and its own workspace
CREATE TABLE IF NOT EXISTS schools (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL,
    academic_year  TEXT    NOT NULL,
    admin_username TEXT    NOT NULL UNIQUE,
    admin_hash     TEXT    NOT NULL,
    pass_mark      REAL    NOT NULL DEFAULT 50 CHECK (pass_mark BETWEEN 1 AND 100),
    record_officer TEXT,
    director       TEXT,
    town           TEXT    NOT NULL DEFAULT 'Dembi Dollo',   -- printed on the transcript
    region         TEXT    NOT NULL DEFAULT 'Oromia',        -- printed on the transcript
    assess_test    INTEGER NOT NULL DEFAULT 20,              -- value of Test / Assignment, Mid exam and Final exam; given by the school admin
    assess_mid     INTEGER NOT NULL DEFAULT 30,
    assess_final   INTEGER NOT NULL DEFAULT 50,
    code           TEXT    NOT NULL UNIQUE,                  -- 3 digits, first part of the Student IDs of this school
    next_seq       INTEGER NOT NULL DEFAULT 0,               -- last used Student ID number of this school
    result_starts_at TEXT,                                   -- students can see their results from this date and time
    result_ends_at   TEXT,                                   -- ... until this date and time
    result_semester  TEXT NOT NULL DEFAULT 'all' CHECK (result_semester IN ('all', '1', '2')),
    logo_left      BLOB,                                     -- transcript logo, changed by the school admin
    logo_right     BLOB,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- the three assessment values must add up to 100
CREATE TRIGGER IF NOT EXISTS trg_assess_100_ins BEFORE INSERT ON schools
WHEN NEW.assess_test + NEW.assess_mid + NEW.assess_final <> 100
BEGIN SELECT RAISE(ABORT, 'Test, Mid and Final values must add up to 100'); END;
CREATE TRIGGER IF NOT EXISTS trg_assess_100_upd BEFORE UPDATE ON schools
WHEN NEW.assess_test + NEW.assess_mid + NEW.assess_final <> 100
BEGIN SELECT RAISE(ABORT, 'Test, Mid and Final values must add up to 100'); END;

-- Subject columns of the roster. The school admin adds and removes them (max 16).
CREATE TABLE IF NOT EXISTS subjects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    position   INTEGER NOT NULL,              -- column order on the roster
    UNIQUE (school_id, name)
);

-- Keep at most 16 subject columns per school
CREATE TRIGGER IF NOT EXISTS trg_subjects_max16
BEFORE INSERT ON subjects
WHEN (SELECT COUNT(*) FROM subjects WHERE school_id = NEW.school_id) >= 16
BEGIN
    SELECT RAISE(ABORT, 'A roster holds at most 16 subjects');
END;

CREATE TABLE IF NOT EXISTS students (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id  INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    full_name  TEXT    NOT NULL CHECK (length(full_name) >= 3),
    age        INTEGER CHECK (age BETWEEN 5 AND 40),
    sex        TEXT    NOT NULL CHECK (sex IN ('M', 'F')),
    grade      INTEGER NOT NULL CHECK (grade BETWEEN 9 AND 12),
    section    TEXT    NOT NULL DEFAULT '',
    student_no TEXT UNIQUE CHECK (student_no IS NULL OR student_no GLOB 'DD[0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),
                                                      -- Student ID = DD + school code - registration number - year of registration, e.g. DD001-0023-2026
    registered_on TEXT,                               -- date of registration (the school admin can change it; the year part of the ID follows it)
    registered_for TEXT,                              -- academic year the student registered for himself/herself (Grade 10 and up)
    registered_at  TEXT,
    pending_year   TEXT,                              -- registration request waiting for the school admin's approval
    pending_grade  INTEGER CHECK (pending_grade BETWEEN 10 AND 12),
    pending_stream TEXT,
    pending_at     TEXT,
    birth_date TEXT,                                  -- free text (Ethiopian or Gregorian date)
    nationality TEXT   NOT NULL DEFAULT 'Ethiopian',
    stream     TEXT CHECK (stream IN ('Natural Science', 'Social Science')),   -- Grade 11 and 12 stream (NULL for Grade 9-10)
    entry_year TEXT,                                  -- Year of entry (Grade 9)
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    CHECK (grade <> 11 OR stream IS NOT NULL),        -- every Grade 11 student chooses Natural Science or Social Science
    UNIQUE (school_id, full_name, grade, section)
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students (school_id, grade, section, full_name);

-- Marks: one row per student, academic year, semester (1 or 2) and subject
CREATE TABLE IF NOT EXISTS marks (
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    academic_year TEXT    NOT NULL,
    semester      INTEGER NOT NULL CHECK (semester IN (1, 2)),
    score         REAL    NOT NULL CHECK (score BETWEEN 0 AND 100),
    PRIMARY KEY (student_id, subject_id, academic_year, semester)
);

-- Audit log: who changed what and when
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT    NOT NULL DEFAULT (datetime('now')),
    username  TEXT    NOT NULL,
    school_id INTEGER,
    action    TEXT    NOT NULL
);

-- ---------------------------------------------------------------------
-- Annual subject mark = (Semester I + Semester II) / 2 (only when both exist)
-- ---------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_annual_marks AS
SELECT m1.student_id, m1.subject_id, m1.academic_year,
       ROUND((m1.score + m2.score) / 2.0, 1) AS annual_score
FROM marks m1
JOIN marks m2
  ON  m2.student_id = m1.student_id AND m2.subject_id = m1.subject_id
  AND m2.academic_year = m1.academic_year
WHERE m1.semester = 1 AND m2.semester = 2;

-- Total, average and rank per class for each semester
CREATE VIEW IF NOT EXISTS v_semester_results AS
WITH t AS (
    SELECT s.school_id, s.id AS student_id, s.full_name, s.grade, s.section,
           m.academic_year, m.semester,
           SUM(m.score)  AS total,
           ROUND(AVG(m.score), 1) AS average
    FROM students s JOIN marks m ON m.student_id = s.id
    GROUP BY s.id, m.academic_year, m.semester
)
SELECT t.*,
       RANK() OVER (PARTITION BY school_id, grade, section, academic_year, semester ORDER BY total DESC) AS class_rank
FROM t;

-- Promotion criteria (Grade 12 uses Passed / Failed instead of Promoted / Detained):
--   0 subjects below 50 and average >= 50 -> Promoted      1 subject below 50 and average >= 52 -> Promoted
--   2 subjects below 50 and average >= 54 -> Promoted      3 or more below 50, or any other case  -> Detained
CREATE VIEW IF NOT EXISTS v_annual_results AS
WITH t AS (
    SELECT s.school_id, s.id AS student_id, s.full_name, s.grade, s.section,
           a.academic_year,
           ROUND(SUM(a.annual_score), 1) AS total,
           ROUND(AVG(a.annual_score), 1) AS average,
           SUM(CASE WHEN a.annual_score < 50 THEN 1 ELSE 0 END) AS subjects_below_50
    FROM students s JOIN v_annual_marks a ON a.student_id = s.id
    GROUP BY s.id, a.academic_year
)
SELECT t.*,
       RANK() OVER (PARTITION BY school_id, grade, section, academic_year ORDER BY total DESC) AS class_rank,
       CASE WHEN (t.subjects_below_50 = 0 AND t.average >= 50)
              OR (t.subjects_below_50 = 1 AND t.average >= 52)
              OR (t.subjects_below_50 = 2 AND t.average >= 54)
            THEN CASE WHEN t.grade = 12 THEN 'Passed' ELSE 'Promoted' END
            ELSE CASE WHEN t.grade = 12 THEN 'Failed' ELSE 'Detained' END END AS remark
FROM t;

-- ---------------------------------------------------------------------
-- Teacher accounts (created by the school admin)
--   homeroom : prepares the roster of ONE class (grade + section)
--   subject  : enters marks (0-100) for the subjects and classes assigned below, nothing else
-- Usernames are unique across super_admin, schools.admin_username and staff.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS staff (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    school_id     INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    full_name     TEXT    NOT NULL,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL CHECK (role IN ('homeroom', 'subject')),
    grade         INTEGER CHECK (grade BETWEEN 9 AND 12),     -- home room teacher only
    section       TEXT    NOT NULL DEFAULT '',                -- home room teacher only
    submitted_at  TEXT,                                       -- subject teacher: set when the final results are submitted; the account is then deactivated for marks entry
    submitted_for TEXT,                                       -- e.g. 'Semester I, 2026/2027'
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Reset by the school admin: UPDATE staff SET submitted_at = NULL, submitted_for = NULL WHERE id = :staff_id;
-- one home room teacher per class
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_homeroom ON staff (school_id, grade, section) WHERE role = 'homeroom';

-- Subjects of a subject teacher
CREATE TABLE IF NOT EXISTS staff_subjects (
    staff_id   INTEGER NOT NULL REFERENCES staff(id)    ON DELETE CASCADE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (staff_id, subject_id)
);
-- Classes of a subject teacher (section '' = every section of the grade)
CREATE TABLE IF NOT EXISTS staff_classes (
    staff_id INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    grade    INTEGER NOT NULL CHECK (grade BETWEEN 9 AND 12),
    section  TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (staff_id, grade, section)
);

-- A subject teacher may write a mark only when the subject AND the class are assigned to him/her.
-- (The web app checks this too. On a SQL server use the same check in the stored procedure / API.)
-- Example check for staff :staff_id writing a mark of :student_id for :subject_id:
--   SELECT 1 FROM staff_subjects ss
--   JOIN staff_classes sc ON sc.staff_id = ss.staff_id
--   JOIN students st ON st.id = :student_id AND st.grade = sc.grade AND (sc.section = '' OR sc.section = st.section)
--   WHERE ss.staff_id = :staff_id AND ss.subject_id = :subject_id;

-- ---------------------------------------------------------------------
-- Transcript: the academic year in which a student studied each grade.
-- It is filled when marks are saved (student's grade + academic year of the marks).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_grade_years (
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    grade         INTEGER NOT NULL CHECK (grade BETWEEN 9 AND 12),
    academic_year TEXT    NOT NULL,
    PRIMARY KEY (student_id, grade)
);

-- Conduct and days absent, entered with the roster for each semester
CREATE TABLE IF NOT EXISTS student_semester_records (
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    academic_year TEXT    NOT NULL,
    semester      INTEGER NOT NULL CHECK (semester IN (1, 2)),
    conduct       TEXT,
    absent_days   INTEGER CHECK (absent_days BETWEEN 0 AND 366),
    PRIMARY KEY (student_id, academic_year, semester)
);

-- Transcript summary rows of every grade: total, average, rank, conduct and absent days per semester
-- (the annual remark comes from v_annual_results). Rank is the class rank of that academic year.
CREATE VIEW IF NOT EXISTS v_transcript_summary AS
SELECT r.student_id, r.school_id, g.grade AS transcript_grade, r.academic_year, r.semester,
       r.total, r.average, r.class_rank, c.conduct, c.absent_days
FROM v_semester_results r
JOIN student_grade_years g ON g.student_id = r.student_id AND g.academic_year = r.academic_year
LEFT JOIN student_semester_records c ON c.student_id = r.student_id AND c.academic_year = r.academic_year AND c.semester = r.semester;

-- Transcript rows: one row per student, grade and subject with 1st Sem, 2nd Sem and Ave.
CREATE VIEW IF NOT EXISTS v_transcript AS
SELECT st.id AS student_id, st.school_id, st.full_name, g.grade, g.academic_year,
       sb.id AS subject_id, sb.name AS subject, sb.position,
       m1.score AS sem1, m2.score AS sem2,
       CASE WHEN m1.score IS NOT NULL AND m2.score IS NOT NULL
            THEN ROUND((m1.score + m2.score) / 2.0, 1) END AS ave
FROM students st
JOIN student_grade_years g ON g.student_id = st.id
JOIN subjects sb           ON sb.school_id = st.school_id
LEFT JOIN marks m1 ON m1.student_id = st.id AND m1.subject_id = sb.id AND m1.academic_year = g.academic_year AND m1.semester = 1
LEFT JOIN marks m2 ON m2.student_id = st.id AND m2.subject_id = sb.id AND m2.academic_year = g.academic_year AND m2.semester = 2
WHERE m1.score IS NOT NULL OR m2.score IS NOT NULL;

-- Example: transcript of student 7
--   SELECT grade, academic_year, subject, sem1, sem2, ave FROM v_transcript WHERE student_id = 7 ORDER BY grade, position;

-- ---------------------------------------------------------------------
-- Education Office statistics
-- ---------------------------------------------------------------------
-- How many of the expected marks (students x subjects) the teachers have entered, per school and semester
CREATE VIEW IF NOT EXISTS v_marks_progress AS
SELECT sc.id AS school_id, sc.name AS school, sc.academic_year, s.semester,
       (SELECT COUNT(*) FROM marks m JOIN students st ON st.id = m.student_id
         WHERE st.school_id = sc.id AND m.academic_year = sc.academic_year AND m.semester = s.semester) AS entered,
       (SELECT COUNT(*) FROM students WHERE school_id = sc.id) * (SELECT COUNT(*) FROM subjects WHERE school_id = sc.id) AS expected
FROM schools sc CROSS JOIN (SELECT 1 AS semester UNION ALL SELECT 2) s;

-- Students, sex and pass rate per school (current academic year of each school)
CREATE VIEW IF NOT EXISTS v_school_statistics AS
SELECT sc.id AS school_id, sc.name AS school, sc.academic_year,
       COUNT(DISTINCT st.id) AS students,
       SUM(CASE WHEN st.sex = 'M' THEN 1 ELSE 0 END) AS male,
       SUM(CASE WHEN st.sex = 'F' THEN 1 ELSE 0 END) AS female,
       (SELECT COUNT(*) FROM staff f WHERE f.school_id = sc.id) AS teachers,
       (SELECT COUNT(*) FROM v_annual_results r WHERE r.school_id = sc.id AND r.academic_year = sc.academic_year) AS assessed,
       (SELECT COUNT(*) FROM v_annual_results r WHERE r.school_id = sc.id AND r.academic_year = sc.academic_year
          AND r.remark IN ('Passed', 'Promoted')) AS passed
FROM schools sc LEFT JOIN students st ON st.school_id = sc.id
GROUP BY sc.id;

-- ---------------------------------------------------------------------
-- Student self-registration window (set by the Education Office admin)
-- Grade 9 students are registered by the school admin (who gives the Student ID).
-- From Grade 10 up the student registers with Student ID + first name inside the window.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS registration_window (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    academic_year TEXT NOT NULL,
    starts_at     TEXT NOT NULL,
    ends_at       TEXT NOT NULL
);

-- SECURITY NOTES for the SQL / server version
--  * Passwords: store only salted PBKDF2/Argon2/bcrypt hashes (never plain text); the web app already uses PBKDF2-SHA256.
--  * Every query uses prepared statements (bound parameters); never build SQL from typed text.
--  * Student result page: look up by (student_no, first name), answer only inside school.result_starts_at..result_ends_at,
--    give one generic error for a wrong ID or name, and rate-limit by IP address and by Student ID.
--  * Self-registration: one request changes only the student found by (student_no, first name); check registration_window on the server.
--  * Serve over HTTPS only; enforce the roles (office / school / homeroom / subject) on the server for every request.

-- ---------------------------------------------------------------------
-- Test / Assignment, Mid exam and Final exam of every subject and semester.
-- marks.score (out of 100) is the total of the three parts and is written by the trigger below,
-- so a total can never be typed in by hand.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS marks_parts (
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id    INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    academic_year TEXT    NOT NULL,
    semester      INTEGER NOT NULL CHECK (semester IN (1, 2)),
    test_score    REAL CHECK (test_score >= 0),
    mid_score     REAL CHECK (mid_score >= 0),
    final_score   REAL CHECK (final_score >= 0),
    PRIMARY KEY (student_id, subject_id, academic_year, semester)
);
-- each part may not exceed the value the school admin gave it
CREATE TRIGGER IF NOT EXISTS trg_parts_max BEFORE INSERT ON marks_parts
WHEN NEW.test_score  > (SELECT assess_test  FROM schools WHERE id = (SELECT school_id FROM students WHERE id = NEW.student_id))
  OR NEW.mid_score   > (SELECT assess_mid   FROM schools WHERE id = (SELECT school_id FROM students WHERE id = NEW.student_id))
  OR NEW.final_score > (SELECT assess_final FROM schools WHERE id = (SELECT school_id FROM students WHERE id = NEW.student_id))
BEGIN SELECT RAISE(ABORT, 'A mark is above the value of its assessment'); END;
CREATE TRIGGER IF NOT EXISTS trg_parts_total AFTER INSERT ON marks_parts
WHEN NEW.test_score IS NOT NULL AND NEW.mid_score IS NOT NULL AND NEW.final_score IS NOT NULL
BEGIN
    INSERT OR REPLACE INTO marks(student_id, subject_id, academic_year, semester, score)
    VALUES (NEW.student_id, NEW.subject_id, NEW.academic_year, NEW.semester, NEW.test_score + NEW.mid_score + NEW.final_score);
END;

-- ---------------------------------------------------------------------
-- Submitted (sealed) results: after a subject teacher submits, nobody but the teacher
-- (after the school admin resets the account) can change those marks.
-- The server writes the caller's role into app_session before every request.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS submission_seals (
    staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
    academic_year TEXT    NOT NULL,
    semester      INTEGER NOT NULL CHECK (semester IN (1, 2)),
    sealed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (staff_id, academic_year, semester)
);
CREATE TABLE IF NOT EXISTS app_session (id INTEGER PRIMARY KEY CHECK (id = 1), role TEXT);
INSERT OR IGNORE INTO app_session(id, role) VALUES (1, '');
CREATE VIEW IF NOT EXISTS v_sealed AS
SELECT st.id AS student_id, ss.subject_id, sl.academic_year, sl.semester
FROM submission_seals sl
JOIN staff f           ON f.id = sl.staff_id
JOIN staff_subjects ss ON ss.staff_id = sl.staff_id
JOIN staff_classes sc  ON sc.staff_id = sl.staff_id
JOIN students st       ON st.school_id = f.school_id AND st.grade = sc.grade AND (sc.section = '' OR sc.section = st.section);
CREATE TRIGGER IF NOT EXISTS trg_marks_sealed_upd BEFORE UPDATE ON marks
WHEN (SELECT role FROM app_session WHERE id = 1) IN ('school', 'homeroom')
 AND EXISTS (SELECT 1 FROM v_sealed v WHERE v.student_id = OLD.student_id AND v.subject_id = OLD.subject_id AND v.academic_year = OLD.academic_year AND v.semester = OLD.semester)
BEGIN SELECT RAISE(ABORT, 'This result was submitted by the subject teacher and cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trg_marks_sealed_del BEFORE DELETE ON marks
WHEN (SELECT role FROM app_session WHERE id = 1) IN ('school', 'homeroom')
 AND EXISTS (SELECT 1 FROM v_sealed v WHERE v.student_id = OLD.student_id AND v.subject_id = OLD.subject_id AND v.academic_year = OLD.academic_year AND v.semester = OLD.semester)
BEGIN SELECT RAISE(ABORT, 'This result was submitted by the subject teacher and cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS trg_parts_sealed_upd BEFORE UPDATE ON marks_parts
WHEN (SELECT role FROM app_session WHERE id = 1) IN ('school', 'homeroom')
 AND EXISTS (SELECT 1 FROM v_sealed v WHERE v.student_id = OLD.student_id AND v.subject_id = OLD.subject_id AND v.academic_year = OLD.academic_year AND v.semester = OLD.semester)
BEGIN SELECT RAISE(ABORT, 'This result was submitted by the subject teacher and cannot be changed'); END;

-- Example: roster data of Grade 10 section A, Semester 1
--   SELECT * FROM v_semester_results
--   WHERE school_id = 1 AND grade = 10 AND section = 'A' AND academic_year = '2026/2027' AND semester = 1
--   ORDER BY full_name;
