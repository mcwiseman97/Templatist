const https = require("https");

// ─── HTTP helper ────────────────────────────────────────────────────────────

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Run promises in batches to respect Notion's ~3 req/sec rate limit
async function batchRun(items, batchSize, delayMs, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + batchSize < items.length) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

// ─── Canvas helpers ──────────────────────────────────────────────────────────

function notionHeaders(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

async function validateCanvas(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/users/self`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error("canvas_auth: Invalid Canvas API token.");
  }
  if (result.status !== 200) {
    throw new Error(`canvas_domain: Could not reach Canvas at "${domain}". Check the domain and try again.`);
  }
}

async function getCanvasCourses(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/courses?enrollment_state=active&per_page=100&include[]=teachers&include[]=term`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error("canvas_error: Failed to retrieve courses.");
  }
  return result.body;
}

async function getUpcomingAssignments(domain, token, courseId) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/courses/${courseId}/assignments?bucket=upcoming&per_page=15&order_by=due_at`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status !== 200 || !Array.isArray(result.body)) return [];
  return result.body;
}

// ─── Notion helpers ──────────────────────────────────────────────────────────

async function validateNotion(secret, pageId) {
  const result = await httpsRequest(
    `https://api.notion.com/v1/pages/${pageId}`,
    { method: "GET", headers: notionHeaders(secret) }
  );
  if (result.status === 401) throw new Error("notion_auth: Invalid Notion integration secret.");
  if (result.status === 404) throw new Error("notion_page: Page not found. In Notion, open your target page → click ··· → Connections → select your integration.");
  if (result.status !== 200) throw new Error(`notion_error: Unexpected Notion error (${result.status}).`);
}

async function createDatabase(secret, pageId, title, properties) {
  const result = await httpsRequest(
    "https://api.notion.com/v1/databases",
    { method: "POST", headers: notionHeaders(secret) },
    JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: title } }],
      properties,
    })
  );
  if (result.status !== 200) {
    throw new Error(`notion_error: Could not create "${title}" database (${result.status}).`);
  }
  return result.body.id;
}

async function createPage(secret, databaseId, properties) {
  const result = await httpsRequest(
    "https://api.notion.com/v1/pages",
    { method: "POST", headers: notionHeaders(secret) },
    JSON.stringify({ parent: { database_id: databaseId }, properties })
  );
  return result;
}

// ─── Data transforms ─────────────────────────────────────────────────────────

function assignmentType(assignment) {
  const types = assignment.submission_types || [];
  if (types.includes("online_quiz")) return "Quiz";
  if (types.includes("discussion_topic")) return "Discussion";
  if (types.includes("none") || types.length === 0) {
    const name = (assignment.name || "").toLowerCase();
    if (/exam|midterm|final|test/.test(name)) return "Exam";
    return "Other";
  }
  return "Assignment";
}

