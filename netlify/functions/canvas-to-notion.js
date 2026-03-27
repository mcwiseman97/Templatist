/**
 * Stage 1 — validates credentials, builds the full Semester Hub shell,
 * then triggers Stage 2 server-side (no CORS) so assignments/notes/planner
 * populate in the background while the user opens Notion immediately.
 */

const https = require("https");
const http  = require("http");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Aesthetic cover images (Unsplash) ───────────────────────────────────────
const COVERS = [
  "https://images.unsplash.com/photo-1518173946687-a4c8892bbd9f?w=800",
  "https://images.unsplash.com/photo-1504701954957-2010ec3bcec1?w=800",
  "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800",
  "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=800",
  "https://images.unsplash.com/photo-1475924156734-496f6cac6ec1?w=800",
  "https://images.unsplash.com/photo-1552083974-186346191183?w=800",
  "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=800",
  "https://images.unsplash.com/photo-1542273917363-3b1817f69a2d?w=800",
  "https://images.unsplash.com/photo-1501854140801-50d01698950b?w=800",
  "https://images.unsplash.com/photo-1540979388789-6cee28a1cdc9?w=800",
];

// ─── HTTP helper ──────────────────────────────────────────────────────────────

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

// ─── Block factories ──────────────────────────────────────────────────────────

const rt  = (t) => [{ type: "text", text: { content: String(t) } }];
const h2  = (t) => ({ object: "block", type: "heading_2",          heading_2:          { rich_text: rt(t) } });
const p   = (t) => ({ object: "block", type: "paragraph",          paragraph:          { rich_text: rt(t) } });
const div = ()  => ({ object: "block", type: "divider",            divider:            {} });
const todo     = (t, done = false) => ({ object: "block", type: "to_do",              to_do:              { rich_text: rt(t), checked: done } });
const callout  = (t, emoji, color = "purple_background") => ({
  object: "block", type: "callout",
  callout: { rich_text: rt(t), icon: { type: "emoji", emoji }, color },
});

function mentionBullet(label, pageId) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [
        {
          type: "mention",
          mention: { type: "page", page: { id: pageId } },
          plain_text: label,
          href: `https://www.notion.so/${pageId.replace(/-/g, "")}`,
        },
      ],
    },
  };
}

