require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const multer = require("multer");
const { MongoClient } = require("mongodb");
const TOML = require("smol-toml");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "quiz";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const DEFAULT_CONFIG = {
  name: "Thanima Quiz",
  description: "",
  maxTimePerQuestionSeconds: 7,
  oneQuestionPerPage: true,
  questionsPerAttempt: 20,
  cooldownSeconds: 5,
  state: "active",
  beforeText: "This quiz hasn't started yet. Please check back soon.",
  doneText: "This quiz has been completed and no more submissions will be taken.",
  activeQuizId: null,
};

// The service is unusable without a database, so this is what visitors see
// whenever MongoDB isn't connected, regardless of what's actually configured.
const DB_DOWN_CONFIG_OVERRIDE = {
  state: "before",
  beforeText: "The quiz service is temporarily unavailable. Please try again soon.",
};

// ---------- App / static ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------- Mongo ----------
let db = null;
let dbConnectPromise = null;

async function connectMongo() {
  if (!MONGODB_URI) {
    console.warn("MONGODB_URI is not configured (see .env.example) - the app will not function.");
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB);
    await db.collection("results").createIndex({ quizId: 1, finishedAt: -1 });
    // Abandoned attempts (browser closed mid-quiz) self-delete after 2 hours -
    // these documents hold the answer key, so they shouldn't linger.
    await db.collection("attempts").createIndex({ startedAt: 1 }, { expireAfterSeconds: 7200 });
    // Admin sessions self-delete at their expiresAt timestamp.
    await db.collection("admin_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    console.log(`Connected to MongoDB database "${MONGODB_DB}".`);
    await seedIfEmpty();
  } catch (err) {
    console.error("Could not connect to MongoDB:", err.message);
    db = null;
  }
}

// Retries the connection on demand rather than only once at cold start - on
// a serverless host, a single failed attempt (network blip, IP allowlist
// hiccup) would otherwise leave that instance permanently unable to serve
// requests until it happens to be recycled. Concurrent callers share one
// in-flight attempt instead of racing separate connections.
async function ensureDb() {
  if (db) return db;
  if (!dbConnectPromise) {
    dbConnectPromise = connectMongo().finally(() => {
      dbConnectPromise = null;
    });
  }
  await dbConnectPromise;
  return db;
}

// One-time migration: if this is a fresh database (no config doc yet), seed it
// from quiz.toml + the existing quizzes/*.json file so nothing already
// authored is lost. After this, Mongo - via the admin panel - is authoritative.
async function seedIfEmpty() {
  const existing = await db.collection("config").findOne({ _id: "site" });
  if (existing) return;

  console.log("No config found in MongoDB - seeding from quiz.toml + quizzes/ on disk.");
  let quizId = null;
  try {
    const raw = fs.readFileSync(path.join(__dirname, "quizzes", "gandhi-quiz.json"), "utf-8");
    const quiz = JSON.parse(raw);
    quizId = quiz.id || "seed-quiz";
    await db.collection("quizzes").updateOne(
      { _id: quizId },
      { $set: { title: quiz.title, description: quiz.description, questions: quiz.questions } },
      { upsert: true }
    );
    console.log(`Seeded quiz "${quizId}" (${quiz.questions.length} questions).`);
  } catch (err) {
    console.warn("Could not seed a quiz from quizzes/gandhi-quiz.json:", err.message);
  }

  let tomlConfig = {};
  try {
    const raw = fs.readFileSync(path.join(__dirname, "quiz.toml"), "utf-8");
    tomlConfig = TOML.parse(raw).quiz || {};
  } catch (err) {
    console.warn("Could not read quiz.toml for seeding:", err.message);
  }

  const seeded = {
    _id: "site",
    name: tomlConfig.name || DEFAULT_CONFIG.name,
    description: tomlConfig.description || DEFAULT_CONFIG.description,
    maxTimePerQuestionSeconds:
      tomlConfig.max_time_per_question_seconds || DEFAULT_CONFIG.maxTimePerQuestionSeconds,
    oneQuestionPerPage:
      tomlConfig.one_question_per_page !== undefined
        ? tomlConfig.one_question_per_page
        : DEFAULT_CONFIG.oneQuestionPerPage,
    questionsPerAttempt: tomlConfig.questions_per_attempt || DEFAULT_CONFIG.questionsPerAttempt,
    cooldownSeconds: tomlConfig.cooldown_seconds || DEFAULT_CONFIG.cooldownSeconds,
    state: tomlConfig.state || DEFAULT_CONFIG.state,
    beforeText: tomlConfig.before_text || DEFAULT_CONFIG.beforeText,
    doneText: tomlConfig.done_text || DEFAULT_CONFIG.doneText,
    activeQuizId: quizId,
  };
  await db.collection("config").insertOne(seeded);
  console.log("Seeded site config into MongoDB.");
}