function assignmentPriority(points) {
  if (points == null) return "Medium";
  if (points >= 100) return "High";
  if (points >= 50) return "Medium";
  return "Low";
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { canvasToken, canvasDomain, notionPageId, notionSecret } = body;

  if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "all_fields", message: "All four fields are required." }) };
  }

  const domain = canvasDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const pageId = notionPageId.trim().replace(/-/g, "");
  const token = canvasToken.trim();
  const secret = notionSecret.trim();

  try {
    // ── Step 1: Validate credentials ─────────────────────────────────────────
    await validateCanvas(domain, token);
    await validateNotion(secret, pageId);

    // ── Step 2: Fetch all Canvas data in parallel ─────────────────────────────
    const courses = await getCanvasCourses(domain, token);

    const assignmentsByCourse = await Promise.all(
      courses.map((c) => getUpcomingAssignments(domain, token, c.id))
    );

    // ── Step 3: Create Courses database ──────────────────────────────────────
    const coursesDbId = await createDatabase(secret, pageId, "📚 Courses", {
      Name:         { title: {} },
      "Course Code":{ rich_text: {} },
      Instructor:   { rich_text: {} },
      Term:         { rich_text: {} },
      Status:       { select: { options: ["Active","Completed","Dropped"].map((n) => ({ name: n })) } },
      Grade:        { select: { options: ["A","B","C","D","F","Pending"].map((n) => ({ name: n })) } },
      Credits:      { number: { format: "number" } },
      "Canvas URL": { url: {} },
    });

    // ── Step 4: Create Assignments database ───────────────────────────────────
    const assignmentsDbId = await createDatabase(secret, pageId, "📝 Assignments", {
      Name:       { title: {} },
      Course:     { rich_text: {} },
      "Due Date": { date: {} },
      Type:       { select: { options: ["Assignment","Quiz","Discussion","Exam","Other"].map((n) => ({ name: n })) } },
      Points:     { number: { format: "number" } },
      Status:     { select: { options: ["Not Started","In Progress","Submitted","Late","Graded"].map((n) => ({ name: n })) } },
      Priority:   { select: { options: [
        { name: "High",   color: "red" },
        { name: "Medium", color: "yellow" },
        { name: "Low",    color: "blue" },
      ]}},
      Notes:      { rich_text: {} },
    });

    // ── Step 5: Create course pages (parallel, small count) ───────────────────
    await Promise.all(
      courses.map((course) => {
        const instructor = course.teachers && course.teachers[0]
          ? course.teachers[0].display_name
          : "";
        const term = course.term ? course.term.name : "";
        const canvasUrl = `https://${domain}/courses/${course.id}`;

        return createPage(secret, coursesDbId, {
          Name:         { title: [{ text: { content: course.name || "Unnamed Course" } }] },
          "Course Code":{ rich_text: [{ text: { content: course.course_code || "" } }] },
          Instructor:   { rich_text: [{ text: { content: instructor } }] },
          Term:         { rich_text: [{ text: { content: term } }] },
          Status:       { select: { name: "Active" } },
          Grade:        { select: { name: "Pending" } },
          "Canvas URL": { url: canvasUrl },
        });
      })
    );

    // ── Step 6: Flatten assignments and create pages in batches ───────────────
    const allAssignments = [];
    courses.forEach((course, i) => {
      (assignmentsByCourse[i] || []).forEach((a) => {
        allAssignments.push({ course, assignment: a });
      });
    });

    // Sort by due date ascending
    allAssignments.sort((a, b) => {
      const da = a.assignment.due_at ? new Date(a.assignment.due_at) : Infinity;
      const db = b.assignment.due_at ? new Date(b.assignment.due_at) : Infinity;
      return da - db;
    });

    await batchRun(allAssignments, 3, 400, ({ course, assignment }) => {
      const props = {
        Name:     { title: [{ text: { content: assignment.name || "Unnamed Assignment" } }] },
        Course:   { rich_text: [{ text: { content: course.name || "" } }] },
        Type:     { select: { name: assignmentType(assignment) } },
        Points:   { number: assignment.points_possible ?? null },
        Status:   { select: { name: "Not Started" } },
        Priority: { select: { name: assignmentPriority(assignment.points_possible) } },
      };
      if (assignment.due_at) {
        props["Due Date"] = { date: { start: assignment.due_at.replace("Z", "+00:00") } };
      }
      return createPage(secret, assignmentsDbId, props);
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        courseCount: courses.length,
        assignmentCount: allAssignments.length,
        notionUrl: `https://notion.so/${pageId}`,
      }),
    };
  } catch (err) {
    const msg = err.message || "";

    if (msg.startsWith("canvas_auth"))   return { statusCode: 401, headers, body: JSON.stringify({ error: "canvas_auth",   message: msg.replace("canvas_auth: ", "") }) };
    if (msg.startsWith("canvas_domain")) return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas_domain", message: msg.replace("canvas_domain: ", "") }) };
    if (msg.startsWith("canvas_error"))  return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas",        message: "Could not retrieve your Canvas courses." }) };
    if (msg.startsWith("notion_auth"))   return { statusCode: 401, headers, body: JSON.stringify({ error: "notion_auth",   message: msg.replace("notion_auth: ", "") }) };
    if (msg.startsWith("notion_page"))   return { statusCode: 404, headers, body: JSON.stringify({ error: "notion_page",   message: msg.replace("notion_page: ", "") }) };
    if (msg.startsWith("notion_error"))  return { statusCode: 502, headers, body: JSON.stringify({ error: "notion",        message: "Could not create your Notion workspace." }) };

    return { statusCode: 500, headers, body: JSON.stringify({ error: "server", message: "An unexpected error occurred." }) };
  }
};
