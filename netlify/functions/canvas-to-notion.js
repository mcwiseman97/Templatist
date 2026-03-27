/**
 * Stage 1 — validates credentials, fetches courses, builds the Semester Hub
 * shell (databases + structure), and returns the Hub URL immediately.
 * The browser then fires Stage 2 (canvas-populate-background) to fill in
 * all semester assignments, course notes, and weekly planner pages.
 */

const https = require("https");

// ─── HTTP ────────────────────────────────────────────────────────────────────

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

function nh(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

async function nPost(secret, path, body) {
  return httpsRequest(`https://api.notion.com/v1/${path}`,
    { method: "POST", headers: nh(secret) }, JSON.stringify(body));
}

async function nPatch(secret, path, body) {
  return httpsRequest(`https://api.notion.com/v1/${path}`,
    { method: "PATCH", headers: nh(secret) }, JSON.stringify(body));
}

async function appendBlocks(secret, id, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await nPatch(secret, `blocks/${id}/children`, { children: blocks.slice(i, i + 100) });
    if (i + 100 < blocks.length) await sleep(350);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Block factories ──────────────────────────────────────────────────────────

const rt = (t) => [{ type: "text", text: { content: String(t) } }];
const h2       = (t)       => ({ object: "block", type: "heading_2",          heading_2:          { rich_text: rt(t) } });
const p        = (t)       => ({ object: "block", type: "paragraph",          paragraph:          { rich_text: rt(t) } });
const divider  = ()        => ({ object: "block", type: "divider",            divider:            {} });
const todo     = (t, done = false) => ({ object: "block", type: "to_do",      to_do:              { rich_text: rt(t), checked: done } });
const callout  = (t, emoji, color = "purple_background") => ({
  object: "block", type: "callout",
  callout: { rich_text: rt(t), icon: { type: "emoji", emoji }, color },
});

// ─── Canvas ───────────────────────────────────────────────────────────────────

async function validateCanvas(domain, token) {
  const r = await httpsRequest(`https://${domain}/api/v1/users/self`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403)
    throw new Error("canvas_auth: Invalid Canvas API token.");
  if (r.status !== 200)
    throw new Error(`canvas_domain: Could not reach Canvas at "${domain}". Check the domain.`);
}

async function getCanvasCourses(domain, token) {
  const r = await httpsRequest(
    `https://${domain}/api/v1/courses?enrollment_state=active&per_page=100&include[]=teachers&include[]=term`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200 || !Array.isArray(r.body))
    throw new Error("canvas_error: Failed to retrieve courses.");
  return r.body;
}

async function getUpcomingAssignments(domain, token, courseId) {
  const r = await httpsRequest(
    `https://${domain}/api/v1/courses/${courseId}/assignments?bucket=upcoming&per_page=10&order_by=due_at`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

// ─── Notion builders ──────────────────────────────────────────────────────────

async function validateNotion(secret, pageId) {
  const r = await httpsRequest(`https://api.notion.com/v1/pages/${pageId}`,
    { method: "GET", headers: nh(secret) });
  if (r.status === 401) throw new Error("notion_auth: Invalid Notion integration secret.");
  if (r.status === 404) throw new Error("notion_page: Page not found. In Notion, open your target page → ··· → Connections → select your integration.");
  if (r.status !== 200) throw new Error(`notion_error: Notion error (${r.status}).`);
}

async function createPage(secret, parentId, title, emoji, children = []) {
  const r = await nPost(secret, "pages", {
    parent: { page_id: parentId },
    icon: { type: "emoji", emoji },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    children: children.slice(0, 100),
  });
  if (r.status !== 200) throw new Error(`notion_error: Could not create page "${title}" (${r.status})`);
  const id = r.body.id;
  if (children.length > 100) await appendBlocks(secret, id, children.slice(100));
  return id;
}

async function createDatabase(secret, parentId, title, properties) {
  const r = await nPost(secret, "databases", {
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  if (r.status !== 200) throw new Error(`notion_error: Could not create "${title}" DB (${r.status}).`);
  return r.body.id;
}

async function createDbRow(secret, dbId, properties) {
  return nPost(secret, "pages", { parent: { database_id: dbId }, properties });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortDate(iso) {
  if (!iso) return "No due date";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function getThisWeek(all) {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return all.filter(({ assignment: a }) => {
    if (!a.due_at) return false;
    const d = new Date(a.due_at);
    return d >= now && d <= end;
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid body" }) }; }

  const { canvasToken, canvasDomain, notionPageId, notionSecret } = body;
  if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "all_fields", message: "All four fields are required." }) };

  const domain = canvasDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const pageId = notionPageId.trim().replace(/-/g, "");
  const token  = canvasToken.trim();
  const secret = notionSecret.trim();

  try {
    // ── Validate ─────────────────────────────────────────────────────────────
    await validateCanvas(domain, token);
    await validateNotion(secret, pageId);

    // ── Fetch courses + quick upcoming ───────────────────────────────────────
    const courses = await getCanvasCourses(domain, token);
    const upcomingByCourse = await Promise.all(
      courses.map((c) => getUpcomingAssignments(domain, token, c.id))
    );
    const allUpcoming = [];
    courses.forEach((c, i) =>
      (upcomingByCourse[i] || []).forEach((a) => allUpcoming.push({ course: c, assignment: a }))
    );
    const thisWeek = getThisWeek(allUpcoming);

    // ── Determine semester name from term data ────────────────────────────────
    const termName = courses.find((c) => c.term?.name)?.term?.name || "Semester";

    // ── Create Semester Hub page ─────────────────────────────────────────────
    const topBlocks = [
      callout(
        `${courses.length} course${courses.length !== 1 ? "s" : ""}  •  Use the Calendar view on Assignments to see your full semester at a glance.`,
        "🎓"
      ),
      divider(),
      h2("📅  Due This Week"),
      ...(thisWeek.length === 0
        ? [callout("Nothing due this week — you're ahead!", "✅", "green_background")]
        : thisWeek.map(({ course: c, assignment: a }) =>
            todo(`${a.name}  ·  ${c.name}  ·  ${shortDate(a.due_at)}`)
          )),
      divider(),
    ];

    const hubId = await createPage(secret, pageId, `🎓 ${termName} Hub`, "🎓", topBlocks);

    // ── Courses section + database ────────────────────────────────────────────
    await appendBlocks(secret, hubId, [h2("📚  My Courses")]);
    const coursesDbId = await createDatabase(secret, hubId, "📚 Courses", {
      Name:          { title: {} },
      "Course Code": { rich_text: {} },
      Instructor:    { rich_text: {} },
      Term:          { rich_text: {} },
      Status: { select: { options: ["Active","Completed","Dropped"].map((n) => ({ name: n })) } },
      Grade:  { select: { options: ["A","A-","B+","B","B-","C+","C","D","F","Pending"].map((n) => ({ name: n })) } },
      Credits:       { number: { format: "number" } },
      "Canvas URL":  { url: {} },
    });

    // Populate courses in parallel (small count, won't hit rate limit)
    await Promise.all(courses.map((c) =>
      createDbRow(secret, coursesDbId, {
        Name:          { title:     [{ text: { content: c.name || "Unnamed" } }] },
        "Course Code": { rich_text: [{ text: { content: c.course_code || "" } }] },
        Instructor:    { rich_text: [{ text: { content: c.teachers?.[0]?.display_name || "" } }] },
        Term:          { rich_text: [{ text: { content: c.term?.name || "" } }] },
        Status:        { select: { name: "Active" } },
        Grade:         { select: { name: "Pending" } },
        "Canvas URL":  { url: `https://${domain}/courses/${c.id}` },
      })
    ));

    // ── Assignments section + empty database ──────────────────────────────────
    await appendBlocks(secret, hubId, [
      h2("📝  Assignment Tracker"),
      p("💡 Tip: Open this database → Add a view → Calendar → Due Date to see your full semester on a calendar."),
    ]);
    const assignmentsDbId = await createDatabase(secret, hubId, "📝 Assignment Tracker", {
      Name:       { title: {} },
      Course:     { rich_text: {} },
      "Due Date": { date: {} },
      Type:       { select: { options: ["Assignment","Quiz","Discussion","Exam","Project","Lab","Other"].map((n) => ({ name: n })) } },
      Points:     { number: { format: "number" } },
      Status:     { select: { options: ["Not Started","In Progress","Submitted","Late","Graded"].map((n) => ({ name: n })) } },
      Priority:   { select: { options: [
        { name: "High",   color: "red"    },
        { name: "Medium", color: "yellow" },
        { name: "Low",    color: "blue"   },
      ]}},
      Notes: { rich_text: {} },
    });

    // ── Exams & Quizzes section + empty database ──────────────────────────────
    await appendBlocks(secret, hubId, [h2("🎯  Exams & Quizzes")]);
    const examsDbId = await createDatabase(secret, hubId, "🎯 Exams & Quizzes", {
      Name:    { title: {} },
      Course:  { rich_text: {} },
      Date:    { date: {} },
      Type:    { select: { options: ["Quiz","Midterm","Final","Lab Practical","Other"].map((n) => ({ name: n })) } },
      Status:  { select: { options: ["Upcoming","Studying","Ready","Completed"].map((n) => ({ name: n })) } },
      Score:   { number: { format: "number" } },
      Notes:   { rich_text: {} },
    });

    // ── Placeholder headings for Stage 2 sections ─────────────────────────────
    await appendBlocks(secret, hubId, [
      h2("📓  Course Notes"),
      p("⏳ Building your course note pages..."),
      h2("🗓️  Weekly Planner"),
      p("⏳ Building your full semester planner..."),
    ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        courseCount: courses.length,
        hubPageId: hubId,
        hubUrl: `https://notion.so/${hubId.replace(/-/g, "")}`,
        // Pass these to Stage 2
        assignmentsDbId,
        examsDbId,
        courses: courses.map((c) => ({
          id:          c.id,
          name:        c.name,
          course_code: c.course_code,
          instructor:  c.teachers?.[0]?.display_name || "",
          term_name:   c.term?.name || "",
          term_start:  c.term?.start_at || null,
          term_end:    c.term?.end_at || null,
        })),
      }),
    };
  } catch (err) {
    const msg = err.message || "";
    if (msg.startsWith("canvas_auth"))   return { statusCode: 401, headers, body: JSON.stringify({ error: "canvas_auth",   message: msg.replace("canvas_auth: ",   "") }) };
    if (msg.startsWith("canvas_domain")) return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas_domain", message: msg.replace("canvas_domain: ", "") }) };
    if (msg.startsWith("canvas_error"))  return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas",        message: "Could not retrieve your Canvas courses." }) };
    if (msg.startsWith("notion_auth"))   return { statusCode: 401, headers, body: JSON.stringify({ error: "notion_auth",   message: msg.replace("notion_auth: ",   "") }) };
    if (msg.startsWith("notion_page"))   return { statusCode: 404, headers, body: JSON.stringify({ error: "notion_page",   message: msg.replace("notion_page: ",   "") }) };
    if (msg.startsWith("notion_error"))  return { statusCode: 502, headers, body: JSON.stringify({ error: "notion",        message: "Could not create your Notion workspace." }) };
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server", message: "An unexpected error occurred." }) };
  }
};