async function getConfig() {
  const stored = (await db.collection("config").findOne({ _id: "site" })) || {};
  return { ...DEFAULT_CONFIG, ...stored };
}

// ---------- Public API ----------
app.get("/api/config", async (req, res) => {
  if (!(await ensureDb())) {
    return res.json({ ...DEFAULT_CONFIG, ...DB_DOWN_CONFIG_OVERRIDE });
  }
  try {
    const config = await getConfig();
    let quizTitle = "";
    let quizDescription = "";
    if (config.state === "active" && config.activeQuizId) {
      const quiz = await db.collection("quizzes").findOne(
        { _id: config.activeQuizId },
        { projection: { title: 1, description: 1 } }
      );
      if (quiz) {
        quizTitle = quiz.title || "";
        quizDescription = quiz.description || "";
      } else {
        // Configured active quiz doesn't exist (deleted, or never set up).
        return res.json({
          ...config,
          state: "before",
          beforeText: "This quiz hasn't been set up yet. Please check back soon.",
        });
      }
    }
    res.json({ ...config, quizTitle, quizDescription });
  } catch (err) {
    console.error("Failed to load config:", err.message);
    res.status(500).json({ ...DEFAULT_CONFIG, ...DB_DOWN_CONFIG_OVERRIDE });
  }
});

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const REGISTRATION_NUMBER_PATTERN = /^\d{2}[A-Z]{3}\d{4}$/;

app.post("/api/attempt/start", async (req, res) => {
  if (!(await ensureDb())) return res.status(503).json({ error: "Service unavailable." });

  const participant = String(req.body.participant || "").trim();
  const registrationNumber = String(req.body.registrationNumber || "")
    .trim()
    .toUpperCase();

  if (!participant) return res.status(400).json({ error: "Name is required." });
  if (!REGISTRATION_NUMBER_PATTERN.test(registrationNumber)) {
    return res.status(400).json({ error: "Invalid registration number format." });
  }

  try {
    const config = await getConfig();
    if (config.state !== "active") {
      return res.status(403).json({ error: "The quiz is not currently active." });
    }
    if (!config.activeQuizId) {
      return res.status(500).json({ error: "No quiz is configured." });
    }
    const quiz = await db.collection("quizzes").findOne({ _id: config.activeQuizId });
    if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(500).json({ error: "The configured quiz has no questions." });
    }

    let picked = shuffle(quiz.questions);
    const limit = config.questionsPerAttempt;
    if (limit && limit > 0 && limit < picked.length) {
      picked = picked.slice(0, limit);
    }
    const questions = picked.map((q) => {
      const correctValue = q.options[q.correctIndex];
      return { id: q.id, question: q.question, options: shuffle(q.options), correctValue };
    });

    const attemptId = crypto.randomUUID();
    await db.collection("attempts").insertOne({
      _id: attemptId,
      quizId: config.activeQuizId,
      participant,
      registrationNumber,
      startedAt: new Date(),
      status: "in_progress",
      questions,
    });

    res.status(201).json({
      attemptId,
      quizTitle: quiz.title || "",
      quizDescription: quiz.description || "",
      questions: questions.map(({ id, question, options }) => ({ id, question, options })),
    });
  } catch (err) {
    console.error("Failed to start attempt:", err.message);
    res.status(500).json({ error: "Could not start the quiz." });
  }
});

