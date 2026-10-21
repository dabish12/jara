# DDEO-SRATMS - Dembi Dollo Education Office, Student Roster and Transcript Management System

## Run it (secure server mode)
Needs Node.js 22.5 or newer. Nothing else to install.

    node server.js

Open http://localhost:8080 . On the first start the server prints the Education Office login
(username `admin` and a random password). You must change that password at the first sign-in.
Optional: `PORT=8080  HOST=0.0.0.0  DB_FILE=/path/ddeo.db  ADMIN_PASSWORD=...  SECURE_COOKIES=1`

For a real deployment put the server behind HTTPS (Caddy, nginx or similar), set `SECURE_COOKIES=1`,
and back up the file `ddeo.db` regularly (copy it while the server is stopped, or use sqlite3 .backup).

Opening `index.html` directly from the disk still works, but then the data and the passwords are in the
browser only. Use that only for a trial, never for real school data.

## Where the security is (server mode)
Everything below is done by `server.js` and the database file `ddeo.db`, not by the web page:
- Passwords exist only as salted scrypt hashes in the `accounts` table. The page never holds a hash.
- Sign-in creates a random 256-bit session kept in the `sessions` table; the browser only holds an
  HttpOnly, SameSite=Strict cookie. A session ends after 15 minutes without use, at sign-out and when the password changes.
- Wrong sign-ins, wrong Student IDs and wrong names are counted in the `throttle` table and lock the form for longer each time.
- Every request is checked against the signed-in role:
  - Education Office: receives statistics only (no student names or IDs, no marks of single students shown by name), can register schools, set the registration window.
  - School admin: receives and changes only the data of its own school; assigns teachers, assessment values, result release.
  - Home room teacher: receives only the class; can change only conduct and absent days.
  - Subject teacher: receives only own subject and classes; can change only Test / Assignment, Mid exam and Final exam of those; the server computes the total.
- After a subject teacher submits, the account is deactivated and that result is sealed: the school admin and the home room teacher cannot change it (the server ignores such changes).
  The school admin can reset the teacher account so the teacher can correct and submit again.
- Students see their result only with Student ID + first name, only inside the dates the school admin set.
  Students from Grade 10 up send a registration request only inside the dates the Education Office set; the school admin approves it.
- Security headers (Content-Security-Policy, X-Frame-Options, no-referrer, nosniff, HSTS when SECURE_COOKIES=1).

## Student ID
`DD` + school code + `-` + registration number + `-` + year of registration, for example `DD001-0023-2026`.
The school admin can change the date of registration; the year part of the ID follows the date.

## Limits (please read)
- A web page cannot prevent screenshots or photos of the screen. The page hides its content when the window loses focus
  or a capture key is pressed and blocks copying, which only makes casual capture harder.
- `database.sql` is the relational design (with triggers that enforce the assessment values, the total of 100 and the sealed
  results inside SQL). The running server stores the application data as one JSON document in SQLite and enforces the same rules in code.
  If you later move to MySQL/PostgreSQL, use `database.sql` and keep the same rules.
- Two school admins saving at the same moment: the last save wins.
