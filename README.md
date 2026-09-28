# ormapadippu

A minimal, dependency-light quiz website with tab-switch detection, per-question
timers, randomized question/option order, and MongoDB-backed result storage.
Built for [Thanima](https://github.com/ThanimaVITC).

## Features

- **Tab-switch detection** — switching away from the tab/window during the quiz
  immediately disqualifies the attempt (via the Page Visibility API).
- **Randomized per attempt** — question order, MCQ option order, and (optionally)
  which subset of the question bank is used are all reshuffled every attempt.
- **Configurable timer** — one time limit, applied to every question, set in
  `quiz.toml`.
- **Two page layouts** — one question per page (its own countdown, confirm-then-advance),
  or all questions on one page with a single overall countdown and a submit button.
- **Quiz lifecycle states** — `before` / `active` / `done`, each with its own
  message, so you can open and close submissions without touching code.
- **No answers revealed** — the app never shows which option was correct, during
  or after the quiz.
- **MongoDB-backed results** — each attempt (name, registration number, score,
  per-question answers, disqualification status) is saved via a small Express API.
- **Dark-first UI** — light-blue card on a navy background, warm yellow accents,
  with a light/dark toggle.
- **No build step** — plain HTML/CSS/JS on the frontend; a small Node/Express
  server on the backend.

## Project structure

```
ormapadippu/
  flake.nix            Nix dev shell providing Node.js (`nix develop`)
  package.json          Backend dependencies (express, mongodb, dotenv, smol-toml)
  server.js              Express server: serves the static frontend, reads
                          quiz.toml, and exposes /api/config + /api/results
  quiz.toml              All site/quiz configuration (see below)
  .env.example            Template for the MongoDB connection string
  index.html / style.css / app.js   The frontend (single page, no framework)
  assets/                 Logo / favicon
  quizzes/
    <quiz_file>.json      The question bank referenced by quiz.toml
```

## Getting started

```sh
nix develop              # provides Node.js — see flake.nix
npm install
cp .env.example .env     # then fill in your own MongoDB Atlas connection string
npm start
```

The server starts immediately (it doesn't block on the MongoDB connection), and
serves everything — frontend and API — on `http://localhost:3000` by default.

If a quiz result can't be saved (e.g. `.env` isn't configured yet), the quiz UI
still completes normally; only the save silently fails, logged server-side.

## Configuring the quiz — `quiz.toml`

| Key | Meaning |
|---|---|
| `name` | Browser tab title. |
| `description` | Shown under the quiz title on the intro screen (falls back to the quiz JSON's own `description` if unset). |
| `db_location` | Folder holding the quiz JSON file. |
| `quiz_file` | Filename (inside `db_location`) of the question bank to use. |
| `state` | `"before"`, `"active"`, or `"done"` — see below. |
| `before_text` | Message shown when `state = "before"`. |
| `done_text` | Message shown when `state = "done"`. |
| `max_time_per_question_seconds` | Timer applied to every question. |
| `one_question_per_page` | `true` = one question at a time with its own timer; `false` = all questions on one page with a single overall countdown and a submit button. |
| `questions_per_attempt` | How many questions to randomly draw from the bank per attempt (if ≥ the bank size, every question is used). |
| `cooldown_seconds` | Length of the "get ready" countdown shown after clicking Begin Quiz, before the first question. |

`quiz.toml` is only read at server startup — restart the server after editing it.

### Quiz lifecycle (`state`)

- `before` — quiz hasn't opened yet; visitors see `before_text` instead of the
  registration form.
- `active` — normal; visitors can register (name + registration number) and
  take the quiz.
- `done` — closed; visitors see `done_text` instead of the registration form.

## Quiz JSON format

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

`correctIndex` refers to the option's position in this array — options are
shuffled per attempt, but correctness is tracked by value, not index.

## Results

Each attempt POSTs to `/api/results` once it ends (normally or via
disqualification), which is written to a `results` collection in MongoDB:

```json
{
  "quizId": "gandhi-quiz",
  "participant": "Jane Doe",
  "registrationNumber": "24BLC1073",
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

The score/answers are stored but never shown back to the participant.

## License

MIT — see [LICENSE](LICENSE).