app.post("/api/attempt/:id/finish", async (req, res) => {
  if (!(await ensureDb())) return res.status(503).json({ error: "Service unavailable." });

  try {
    const attempt = await db.collection("attempts").findOne({ _id: req.params.id });
    if (!attempt || attempt.status !== "in_progress") {
      return res.status(404).json({ error: "Attempt not found or already finished." });
    }

    const disqualified = Boolean(req.body.disqualified);
    const submitted = Array.isArray(req.body.answers) ? req.body.answers : [];
    const submittedById = new Map(submitted.map((a) => [a.questionId, a.selected ?? null]));

    let score = 0;
    const answers = attempt.questions.map((q) => {
      const selected = submittedById.has(q.id) ? submittedById.get(q.id) : null;
      const correct = selected !== null && selected === q.correctValue;
      if (correct) score += 1;
      return { questionId: q.id, selected, correct };
    });

    await db.collection("results").insertOne({
      quizId: attempt.quizId,
      participant: attempt.participant,
      registrationNumber: attempt.registrationNumber,
      startedAt: attempt.startedAt,
      finishedAt: new Date(),
      disqualified,
      score,
      total: attempt.questions.length,
      answers,
    });
    await db.collection("attempts").deleteOne({ _id: attempt._id });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Failed to finish attempt:", err.message);
    res.status(500).json({ error: "Could not save the result." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: db ? "connected" : "not configured" });
});

// ---------- Admin ----------
// Password-only session auth (no username field, unlike HTTP Basic Auth).
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const SESSION_COOKIE = "admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Sessions live in MongoDB, not in-memory - this app runs as stateless
// serverless functions in production (Vercel), where each request can land
// on a completely different instance with its own blank memory, so an
// in-memory session map would "work" on login and then vanish immediately.
async function createSession() {
  const token = crypto.randomUUID();
  await db
    .collection("admin_sessions")
    .insertOne({ _id: token, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
  return token;
}

async function isValidSession(token) {
  const session = await db.collection("admin_sessions").findOne({ _id: token });
  return Boolean(session);
  // Expired sessions are cleaned up by the TTL index (see connectMongo); no
  // need to check expiresAt here.
}

async function deleteSession(token) {
  await db.collection("admin_sessions").deleteOne({ _id: token });
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

async function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Admin panel is not configured (set ADMIN_PASSWORD in .env).");
  }
  if (!(await ensureDb())) {
    return res.status(503).send("Database is not connected.");
  }
  try {
    const token = getCookie(req, SESSION_COOKIE);
    if (token && (await isValidSession(token))) return next();
  } catch (err) {
    console.error("Admin session check failed:", err.message);
  }
  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  return res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.sendFile(path.join(__dirname, "admin", "login.html"));
});

app.post("/api/admin/login", async (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin panel is not configured." });
  }
  if (!(await ensureDb())) {
    return res.status(503).json({ error: "Database is not connected." });
  }
  const password = String((req.body && req.body.password) || "");
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const token = await createSession();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: req.secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  res.json({ ok: true });
});

app.post("/api/admin/logout", async (req, res) => {
  const token = getCookie(req, SESSION_COOKIE);
  if (token && db) await deleteSession(token);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.json({ ok: true });
});

app.use("/admin", adminAuth, express.static(path.join(__dirname, "admin")));

async function requireDb(req, res, next) {
  if (!(await ensureDb())) return res.status(503).json({ error: "Database is not connected." });
  next();
}

app.get("/api/admin/config", adminAuth, requireDb, async (req, res) => {
  res.json(await getConfig());
});

app.put("/api/admin/config", adminAuth, requireDb, async (req, res) => {
  const allowedKeys = [
    "name",
    "description",
    "maxTimePerQuestionSeconds",
    "oneQuestionPerPage",
    "questionsPerAttempt",
    "cooldownSeconds",
    "state",
    "beforeText",
    "doneText",
    "activeQuizId",
  ];
  const update = {};
  for (const key of allowedKeys) {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  }
  await db.collection("config").updateOne({ _id: "site" }, { $set: update }, { upsert: true });
  res.json(await getConfig());
});

app.get("/api/admin/quizzes", adminAuth, requireDb, async (req, res) => {
  const quizzes = await db
    .collection("quizzes")
    .find({}, { projection: { title: 1, description: 1, questions: 1 } })
    .toArray();
  res.json(
    quizzes.map((q) => ({
      id: q._id,
      title: q.title,
      description: q.description,
      questionCount: Array.isArray(q.questions) ? q.questions.length : 0,
    }))
  );
});

