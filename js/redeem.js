(function () {
  const form = document.getElementById("redeem-form");
  const formPanel = document.getElementById("redeem-form-panel");
  const loadingPanel = document.getElementById("loading-panel");
  const loadingMessage = document.getElementById("loading-message");
  const successPanel = document.getElementById("success-panel");
  const successMessage = document.getElementById("success-message");
  const notionLink = document.getElementById("notion-link");
  const errorPanel = document.getElementById("error-panel");
  const errorMessage = document.getElementById("error-message");
  const formError = document.getElementById("form-error");
  const submitBtn = document.getElementById("submit-btn");
  const tryAgainBtn = document.getElementById("try-again-btn");

  function showPanel(panelId) {
    [formPanel, loadingPanel, successPanel, errorPanel].forEach((p) => {
      p.hidden = p.id !== panelId;
    });
  }

  // Map error codes to user-friendly messages
  const errorMessages = {
    canvas_auth: "Invalid Canvas API token. Re-generate it in Canvas → Account → Settings → Approved Integrations.",
    canvas_domain: null, // use server message (includes the domain)
    canvas: "Could not retrieve your Canvas courses. Check your token and domain.",
    notion_auth: "Invalid Notion integration secret. Check your integration at notion.so/my-integrations.",
    notion_page: "Page not found. In Notion, open your target page → click ··· (top right) → Connections → select your integration. Then try again.",
    notion: "Could not create your Notion database. Make sure your integration is shared with the target page.",
    all_fields: "Please fill in all four fields.",
    server: "An unexpected error occurred. Please try again.",
  };

  tryAgainBtn.addEventListener("click", () => {
    showPanel("redeem-form-panel");
    formError.textContent = "";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.textContent = "";

    const canvasToken = document.getElementById("canvas-token").value.trim();
    const canvasDomain = document.getElementById("canvas-domain").value.trim();
    const notionPageId = document.getElementById("notion-page-id").value.trim();
    const notionSecret = document.getElementById("notion-secret").value.trim();

    if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret) {
      formError.textContent = "Please fill in all four fields before continuing.";
      return;
    }

    submitBtn.disabled = true;
    showPanel("loading-panel");
    loadingMessage.textContent = "Validating Canvas credentials…";

    try {
      const response = await fetch("/.netlify/functions/canvas-to-notion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canvasToken, canvasDomain, notionPageId, notionSecret }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw data;
      }

      // Update loading message while we waited for the build
      loadingMessage.textContent = "Building your Notion database…";

      const count = data.courseCount;
      successMessage.textContent = `Done! Created your Semester Dashboard with ${count} active course${count !== 1 ? "s" : ""}.`;
      notionLink.href = data.notionUrl || "https://notion.so";
      showPanel("success-panel");
    } catch (err) {
      const code = err && err.error;
      const msg = errorMessages[code] === null
        ? err.message
        : (errorMessages[code] || err.message || "An unexpected error occurred.");
      errorMessage.textContent = msg;
      showPanel("error-panel");
    } finally {
      submitBtn.disabled = false;
    }
  });
})();
