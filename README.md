# Thanima Quiz

A minimal quiz website with tab-switch detection, per-question timers,
randomized question/option order, server-side scoring, and a MongoDB-backed
admin panel. Built for [Thanima](https://github.com/ThanimaVITC).

## Features

- **Tab-switch detection** - switching away from the tab/window during the quiz
  immediately disqualifies the attempt (via the Page Visibility API).
- **Randomized per attempt** - question order, MCQ option order, and which
  subset of the question bank is used are all reshuffled server-side per attempt.
- **Answers never reach the browser** - the client only ever receives question
  text and options; scoring happens entirely on the server against an
  in-progress "attempt" record, so there's no answer key to find via devtools.
  The score is never shown back to the participant either.
- **Configurable timer** - one time limit, applied to every question.
- **Two page layouts** - one question per page (its own countdown, confirm-then-advance),
  or all questions on one page with a single overall countdown and a submit button.
- **Quiz lifecycle states** - `before` / `active` / `done`, each with its own
  message, toggleable from the admin panel.
- **Admin panel** (`/admin`) - edit site/quiz settings, upload new quiz JSON
  files, delete old ones, and browse recent results, all backed by MongoDB.
- **Dark-first UI** - light-blue card on a navy background, warm yellow accents,
  with a light/dark toggle.
- **No build step** - plain HTML/CSS/JS on the frontend; a small Node/Express
  server on the backend.

## Project structure

```
thanima-quiz/
  flake.nix          Nix dev shell providing Node.js (`nix develop`)
  package.json        Backend dependencies (express, mongodb, dotenv, multer, smol-toml)
  server.js            Express server - public quiz API, admin API, static hosting
  .env.example          Template for MONGODB_URI / ADMIN_PASSWORD / etc.
  public/                Publicly served frontend (only this folder is ever
                          exposed as static files - nothing else is reachable
                          by URL, including quiz.toml or quizzes/*.json)
    index.html / style.css / app.js
    assets/               Logo / favicon
  admin/                  Admin panel - served under /admin, gated by a
                          password-only login (session cookie, ADMIN_PASSWORD)
    index.html / login.html / app.js / admin.css
  quiz.toml               Optional seed data - read once, only the first time
                          the server connects to an empty database. Not
                          tracked in git (see .gitignore) since a real quiz
                          bank contains answers.
  quizzes/<file>.json      Optional seed data - same as above. If absent,
                          just upload your first quiz via the admin panel.
```

## Getting started

```sh
nix develop              # provides Node.js - see flake.nix
npm install
cp .env.example .env     # fill in MONGODB_URI and ADMIN_PASSWORD
npm start
```

The server starts immediately (it doesn't block on the MongoDB connection) and
serves everything - public site, admin panel, and API - on
`http://localhost:3000` by default.

**The app requires MongoDB to actually function** (quiz-taking and the admin
panel both need it) - without a working `MONGODB_URI`, visitors just see a
"temporarily unavailable" message. If `quiz.toml` and `quizzes/<file>.json`
exist on disk, the very first successful connection to an empty database
seeds itself from them; otherwise, just log into `/admin` and upload your
first quiz JSON there. Either way, MongoDB is authoritative from that point
on - those on-disk files (if present) are never read again.

## Admin panel - `/admin`

Protected by a password-only login (no username field) at `/admin/login`:
enter `ADMIN_PASSWORD` from `.env` and you get an 8-hour session cookie. If
that variable isn't set, `/admin` returns 503 rather than allowing
unauthenticated access.

From there you can:
- Edit site/quiz settings (name, description, timer, cooldown, questions per
  attempt, page layout, and the `before`/`active`/`done` lifecycle state + text)
- Upload a new quiz JSON file (validated on upload - see the format below) and
  pick which uploaded quiz is currently active
- Rename a quiz's title in place, without re-uploading it
- Delete old quizzes (re-enter `ADMIN_PASSWORD` to confirm - a session cookie
  alone isn't enough for a destructive action like this)
- Browse the 50 most recent results (name, registration number, score,
  disqualified, finished-at), export the full result set as CSV - for all
  quizzes or filtered to just one - via `GET /api/admin/results/export`
- Clear results (also password-confirmed), for all quizzes or just one

## Quiz JSON format

Used both for the on-disk seed file and for anything uploaded via the admin
panel:

```json
{
  "id": "gandhi-quiz",
  "title": "Mahatma Gandhi Quiz",
  "description": "...",
  "questions": [
    {
      "id": "q1",
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "correctIndex": 0
    }
  ]
}
```

`correctIndex` refers to the option's position in this array. Options are
shuffled per attempt, but correctness is tracked by value, not index - and
`correctIndex`/the correct option's text is never sent to the browser.

## How an attempt works

1. `GET /api/config` - the intro screen's title/description/timer/etc., plus
   the active quiz's title and description. No questions yet.
2. `POST /api/attempt/start` `{ participant, registrationNumber }` - validated
   server-side (registration number must match `^\d{2}[A-Z]{3}\d{4}$`, e.g.
   `00XXX0000`). The server picks a random subset of the active quiz's
   questions, shuffles each question's options, and stores the full record
   (including correct answers) server-side under a generated `attemptId`. The
   response has questions and options only - no correct answers.
3. The quiz runs entirely client-side from there (timers, tab-switch
   detection, confirm-then-advance) using only that data.
4. `POST /api/attempt/:id/finish` `{ disqualified, answers }` - the server
   looks up the attempt, grades the submitted answers against the record it
   already has (any tampering with the client can't produce a different
   answer key), writes the result, and deletes the in-progress attempt
   record. Abandoned attempts (browser closed mid-quiz) auto-expire after 2
   hours via a MongoDB TTL index, since they hold the answer key.

## Results

Written to the `results` collection in MongoDB:

```json
{
  "quizId": "gandhi-quiz",
  "participant": "Jane Doe",
  "registrationNumber": "00XXX0000",
  "startedAt": "...",
  "finishedAt": "...",
  "disqualified": false,
  "score": 17,
  "total": 20,
  "answers": [
    { "questionId": "q1", "selected": "...", "correct": true }
  ]
}
```

## License

MIT - see [LICENSE](LICENSE).