function validateQuizShape(quiz) {
  if (!quiz || typeof quiz !== "object") return "Not a JSON object.";
  if (!quiz.id || typeof quiz.id !== "string") return "Missing string \"id\".";
  if (!quiz.title || typeof quiz.title !== "string") return "Missing string \"title\".";
  if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    return "Missing non-empty \"questions\" array.";
  }
  for (const [i, q] of quiz.questions.entries()) {
    if (!q.id || typeof q.question !== "string") return `Question ${i + 1}: missing id/question.`;
    if (!Array.isArray(q.options) || q.options.length < 2) {
      return `Question ${i + 1}: needs an "options" array with at least 2 entries.`;
    }
    if (
      typeof q.correctIndex !== "number" ||
      q.correctIndex < 0 ||
      q.correctIndex >= q.options.length
    ) {
      return `Question ${i + 1}: "correctIndex" must index into "options".`;
    }
  }
  return null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.post("/api/admin/quizzes", adminAuth, requireDb, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded (field name: file)." });
  let quiz;
  try {
    quiz = JSON.parse(req.file.buffer.toString("utf-8"));
  } catch (err) {
    return res.status(400).json({ error: "Uploaded file is not valid JSON." });
  }
  const problem = validateQuizShape(quiz);
  if (problem) return res.status(400).json({ error: problem });

  await db.collection("quizzes").updateOne(
    { _id: quiz.id },
    { $set: { title: quiz.title, description: quiz.description || "", questions: quiz.questions } },
    { upsert: true }
  );
  res.status(201).json({ ok: true, id: quiz.id, questionCount: quiz.questions.length });
});

app.patch("/api/admin/quizzes/:id", adminAuth, requireDb, async (req, res) => {
  const update = {};
  if (typeof req.body.title === "string") {
    const title = req.body.title.trim();
    if (!title) return res.status(400).json({ error: "Title cannot be empty." });
    update.title = title;
  }
  if (typeof req.body.description === "string") update.description = req.body.description.trim();
  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }
  const result = await db.collection("quizzes").updateOne({ _id: req.params.id }, { $set: update });
  if (result.matchedCount === 0) return res.status(404).json({ error: "Quiz not found." });
  res.json({ ok: true });
});

app.delete("/api/admin/quizzes/:id", adminAuth, requireDb, async (req, res) => {
  const password = String((req.body && req.body.password) || "");
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  await db.collection("quizzes").deleteOne({ _id: req.params.id });
  res.json({ ok: true });
});

app.get("/api/admin/results", adminAuth, requireDb, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const results = await db
    .collection("results")
    .find({})
    .sort({ finishedAt: -1 })
    .limit(limit)
    .toArray();
  res.json(results);
});

app.delete("/api/admin/results", adminAuth, requireDb, async (req, res) => {
  const password = String((req.body && req.body.password) || "");
  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const query = {};
  if (req.body && req.body.quizId) query.quizId = req.body.quizId;
  const result = await db.collection("results").deleteMany(query);
  res.json({ ok: true, deletedCount: result.deletedCount });
});

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

app.get("/api/admin/results/export", adminAuth, requireDb, async (req, res) => {
  const query = {};
  if (req.query.quizId) query.quizId = req.query.quizId;

  const results = await db.collection("results").find(query).sort({ finishedAt: -1 }).toArray();

  const header = [
    "participant",
    "registrationNumber",
    "quizId",
    "score",
    "total",
    "disqualified",
    "startedAt",
    "finishedAt",
  ];
  const rows = [header.join(",")];
  for (const r of results) {
    rows.push(
      [
        r.participant,
        r.registrationNumber,
        r.quizId,
        r.score,
        r.total,
        r.disqualified,
        r.startedAt ? new Date(r.startedAt).toISOString() : "",
        r.finishedAt ? new Date(r.finishedAt).toISOString() : "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }

  const filename = req.query.quizId ? `results-${req.query.quizId}.csv` : "results-all.csv";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(rows.join("\n"));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Thanima Quiz running at http://localhost:${PORT}`);
});

connectMongo();

// Exported so a Vercel serverless function entrypoint can `require` this
// file and hand requests to the Express app directly, instead of relying on
// app.listen() (which Vercel's runtime doesn't actually use).
module.exports = app;
