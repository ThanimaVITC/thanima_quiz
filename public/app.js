(() => {
  "use strict";

  // ---------- Theme ----------
  const THEME_KEY = "thanima-quiz-theme";
  const themeToggleBtn = document.getElementById("theme-toggle");
  const themeToggleIcon = document.getElementById("theme-toggle-icon");

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      themeToggleIcon.innerHTML = "&#9789;"; // moon - click to go dark
    } else {
      document.documentElement.removeAttribute("data-theme");
      themeToggleIcon.innerHTML = "&#9728;"; // sun - click to go light
    }
  }

  (function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch (_) {
      /* localStorage unavailable, fall back to dark default */
    }
    applyTheme(stored === "light" ? "light" : "dark");
  })();

  themeToggleBtn.addEventListener("click", () => {
    const isLight = document.documentElement.getAttribute("data-theme") === "light";
    const next = isLight ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {
      /* ignore persistence failures */
    }
  });

  // ---------- Screens ----------
  const screens = {
    inactive: document.getElementById("screen-inactive"),
    intro: document.getElementById("screen-intro"),
    cooldown: document.getElementById("screen-cooldown"),
    question: document.getElementById("screen-question"),
    disqualified: document.getElementById("screen-disqualified"),
    results: document.getElementById("screen-results"),
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.hidden = key !== name;
    });
  }

  // ---------- App state ----------
  const DEFAULT_CONFIG = {
    name: "Thanima Quiz",
    description: "",
    quizTitle: "",
    quizDescription: "",
    maxTimePerQuestionSeconds: 7,
    oneQuestionPerPage: true,
    questionsPerAttempt: 20,
    cooldownSeconds: 5,
    state: "before",
    beforeText: "The quiz service is temporarily unavailable. Please try again soon.",
    doneText: "This quiz has been completed and no more submissions will be taken.",
  };

  let config = DEFAULT_CONFIG;
  let configLoaded = false;
  let attemptId = null;
  let questions = []; // [{id, question, options}] - no correct answers on the client
  let currentIndex = 0;
  let selections = {}; // questionId -> selected option text, or null if skipped
  let participant = "";
  let registrationNumber = "";
  let countdownInterval = null;
  let advanceTimeout = null;
  let answered = false;
  let pendingSelection = null; // single-question mode: clicked but not yet confirmed

  const introError = document.getElementById("intro-error");
  const beginBtn = document.getElementById("begin-btn");
  const nameInput = document.getElementById("participant-name");
  const regNumberInput = document.getElementById("registration-number");
  const regNumberError = document.getElementById("registration-number-error");
  const cooldownNote = document.getElementById("cooldown-note");
  const cooldownNumber = document.getElementById("cooldown-number");
  const screenQuestion = document.getElementById("screen-question");

  // e.g. 00XXX0000 - 2-digit enrollment year, 3-letter branch code, 4-digit number
  const REGISTRATION_NUMBER_PATTERN = /^\d{2}[A-Z]{3}\d{4}$/;

  function isRegistrationNumberValid() {
    return REGISTRATION_NUMBER_PATTERN.test(regNumberInput.value.trim());
  }

  function updateBeginEnabled() {
    const regValue = regNumberInput.value.trim();
    regNumberError.hidden = regValue.length === 0 || isRegistrationNumberValid();
    beginBtn.disabled =
      !configLoaded || nameInput.value.trim().length === 0 || !isRegistrationNumberValid();
  }
  nameInput.addEventListener("input", updateBeginEnabled);
  regNumberInput.addEventListener("input", () => {
    const cursor = regNumberInput.selectionStart;
    regNumberInput.value = regNumberInput.value.toUpperCase();
    regNumberInput.setSelectionRange(cursor, cursor);
    updateBeginEnabled();
  });

  // ---------- Load config ----------
  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      if (!res.ok) throw new Error("bad response");
      const remote = await res.json();
      config = { ...DEFAULT_CONFIG, ...remote };
    } catch (err) {
      console.warn("Could not load /api/config, using defaults:", err);
      config = DEFAULT_CONFIG;
    }
    document.title = config.name;
    cooldownNote.textContent = `There is a ${config.cooldownSeconds} second cooldown before the quiz starts.`;
  }

  function showInactiveScreen() {
    document.getElementById("inactive-title").textContent = config.name;
    document.getElementById("inactive-message").textContent =
      config.state === "before" ? config.beforeText : config.doneText;
    showScreen("inactive");
  }

  (async function init() {
    await loadConfig();
    if (config.state !== "active") {
      showInactiveScreen();
      return;
    }
    document.getElementById("quiz-title").textContent = config.quizTitle || config.name;
    document.getElementById("quiz-description").textContent =
      config.description || config.quizDescription || "";
    configLoaded = true;
    updateBeginEnabled();
  })();

  // ---------- Tab-switch detection ----------
  function onVisibilityChange() {
    if (document.hidden) {
      disqualify();
    }
  }

  function armAntiCheat() {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  function disarmAntiCheat() {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }

  function clearTimers() {
    if (countdownInterval) clearInterval(countdownInterval);
    if (advanceTimeout) clearTimeout(advanceTimeout);
    countdownInterval = null;
    advanceTimeout = null;
  }

  // ---------- Begin ----------
  beginBtn.addEventListener("click", async () => {
    if (beginBtn.disabled) return;
    participant = nameInput.value.trim();
    registrationNumber = regNumberInput.value.trim();
    beginBtn.disabled = true;
    introError.hidden = true;

    try {
      const res = await fetch("/api/attempt/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participant, registrationNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the quiz.");

      attemptId = data.attemptId;
      questions = data.questions;
      currentIndex = 0;
      selections = {};

      armAntiCheat();
      showScreen("cooldown");
      runCooldown(config.cooldownSeconds, () => {
        showScreen("question");
        if (config.oneQuestionPerPage) {
          startSingleQuestionMode();
        } else {
          startAllQuestionsMode();
        }
      });
    } catch (err) {
      introError.textContent = err.message;
      introError.hidden = false;
      updateBeginEnabled();
    }
  });

  function runCooldown(seconds, onDone) {
    clearTimers();
    let remaining = seconds;
    cooldownNumber.textContent = remaining;
    countdownInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
        onDone();
      } else {
        cooldownNumber.textContent = remaining;
      }
    }, 1000);
  }

  // ---------- Mode: one question per page ----------
  function startSingleQuestionMode() {
    screenQuestion.innerHTML = `
      <div class="progress-row">
        <span id="progress-label" class="muted"></span>
        <span id="timer-label" class="timer-label"></span>
      </div>
      <div class="timer-track"><div id="timer-bar" class="timer-bar"></div></div>
      <h2 id="question-text"></h2>
      <div id="options-list" class="options-list"></div>
      <button id="confirm-btn" class="btn btn-accent" type="button" disabled>Confirm Answer</button>
    `;
    document.getElementById("confirm-btn").addEventListener("click", () => {
      if (answered || !pendingSelection) return;
      lockInSingleAnswer(questions[currentIndex], pendingSelection);
    });
    renderSingleQuestion();
  }

  function renderSingleQuestion() {
    if (currentIndex >= questions.length) {
      finishQuiz(false);
      return;
    }

    answered = false;
    pendingSelection = null;
    const q = questions[currentIndex];

    document.getElementById("progress-label").textContent =
      `Question ${currentIndex + 1} of ${questions.length}`;
    document.getElementById("question-text").textContent = q.question;

    const confirmBtn = document.getElementById("confirm-btn");
    confirmBtn.disabled = true;

    const optionsList = document.getElementById("options-list");
    optionsList.innerHTML = "";
    q.options.forEach((optionText) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "option-btn";
      btn.textContent = optionText;
      btn.addEventListener("click", () => {
        if (answered) return;
        pendingSelection = optionText;
        Array.from(optionsList.children).forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        confirmBtn.disabled = false;
      });
      optionsList.appendChild(btn);
    });

    // If time runs out, whatever option is currently selected (if any) is
    // used as the final answer, same as an explicit confirm.
    startCountdown(config.maxTimePerQuestionSeconds, () => {
      if (!answered) {
        lockInSingleAnswer(q, pendingSelection);
      }
    });
  }

  function lockInSingleAnswer(q, selectedText) {
    if (answered) return;
    answered = true;
    clearTimers();
    selections[q.id] = selectedText;

    const optionsList = document.getElementById("options-list");
    Array.from(optionsList.children).forEach((btn) => {
      btn.disabled = true;
    });
    document.getElementById("confirm-btn").disabled = true;

    advanceTimeout = setTimeout(nextSingleQuestion, 400);
  }

  function nextSingleQuestion() {
    currentIndex += 1;
    renderSingleQuestion();
  }

  // ---------- Mode: all questions on one page ----------
  function startAllQuestionsMode() {
    screenQuestion.innerHTML = `
      <div class="progress-row">
        <span class="muted">All ${questions.length} questions - answer and submit before time runs out</span>
        <span id="timer-label" class="timer-label"></span>
      </div>
      <div class="timer-track"><div id="timer-bar" class="timer-bar"></div></div>
      <div id="all-questions-list" class="all-questions-list"></div>
      <button id="submit-all-btn" class="btn btn-accent" type="button">Submit Quiz</button>
    `;

    const list = document.getElementById("all-questions-list");
    questions.forEach((q, idx) => {
      const block = document.createElement("div");
      block.className = "question-block";

      const heading = document.createElement("h3");
      heading.innerHTML = `<span class="question-number">${idx + 1}.</span>${escapeHtml(q.question)}`;
      block.appendChild(heading);

      const optionsList = document.createElement("div");
      optionsList.className = "options-list";
      q.options.forEach((optionText) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "option-btn";
        btn.textContent = optionText;
        btn.addEventListener("click", () => {
          selections[q.id] = optionText;
          Array.from(optionsList.children).forEach((b) => b.classList.remove("selected"));
          btn.classList.add("selected");
        });
        optionsList.appendChild(btn);
      });
      block.appendChild(optionsList);

      list.appendChild(block);
    });

    document.getElementById("submit-all-btn").addEventListener("click", () => finishQuiz(false));

    const totalSeconds = config.maxTimePerQuestionSeconds * questions.length;
    startCountdown(totalSeconds, () => finishQuiz(false));
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------- Shared countdown ----------
  function startCountdown(seconds, onExpire) {
    clearTimers();
    let remaining = seconds;
    const timerLabel = document.getElementById("timer-label");
    const timerBar = document.getElementById("timer-bar");

    timerLabel.textContent = `${remaining}s`;
    timerBar.style.transition = "none";
    timerBar.style.width = "100%";
    // force reflow so the transition below actually animates
    // eslint-disable-next-line no-unused-expressions
    timerBar.offsetWidth;
    timerBar.style.transition = `width ${seconds}s linear`;
    timerBar.style.width = "0%";

    countdownInterval = setInterval(() => {
      remaining -= 1;
      timerLabel.textContent = `${Math.max(remaining, 0)}s`;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
    }, 1000);

    advanceTimeout = setTimeout(onExpire, seconds * 1000);
  }

  // ---------- Finish ----------
  function disqualify() {
    clearTimers();
    disarmAntiCheat();
    showScreen("disqualified");
    submitFinish(true);
  }

  function finishQuiz() {
    clearTimers();
    disarmAntiCheat();
    showScreen("results");
    submitFinish(false);
  }

  function submitFinish(disqualified) {
    const answers = Object.entries(selections).map(([questionId, selected]) => ({
      questionId,
      selected,
    }));
    fetch(`/api/attempt/${attemptId}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disqualified, answers }),
    }).catch((err) => {
      console.warn("Could not save quiz results (is the server/DB configured?):", err);
    });
  }
})();
