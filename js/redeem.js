(function () {
  const form       = document.getElementById("redeem-form");
  const formPanel  = document.getElementById("redeem-form-panel");
  const loadPanel  = document.getElementById("loading-panel");
  const loadMsg    = document.getElementById("loading-message");
  const successPanel = document.getElementById("success-panel");
  const successMsg   = document.getElementById("success-message");
  const notionLink   = document.getElementById("notion-link");
  const errorPanel   = document.getElementById("error-panel");
  const errorMsg     = document.getElementById("error-message");
  const formError    = document.getElementById("form-error");
  const submitBtn    = document.getElementById("submit-btn");
  const tryAgainBtn  = document.getElementById("try-again-btn");

  function showPanel(id) {
    [formPanel, loadPanel, successPanel, errorPanel].forEach((p) => {
      p.hidden = p.id !== id;
    });
  }

  const errorMessages = {
    canvas_auth:   "Invalid Canvas API token. Re-generate it in Canvas → Account → Settings → Approved Integrations.",
    canvas_domain: null, // use server message
    canvas:        "Could not retrieve your Canvas courses. Check your token and domain.",
    notion_auth:   "Invalid Notion integration secret. Check your integration at notion.so/my-integrations.",
    notion_page:   "Page not found. In Notion, open your target page → click ··· → Connections → select your integration. Then try again.",
    notion:        "Could not create your Notion workspace. Make sure your integration is shared with the target page.",
    all_fields:    "Please fill in all four fields.",
    server:        "An unexpected error occurred. Please try again.",
  };

  tryAgainBtn.addEventListener("click", () => {
    showPanel("redeem-form-panel");
    formError.textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";

    const canvasToken   = document.getElementById("canvas-token").value.trim();
    const canvasDomain  = document.getElementById("canvas-domain").value.trim();
    const notionPageId  = document.getElementById("notion-page-id").value.trim();
    const notionSecret  = document.getElementById("notion-secret").value.trim();

    if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret) {
      formError.textContent = "Please fill in all four fields before continuing.";
      return;
    }

    submitBtn.disabled = true;
    showPanel("loading-panel");

    // Cycle through messages while Stage 1 runs (~8-15s)
    const stage1Steps = [
      "Validating Canvas credentials…",
      "Validating Notion credentials…",
      "Fetching your courses…",
      "Building your Semester Hub…",
      "Creating databases…",
      "Almost ready…",
    ];
    let stepIdx = 0;
    loadMsg.textContent = stage1Steps[0];
    const stepTimer = setInterval(() => {
      stepIdx = Math.min(stepIdx + 1, stage1Steps.length - 1);
      loadMsg.textContent = stage1Steps[stepIdx];
    }, 2500);

    try {
      // ── Stage 1: Create shell structure ──────────────────────────────────
      const res1 = await fetch("/.netlify/functions/canvas-to-notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvasToken, canvasDomain, notionPageId, notionSecret }),
      });

      clearInterval(stepTimer);
      const data1 = await res1.json();

      if (!res1.ok) throw data1;

      // ── Stage 2: Fire-and-forget background population ────────────────────
      fetch("/.netlify/functions/canvas-populate-background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasToken,
          canvasDomain,
          notionSecret,
          hubPageId:        data1.hubPageId,
          assignmentsDbId:  data1.assignmentsDbId,
          examsDbId:        data1.examsDbId,
          courses:          data1.courses,
        }),
      }).catch(() => {}); // Fire and forget — background function returns 202

      // ── Show success immediately with the Hub link ────────────────────────
      const count = data1.courseCount;
      successMsg.innerHTML =
        `Your Semester Hub is live with <strong>${count} course${count !== 1 ? "s" : ""}</strong>.<br><br>` +
        `Your full assignment tracker, course note pages, and semester-long weekly planner ` +
        `are being built in the background — open Notion in about 2 minutes to see everything populated.`;
      notionLink.href = data1.hubUrl || "https://notion.so";
      showPanel("success-panel");

    } catch (err) {
      clearInterval(stepTimer);
      const code = err && err.error;
      const msg  = errorMessages[code] === null
        ? err.message
        : (errorMessages[code] || err.message || "An unexpected error occurred.");
      errorMsg.textContent = msg;
      showPanel("error-panel");
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
