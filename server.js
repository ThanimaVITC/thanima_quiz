require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");
const { MongoClient } = require("mongodb");
const TOML = require("smol-toml");

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "ormapadippu";

const DEFAULT_CONFIG = {
  name: "ormapadippu",
  description: "",
  dbLocation: "quizzes",
  quizFile: "gandhi-quiz.json",
  maxTimePerQuestionSeconds: 7,
  oneQuestionPerPage: true,
  questionsPerAttempt: 20,
  cooldownSeconds: 5,
  state: "active",
  beforeText: "This quiz hasn't started yet. Please check back soon.",
  doneText: "This quiz has been completed and no more submissions will be taken.",
};

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, "quiz.toml"), "utf-8");
    const parsed = TOML.parse(raw).quiz || {};
    return {
      name: parsed.name || DEFAULT_CONFIG.name,
      description: parsed.description || DEFAULT_CONFIG.description,
      dbLocation: parsed.db_location || DEFAULT_CONFIG.dbLocation,
      quizFile: parsed.quiz_file || DEFAULT_CONFIG.quizFile,
      maxTimePerQuestionSeconds:
        parsed.max_time_per_question_seconds || DEFAULT_CONFIG.maxTimePerQuestionSeconds,
      oneQuestionPerPage:
        parsed.one_question_per_page !== undefined
          ? parsed.one_question_per_page
          : DEFAULT_CONFIG.oneQuestionPerPage,
      questionsPerAttempt: parsed.questions_per_attempt || DEFAULT_CONFIG.questionsPerAttempt,
      cooldownSeconds: parsed.cooldown_seconds || DEFAULT_CONFIG.cooldownSeconds,
      state: parsed.state || DEFAULT_CONFIG.state,
      beforeText: parsed.before_text || DEFAULT_CONFIG.beforeText,
      doneText: parsed.done_text || DEFAULT_CONFIG.doneText,
    };
  } catch (err) {
    console.warn("Could not read quiz.toml, using defaults:", err.message);
    return DEFAULT_CONFIG;
  }
}

const config = loadConfig();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/config", (req, res) => {
  res.json(config);
});

let db = null;

async function connectMongo() {
  if (!MONGODB_URI || MONGODB_URI.includes("<user>")) {
    console.warn(
      "MONGODB_URI is not configured (see .env.example) — quiz results will not be saved."
    );
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB);
    await db.collection("results").createIndex({ quizId: 1, finishedAt: -1 });
    console.log(`Connected to MongoDB database "${MONGODB_DB}".`);
  } catch (err) {
    console.error("Could not connect to MongoDB — quiz results will not be saved:", err.message);
    db = null;
  }
}

app.post("/api/results", async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "Database is not configured on the server." });
  }
  try {
    const doc = { ...req.body, receivedAt: new Date() };
    await db.collection("results").insertOne(doc);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error("Failed to save quiz result:", err.message);
    res.status(500).json({ error: "Failed to save result." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, db: db ? "connected" : "not configured" });
});

app.listen(PORT, () => {
  console.log(`ormapadippu running at http://localhost:${PORT}`);
});

connectMongo();
