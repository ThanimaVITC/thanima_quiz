(() => {
  "use strict";

  // ---------- Theme (same behavior as the main site) ----------
  const THEME_KEY = "thanima-quiz-theme";
  const themeToggleBtn = document.getElementById("theme-toggle");
  const themeToggleIcon = document.getElementById("theme-toggle-icon");

  function applyTheme(theme) {
    if (theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      themeToggleIcon.innerHTML = "&#9789;";
    } else {
      document.documentElement.removeAttribute("data-theme");
      themeToggleIcon.innerHTML = "&#9728;";
    }
  }

  (function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch (_) {
      /* ignore */
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
      /* ignore */
    }
  });

  // ---------- Helpers ----------
  async function api(path, options) {
    const res = await fetch(path, options);
    if (res.status === 401) {
      window.location.href = "/admin/login";
      throw new Error("Not authenticated.");
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* no body */
    }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  document.getElementById("logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/logout", { method: "POST" });
    } catch (_) {
      /* already redirecting or already logged out */
    }
    window.location.href = "/admin/login";
  });

  const dbWarning = document.getElementById("db-warning");

  // ---------- Config form ----------
  const configForm = document.getElementById("config-form");
  const configStatus = document.getElementById("config-status");
  const fields = {
    name: document.getElementById("cfg-name"),
    description: document.getElementById("cfg-description"),
    activeQuizId: document.getElementById("cfg-active-quiz"),
    state: document.getElementById("cfg-state"),
    beforeText: document.getElementById("cfg-before-text"),
    doneText: document.getElementById("cfg-done-text"),
    maxTimePerQuestionSeconds: document.getElementById("cfg-time-per-question"),
    questionsPerAttempt: document.getElementById("cfg-questions-per-attempt"),
    cooldownSeconds: document.getElementById("cfg-cooldown"),
    oneQuestionPerPage: document.getElementById("cfg-one-question-per-page"),
  };

  function fillConfigForm(config) {
    fields.name.value = config.name || "";
    fields.description.value = config.description || "";
    fields.state.value = config.state || "before";
    fields.beforeText.value = config.beforeText || "";
    fields.doneText.value = config.doneText || "";
    fields.maxTimePerQuestionSeconds.value = config.maxTimePerQuestionSeconds ?? 7;
    fields.questionsPerAttempt.value = config.questionsPerAttempt ?? 20;
    fields.cooldownSeconds.value = config.cooldownSeconds ?? 5;
    fields.oneQuestionPerPage.checked = Boolean(config.oneQuestionPerPage);
    if (config.activeQuizId) fields.activeQuizId.value = config.activeQuizId;
  }

  configForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    configStatus.textContent = "Saving…";
    try {
      await api("/api/admin/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.name.value.trim(),
          description: fields.description.value.trim(),
          activeQuizId: fields.activeQuizId.value || null,
          state: fields.state.value,
          beforeText: fields.beforeText.value,
          doneText: fields.doneText.value,
          maxTimePerQuestionSeconds: Number(fields.maxTimePerQuestionSeconds.value) || 7,
          questionsPerAttempt: Number(fields.questionsPerAttempt.value) || 1,
          cooldownSeconds: Number(fields.cooldownSeconds.value) || 0,
          oneQuestionPerPage: fields.oneQuestionPerPage.checked,
        }),
      });
      configStatus.textContent = "Saved.";
    } catch (err) {
      configStatus.textContent = "Error: " + err.message;
    }
  });

  // ---------- Quizzes ----------
  const quizzesTableBody = document.querySelector("#quizzes-table tbody");
  const uploadForm = document.getElementById("upload-form");
  const uploadStatus = document.getElementById("upload-status");
  const quizFileInput = document.getElementById("quiz-file");

  const exportFilter = document.getElementById("export-quiz-filter");
  const exportLink = document.getElementById("export-results");

  function updateExportLink() {
    const quizId = exportFilter.value;
    exportLink.href = quizId
      ? `/api/admin/results/export?quizId=${encodeURIComponent(quizId)}`
      : "/api/admin/results/export";
  }
  exportFilter.addEventListener("change", updateExportLink);

  async function loadQuizzes() {
    const quizzes = await api("/api/admin/quizzes");

    fields.activeQuizId.innerHTML = quizzes
      .map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.title)} (${q.id})</option>`)
      .join("");

    exportFilter.innerHTML =
      `<option value="">All quizzes</option>` +
      quizzes
        .map((q) => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.title)} (${q.id})</option>`)
        .join("");
    updateExportLink();

    quizzesTableBody.innerHTML = "";
    quizzes.forEach((q) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(q.id)}</td>
        <td>${escapeHtml(q.title)}</td>
        <td>${q.questionCount}</td>
        <td></td>
      `;
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "btn btn-accent btn-small";
      renameBtn.textContent = "Rename";
      renameBtn.addEventListener("click", async () => {
        const title = prompt(`New title for "${q.id}":`, q.title);
        if (title === null || title.trim() === "" || title === q.title) return;
        try {
          await api(`/api/admin/quizzes/${encodeURIComponent(q.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          });
          await refreshAll();
        } catch (err) {
          alert("Could not rename: " + err.message);
        }
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "btn btn-danger btn-small";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        const password = prompt(
          `This permanently deletes "${q.title}" (${q.id}). Re-enter the admin password to confirm:`
        );
        if (password === null) return;
        try {
          await api(`/api/admin/quizzes/${encodeURIComponent(q.id)}`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
          });
          await refreshAll();
        } catch (err) {
          alert("Could not delete: " + err.message);
        }
      });
      tr.lastElementChild.appendChild(renameBtn);
      tr.lastElementChild.appendChild(deleteBtn);
      quizzesTableBody.appendChild(tr);
    });

    return quizzes;
  }

  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = quizFileInput.files[0];
    if (!file) return;
    uploadStatus.textContent = "Uploading…";
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api("/api/admin/quizzes", { method: "POST", body: formData });
      uploadStatus.textContent = `Uploaded "${result.id}" (${result.questionCount} questions).`;
      quizFileInput.value = "";
      await loadQuizzes();
    } catch (err) {
      uploadStatus.textContent = "Error: " + err.message;
    }
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  // ---------- Results ----------
  const resultsTableBody = document.querySelector("#results-table tbody");

  async function loadResults() {
    const results = await api("/api/admin/results?limit=50");
    resultsTableBody.innerHTML = "";
    results.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(r.participant)}</td>
        <td>${escapeHtml(r.registrationNumber)}</td>
        <td>${r.score} / ${r.total}</td>
        <td>${r.disqualified ? "Yes" : "No"}</td>
        <td>${r.finishedAt ? new Date(r.finishedAt).toLocaleString() : ""}</td>
      `;
      resultsTableBody.appendChild(tr);
    });
  }

  document.getElementById("refresh-results").addEventListener("click", () => {
    loadResults().catch((err) => alert("Could not load results: " + err.message));
  });

  document.getElementById("clear-results").addEventListener("click", async () => {
    const quizId = exportFilter.value;
    const scope = quizId ? `for quiz "${quizId}"` : "for ALL quizzes";
    const password = prompt(
      `This permanently deletes every saved result ${scope}. Re-enter the admin password to confirm:`
    );
    if (password === null) return;
    try {
      const result = await api("/api/admin/results", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, quizId: quizId || undefined }),
      });
      alert(`Deleted ${result.deletedCount} result(s).`);
      await loadResults();
    } catch (err) {
      alert("Could not clear results: " + err.message);
    }
  });

  // ---------- Init ----------
  async function refreshAll() {
    const [config] = await Promise.all([api("/api/admin/config"), loadQuizzes()]);
    fillConfigForm(config);
    await loadResults();
  }

  refreshAll().catch((err) => {
    dbWarning.hidden = false;
    dbWarning.textContent = "Could not load admin data: " + err.message;
  });
})();