function scheduleTable() {
  const days = ["Time", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const times = ["8:00 AM", "9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM",
                 "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM"];
  const cellRt = (t) => [{ type: "text", text: { content: t } }];
  const rows = [
    { object: "block", type: "table_row", table_row: { cells: days.map((d) => cellRt(d)) } },
    ...times.map((t) => ({
      object: "block", type: "table_row",
      table_row: { cells: [cellRt(t), cellRt(""), cellRt(""), cellRt(""), cellRt(""), cellRt("")] },
    })),
  ];
  return {
    object: "block", type: "table",
    table: { table_width: 6, has_column_header: true, has_row_header: true, children: rows },
  };
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

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

async function getAllAssignments(domain, token, courseId) {
  const r = await httpsRequest(
    `https://${domain}/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

async function batchRun(items, size, delay, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    if (i + size < items.length) await sleep(delay);
  }
  return results;
}

function assignmentType(a) {
  const types = a.submission_types || [];
  if (types.includes("online_quiz")) return "Quiz";
  if (types.includes("discussion_topic")) return "Discussion";
  if (types.every((t) => t === "none") || types.length === 0) {
    if (/final/i.test(a.name   || "")) return "Exam";
    if (/midterm/i.test(a.name || "")) return "Exam";
    if (/quiz/i.test(a.name    || "")) return "Quiz";
    if (/lab/i.test(a.name     || "")) return "Lab";
    if (/project/i.test(a.name || "")) return "Project";
    return "Other";
  }
  return "Assignment";
}

function isExam(a) { const t = assignmentType(a); return t === "Quiz" || t === "Exam"; }

function assignmentPriority(pts) {
  if (pts == null) return "Medium";
  if (pts >= 100)  return "High";
  if (pts >= 50)   return "Medium";
  return "Low";
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

async function createDbRow(secret, dbId, properties, cover) {
  const body = { parent: { database_id: dbId }, properties };
  if (cover) body.cover = { type: "external", external: { url: cover } };
  return nPost(secret, "pages", body);
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

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

// ─── Server-side Stage 2 trigger ─────────────────────────────────────────────

function triggerStage2(eventHost, payload) {
  const payloadStr = JSON.stringify(payload);
  const isLocal    = (eventHost || "").includes("localhost");
  const httpMod    = isLocal ? http : https;
  const host       = eventHost || "localhost:8080";
  const [hostname, port] = host.split(":");

  const options = {
    hostname,
    port:   port ? parseInt(port) : (isLocal ? 80 : 443),
    path:   "/.netlify/functions/canvas-populate-background",
    method: "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(payloadStr),
    },
  };

  const req = httpMod.request(options);
  req.on("error", () => {}); // Swallow errors — fire and forget
  req.write(payloadStr);
  req.end();
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
    // ── 1. Validate ───────────────────────────────────────────────────────────
    await validateCanvas(domain, token);
    await validateNotion(secret, pageId);

    // ── 2. Fetch Canvas data ──────────────────────────────────────────────────
    const courses = await getCanvasCourses(domain, token);
    const termName  = courses.find((c) => c.term?.name)?.term?.name || "Semester";

    // Fetch ALL semester assignments in parallel (no bucket filter)
    const assignmentsByCourse = await Promise.all(
      courses.map((c) => getAllAssignments(domain, token, c.id))
    );
    const allAssignments = [];
    courses.forEach((c, i) =>
      (assignmentsByCourse[i] || []).forEach((a) => allAssignments.push({ course: c, assignment: a }))
    );
    allAssignments.sort((a, b) => {
      const da = a.assignment.due_at ? new Date(a.assignment.due_at) : Infinity;
      const db = b.assignment.due_at ? new Date(b.assignment.due_at) : Infinity;
      return da - db;
    });
    const thisWeek = getThisWeek(allAssignments);

    // ── 3. Create Semester Hub page (empty shell) ─────────────────────────────
    const hubId = await createPage(secret, pageId, `🌸 ${termName} Hub`, "🌸");

    // ── 4. Create all 8 sub-pages (capture IDs for navigation mentions) ───────
    const [
      classesId, assignmentsPageId, weekPlanId,
      dailyPlannersId, calendarId, studyRoomId,
      graduationId, notesId,
    ] = await Promise.all([
      createPage(secret, hubId, "📚 Classes",          "📚", [callout("Your per-course note pages will appear here as they're built.", "⏳", "gray_background")]),
      createPage(secret, hubId, "📝 Assignments",      "📝", [callout("Your assignment and exam databases will appear here as they're built.", "⏳", "gray_background")]),
      createPage(secret, hubId, "📅 Week Plan",        "📅", [callout("Your weekly planner pages will appear here as they're built.", "⏳", "gray_background")]),
      createPage(secret, hubId, "📆 Daily Planners",   "📆", [callout("Your daily planner pages will appear here as they're built.", "⏳", "gray_background")]),
      createPage(secret, hubId, "🗓️ Monthly Calendar", "🗓️", [
        callout("To see your assignments on a monthly calendar:", "📅", "blue_background"),
        p("1. Open the 📝 Assignments page"),
        p("2. Click '+ Add a view' on the Assignment Tracker database"),
        p("3. Choose 'Calendar' → set date field to 'Due Date'"),
        p("Your full semester will appear as a visual calendar instantly."),
      ]),
      createPage(secret, hubId, "📖 Study Room",       "📖"),
      createPage(secret, hubId, "🎓 Graduation Path",  "🎓"),
      createPage(secret, hubId, "📓 Notes",            "📓"),
    ]);

    // ── 5. Create Courses gallery database (child of hub, with cover images) ──
    const coursesDbId = await createDatabase(secret, hubId, "📚 All Courses", {
      Name:          { title: {} },
      "Course Code": { rich_text: {} },
      Instructor:    { rich_text: {} },
      Term:          { rich_text: {} },
      Status: { select: { options: ["Active","Completed","Dropped"].map((n) => ({ name: n })) } },
      Grade:  { select: { options: ["A","A-","B+","B","B-","C+","C","D","F","Pending"].map((n) => ({ name: n })) } },
      Credits:       { number: { format: "number" } },
      "Canvas URL":  { url: {} },
    });

    // ── 6. Create Assignments + Exams databases under Assignments sub-page ────
    const assignmentsDbId = await createDatabase(secret, assignmentsPageId, "📝 Assignment Tracker", {
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

    const examsDbId = await createDatabase(secret, assignmentsPageId, "🎯 Exams & Quizzes", {
      Name:   { title: {} },
      Course: { rich_text: {} },
      Date:   { date: {} },
      Type:   { select: { options: ["Quiz","Midterm","Final","Lab Practical","Other"].map((n) => ({ name: n })) } },
      Status: { select: { options: ["Upcoming","Studying","Ready","Completed"].map((n) => ({ name: n })) } },
      Score:  { number: { format: "number" } },
      Notes:  { rich_text: {} },
    });

    // ── 7. Populate Courses DB (parallel, with cover images) ──────────────────
    await Promise.all(courses.map((c, i) =>
      createDbRow(secret, coursesDbId, {
        Name:          { title:     [{ text: { content: c.name || "Unnamed" } }] },
        "Course Code": { rich_text: [{ text: { content: c.course_code || "" } }] },
        Instructor:    { rich_text: [{ text: { content: c.teachers?.[0]?.display_name || "" } }] },
        Term:          { rich_text: [{ text: { content: c.term?.name || "" } }] },
        Status:        { select: { name: "Active" } },
        Grade:         { select: { name: "Pending" } },
        "Canvas URL":  { url: `https://${domain}/courses/${c.id}` },
      }, COVERS[i % COVERS.length])
    ));

    // ── 7b. Populate Assignment Tracker DB (all semester assignments) ──────────
    await batchRun(allAssignments, 5, 250, ({ course: c, assignment: a }) => {
      const props = {
        Name:     { title:     [{ text: { content: a.name || "Unnamed" } }] },
        Course:   { rich_text: [{ text: { content: c.name || "" } }] },
        Type:     { select:    { name: assignmentType(a) } },
        Points:   { number:    a.points_possible ?? null },
        Status:   { select:    { name: "Not Started" } },
        Priority: { select:    { name: assignmentPriority(a.points_possible) } },
      };
      if (a.due_at) props["Due Date"] = { date: { start: a.due_at.replace("Z", "+00:00") } };
      return createDbRow(secret, assignmentsDbId, props);
    });

    // ── 7c. Populate Exams & Quizzes DB ───────────────────────────────────────
    const exams = allAssignments.filter(({ assignment: a }) => isExam(a));
    await batchRun(exams, 5, 250, ({ course: c, assignment: a }) => {
      const props = {
        Name:   { title:     [{ text: { content: a.name || "Unnamed" } }] },
        Course: { rich_text: [{ text: { content: c.name || "" } }] },
        Type:   { select:    { name: assignmentType(a) === "Quiz" ? "Quiz" : "Midterm" } },
        Status: { select:    { name: "Upcoming" } },
      };
      if (a.due_at) props["Date"] = { date: { start: a.due_at.replace("Z", "+00:00") } };
      return createDbRow(secret, examsDbId, props);
    });

    // ── 8. Build hub page content (navigation columns + goals + schedule) ─────
    const hubBlocks = [
      callout(`${termName}  ·  ${courses.length} course${courses.length !== 1 ? "s" : ""}`, "🌸", "purple_background"),
      div(),

      // Three-column layout: Navigation | spacer | Semester Goals
      {
        object: "block", type: "column_list",
        column_list: {
          children: [
            {
              type: "column",
              column: {
                children: [
                  h2("🗺️  Navigation"),
                  div(),
                  mentionBullet("📚  Classes",          classesId),
                  mentionBullet("📝  Assignments",      assignmentsPageId),
                  mentionBullet("📅  Week Plan",        weekPlanId),
                  mentionBullet("📆  Daily Planners",   dailyPlannersId),
                  mentionBullet("🗓️  Monthly Calendar", calendarId),
                  mentionBullet("📖  Study Room",       studyRoomId),
                  mentionBullet("🎓  Graduation Path",  graduationId),
                  mentionBullet("📓  Notes",            notesId),
                ],
              },
            },
            {
              type: "column",
              column: {
                children: [
                  h2("🎯  Semester Goals"),
                  div(),
                  todo("Earn a B or higher in every class"),
                  todo("Stay on top of assignments week by week"),
                  todo("Attend office hours when I'm struggling"),
                  todo(" "),
                  todo(" "),
                  todo(" "),
                ],
              },
            },
          ],
        },
      },

      div(),

      // Due This Week
      h2("📅  Due This Week"),
      ...(thisWeek.length === 0
        ? [callout("Nothing due this week — you're ahead!", "✅", "green_background")]
        : thisWeek.map(({ course: c, assignment: a }) =>
            todo(`${a.name}  ·  ${c.name}  ·  ${shortDate(a.due_at)}`)
          )
      ),

      div(),
      h2("📅  Class Schedule"),
      p("Fill in your class times below."),
      scheduleTable(),
    ];

    await appendBlocks(secret, hubId, hubBlocks);

    // ── 9. Trigger Stage 2 server-side (fire and forget) ──────────────────────
    // Stage 2 handles: course note pages, weekly planners, daily planners,
    // study room, graduation path, notes — assignments are already done in Stage 1.
    triggerStage2(event.headers?.host, {
      canvasToken:      token,
      canvasDomain:     domain,
      notionSecret:     secret,
      classesId,
      weekPlanId,
      dailyPlannersId,
      studyRoomId,
      graduationId,
      notesId,
      courses: courses.map((c) => ({
        id:          c.id,
        name:        c.name        || "Unnamed Course",
        course_code: c.course_code || "",
        instructor:  c.teachers?.[0]?.display_name || "",
        term_name:   c.term?.name    || "",
        term_start:  c.term?.start_at || null,
        term_end:    c.term?.end_at   || null,
      })),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success:     true,
        courseCount: courses.length,
        hubUrl:      `https://notion.so/${hubId.replace(/-/g, "")}`,
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
