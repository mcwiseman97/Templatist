const https = require("https");

// ─── HTTP ────────────────────────────────────────────────────────────────────

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
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

async function batchRun(items, size, delay, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    results.push(...await Promise.all(batch.map(fn)));
    if (i + size < items.length) await new Promise((r) => setTimeout(r, delay));
  }
  return results;
}

// ─── Notion API ───────────────────────────────────────────────────────────────

function notionHeaders(secret) {
  return {
    Authorization: `Bearer ${secret}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28",
  };
}

async function notionPost(secret, path, body) {
  return httpsRequest(
    `https://api.notion.com/v1/${path}`,
    { method: "POST", headers: notionHeaders(secret) },
    JSON.stringify(body)
  );
}

async function notionPatch(secret, path, body) {
  return httpsRequest(
    `https://api.notion.com/v1/${path}`,
    { method: "PATCH", headers: notionHeaders(secret) },
    JSON.stringify(body)
  );
}

async function appendBlocks(secret, blockId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100);
    await notionPatch(secret, `blocks/${blockId}/children`, { children: batch });
    if (i + 100 < blocks.length) await new Promise((r) => setTimeout(r, 350));
  }
}

// ─── Block helpers ────────────────────────────────────────────────────────────

const rt = (text) => [{ type: "text", text: { content: String(text) } }];

const h2       = (text)              => ({ object: "block", type: "heading_2",          heading_2:          { rich_text: rt(text) } });
const h3       = (text)              => ({ object: "block", type: "heading_3",          heading_3:          { rich_text: rt(text) } });
const p        = (text)              => ({ object: "block", type: "paragraph",          paragraph:          { rich_text: rt(text) } });
const divider  = ()                  => ({ object: "block", type: "divider",            divider:            {} });
const todo     = (text, checked = false) => ({ object: "block", type: "to_do",         to_do:              { rich_text: rt(text), checked } });
const bullet   = (text)              => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(text) } });
const callout  = (text, emoji, color = "purple_background") => ({
  object: "block", type: "callout",
  callout: { rich_text: rt(text), icon: { type: "emoji", emoji }, color },
});
const toggle   = (text, children = []) => ({
  object: "block", type: "toggle",
  toggle: { rich_text: rt(text), children },
});

// ─── Canvas ───────────────────────────────────────────────────────────────────

async function validateCanvas(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/users/self`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status === 401 || result.status === 403)
    throw new Error("canvas_auth: Invalid Canvas API token.");
  if (result.status !== 200)
    throw new Error(`canvas_domain: Could not reach Canvas at "${domain}". Check the domain and try again.`);
}

async function getCanvasCourses(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/courses?enrollment_state=active&per_page=100&include[]=teachers&include[]=term`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status !== 200 || !Array.isArray(result.body))
    throw new Error("canvas_error: Failed to retrieve courses.");
  return result.body;
}

async function getUpcomingAssignments(domain, token, courseId) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/courses/${courseId}/assignments?bucket=upcoming&per_page=8&order_by=due_at`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (result.status !== 200 || !Array.isArray(result.body)) return [];
  return result.body;
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

async function validateNotion(secret, pageId) {
  const result = await httpsRequest(
    `https://api.notion.com/v1/pages/${pageId}`,
    { method: "GET", headers: notionHeaders(secret) }
  );
  if (result.status === 401)
    throw new Error("notion_auth: Invalid Notion integration secret.");
  if (result.status === 404)
    throw new Error("notion_page: Page not found. In Notion, open your target page → click ··· → Connections → select your integration.");
  if (result.status !== 200)
    throw new Error(`notion_error: Unexpected Notion error (${result.status}).`);
}

async function createDatabase(secret, parentId, title, properties) {
  const result = await notionPost(secret, "databases", {
    parent: { type: "page_id", page_id: parentId },
    title: [{ type: "text", text: { content: title } }],
    properties,
  });
  if (result.status !== 200)
    throw new Error(`notion_error: Could not create "${title}" database (${result.status}).`);
  return result.body.id;
}

async function createPage(secret, parentId, title, emoji, children = []) {
  const firstBatch = children.slice(0, 100);
  const rest = children.slice(100);
  const result = await notionPost(secret, "pages", {
    parent: { page_id: parentId },
    icon: { type: "emoji", emoji },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    children: firstBatch,
  });
  if (result.status !== 200)
    throw new Error(`notion_error: Could not create page "${title}" (${result.status})`);
  const newPageId = result.body.id;
  if (rest.length > 0) await appendBlocks(secret, newPageId, rest);
  return newPageId;
}

async function createDbEntry(secret, databaseId, properties) {
  return notionPost(secret, "pages", { parent: { database_id: databaseId }, properties });
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

function assignmentType(a) {
  const types = a.submission_types || [];
  if (types.includes("online_quiz")) return "Quiz";
  if (types.includes("discussion_topic")) return "Discussion";
  if (types.length === 0 || types.every((t) => t === "none")) {
    if (/exam|midterm|final|test/i.test(a.name || "")) return "Exam";
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

function shortDate(iso) {
  if (!iso) return "No due date";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function getThisWeek(allAssignments) {
  const now = new Date();
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return allAssignments.filter(({ assignment: a }) => {
    if (!a.due_at) return false;
    const d = new Date(a.due_at);
    return d >= now && d <= end;
  });
}

function groupByWeek(allAssignments) {
  const map = new Map();
  allAssignments.forEach(({ course, assignment: a }) => {
    if (!a.due_at) return;
    const due = new Date(a.due_at);
    const sun = new Date(due);
    sun.setDate(due.getDate() - due.getDay());
    sun.setHours(0, 0, 0, 0);
    const key = sun.toISOString();
    if (!map.has(key)) map.set(key, { sun, items: [] });
    map.get(key).items.push({ course, assignment: a });
  });
  return [...map.values()].sort((a, b) => a.sun - b.sun);
}

// ─── Template block builders ──────────────────────────────────────────────────

function hubTopBlocks(courseCount, assignmentCount, thisWeek) {
  const blocks = [
    callout(
      `${courseCount} active course${courseCount !== 1 ? "s" : ""}   •   ${assignmentCount} upcoming assignment${assignmentCount !== 1 ? "s" : ""}`,
      "🎓"
    ),
    divider(),
    h2("📅  Due This Week"),
  ];

  if (thisWeek.length === 0) {
    blocks.push(callout("Nothing due this week — you're ahead of the game!", "✅", "green_background"));
  } else {
    thisWeek.forEach(({ course, assignment: a }) =>
      blocks.push(todo(`${a.name}  ·  ${course.name}  ·  ${shortDate(a.due_at)}`))
    );
  }

  blocks.push(divider());
  return blocks;
}

function courseNoteBlocks(course, courseAssignments, domain) {
  const instructor = course.teachers?.[0]?.display_name || "—";
  const term = course.term?.name || "—";
  const canvasUrl = `https://${domain}/courses/${course.id}`;

  const blocks = [
    callout(
      `${course.course_code || ""}  •  ${instructor}  •  ${term}`,
      "📌", "blue_background"
    ),
    divider(),
    h2("📋  Upcoming Assignments"),
  ];

  if (courseAssignments.length === 0) {
    blocks.push(p("No upcoming assignments — check Canvas for details."));
  } else {
    courseAssignments.forEach((a) =>
      blocks.push(
        todo(`${a.name}  ·  ${shortDate(a.due_at)}${a.points_possible != null ? "  ·  " + a.points_possible + " pts" : ""}`)
      )
    );
  }

  blocks.push(
    divider(),
    h2("📖  Lecture Notes"),
    p("Add a new toggle for each class session or week."),
    toggle("Week 1", [p("Notes from class...")]),
    toggle("Week 2", [p("Notes from class...")]),
    toggle("Week 3", [p("Notes from class...")]),
    toggle("Week 4", [p("Notes from class...")]),
    toggle("Week 5", [p("Notes from class...")]),
    toggle("Week 6", [p("Notes from class...")]),
    divider(),
    h2("✏️  Study Notes"),
    p("Key concepts, formulas, and summaries."),
    bullet(" "),
    bullet(" "),
    bullet(" "),
    divider(),
    h2("🃏  Flashcards"),
    toggle("Term  →  Definition", [p("Write the definition here...")]),
    toggle("Term  →  Definition", [p("Write the definition here...")]),
    toggle("Term  →  Definition", [p("Write the definition here...")]),
    divider(),
    h2("🔗  Resources"),
    bullet("Canvas: " + canvasUrl),
    bullet("Textbook: "),
    bullet("Other: "),
  );

  return blocks;
}

function plannerBlocks(allAssignments) {
  const weeks = groupByWeek(allAssignments);

  // Fill in any empty weeks for the next 10 weeks
  const now = new Date();
  const existing = new Set(weeks.map((w) => w.sun.toISOString().split("T")[0]));
  for (let i = 0; i < 10; i++) {
    const sun = new Date(now);
    sun.setDate(now.getDate() - now.getDay() + i * 7);
    sun.setHours(0, 0, 0, 0);
    const key = sun.toISOString().split("T")[0];
    if (!existing.has(key)) weeks.push({ sun, items: [] });
  }
  weeks.sort((a, b) => a.sun - b.sun);

  const blocks = [
    callout("Map out each week, check off tasks, and reflect on your progress.", "🗓️", "gray_background"),
    divider(),
  ];

  weeks.slice(0, 10).forEach(({ sun, items }) => {
    const label = sun.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const children = [h3("📌  Assignments Due")];

    if (items.length === 0) {
      children.push(p("No assignments due this week."));
    } else {
      items.forEach(({ course, assignment: a }) =>
        children.push(todo(`${a.name}  ·  ${course.name}  ·  ${shortDate(a.due_at)}`))
      );
    }

    children.push(
      divider(),
      h3("🎯  Goals This Week"),
      todo(" "),
      todo(" "),
      todo(" "),
      divider(),
      h3("🪞  Weekly Reflection"),
      p("What did I accomplish?"),
      bullet(" "),
      p("What needs my attention next week?"),
      bullet(" "),
    );

    blocks.push(toggle(`Week of ${label}`, children));
  });

  return blocks;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) }; }

  const { canvasToken, canvasDomain, notionPageId, notionSecret } = body;
  if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret)
    return { statusCode: 400, headers, body: JSON.stringify({ error: "all_fields", message: "All four fields are required." }) };

  const domain = canvasDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const pageId = notionPageId.trim().replace(/-/g, "");
  const token  = canvasToken.trim();
  const secret = notionSecret.trim();

  try {
    // ── 1. Validate credentials ──────────────────────────────────────────────
    await validateCanvas(domain, token);
    await validateNotion(secret, pageId);

    // ── 2. Fetch all Canvas data ─────────────────────────────────────────────
    const courses = await getCanvasCourses(domain, token);
    const assignmentsByCourse = await Promise.all(
      courses.map((c) => getUpcomingAssignments(domain, token, c.id))
    );

    const allAssignments = [];
    courses.forEach((course, i) =>
      (assignmentsByCourse[i] || []).forEach((a) => allAssignments.push({ course, assignment: a }))
    );
    allAssignments.sort((a, b) => {
      const da = a.assignment.due_at ? new Date(a.assignment.due_at) : Infinity;
      const db = b.assignment.due_at ? new Date(b.assignment.due_at) : Infinity;
      return da - db;
    });

    const thisWeek = getThisWeek(allAssignments);

    // ── 3. Create Semester Hub page ──────────────────────────────────────────
    const hubId = await createPage(
      secret, pageId, "🎓 Semester Hub", "🎓",
      hubTopBlocks(courses.length, allAssignments.length, thisWeek)
    );

    // ── 4. Courses section + database ────────────────────────────────────────
    await appendBlocks(secret, hubId, [h2("📚  My Courses")]);
    const coursesDbId = await createDatabase(secret, hubId, "📚 Courses", {
      Name:          { title: {} },
      "Course Code": { rich_text: {} },
      Instructor:    { rich_text: {} },
      Term:          { rich_text: {} },
      Status:        { select: { options: ["Active", "Completed", "Dropped"].map((n) => ({ name: n })) } },
      Grade:         { select: { options: ["A", "B", "C", "D", "F", "Pending"].map((n) => ({ name: n })) } },
      Credits:       { number: { format: "number" } },
      "Canvas URL":  { url: {} },
    });

    // ── 5. Assignments section + database ────────────────────────────────────
    await appendBlocks(secret, hubId, [h2("📝  Upcoming Assignments")]);
    const assignmentsDbId = await createDatabase(secret, hubId, "📝 Assignments", {
      Name:       { title: {} },
      Course:     { rich_text: {} },
      "Due Date": { date: {} },
      Type:       { select: { options: ["Assignment", "Quiz", "Discussion", "Exam", "Other"].map((n) => ({ name: n })) } },
      Points:     { number: { format: "number" } },
      Status:     { select: { options: ["Not Started", "In Progress", "Submitted", "Late", "Graded"].map((n) => ({ name: n })) } },
      Priority:   { select: { options: [
        { name: "High", color: "red" },
        { name: "Medium", color: "yellow" },
        { name: "Low", color: "blue" },
      ]}},
      Notes:      { rich_text: {} },
    });

    // ── 6. Populate both databases ───────────────────────────────────────────
    await Promise.all(courses.map((course) =>
      createDbEntry(secret, coursesDbId, {
        Name:          { title:     [{ text: { content: course.name || "Unnamed Course" } }] },
        "Course Code": { rich_text: [{ text: { content: course.course_code || "" } }] },
        Instructor:    { rich_text: [{ text: { content: course.teachers?.[0]?.display_name || "" } }] },
        Term:          { rich_text: [{ text: { content: course.term?.name || "" } }] },
        Status:        { select: { name: "Active" } },
        Grade:         { select: { name: "Pending" } },
        "Canvas URL":  { url: `https://${domain}/courses/${course.id}` },
      })
    ));

    await batchRun(allAssignments, 3, 400, ({ course, assignment: a }) => {
      const props = {
        Name:     { title:     [{ text: { content: a.name || "Unnamed" } }] },
        Course:   { rich_text: [{ text: { content: course.name || "" } }] },
        Type:     { select:    { name: assignmentType(a) } },
        Points:   { number:    a.points_possible ?? null },
        Status:   { select:    { name: "Not Started" } },
        Priority: { select:    { name: assignmentPriority(a.points_possible) } },
      };
      if (a.due_at) props["Due Date"] = { date: { start: a.due_at.replace("Z", "+00:00") } };
      return createDbEntry(secret, assignmentsDbId, props);
    });

    // ── 7. Course Notes section + pages ─────────────────────────────────────
    await appendBlocks(secret, hubId, [h2("📓  Notes by Course")]);
    const notesParentId = await createPage(secret, hubId, "📓 Course Notes", "📓", [
      callout("One page per course. Add lecture notes, study notes, and flashcards as you go.", "📚", "blue_background"),
    ]);

    await batchRun(courses, 3, 350, (course, i) => {
      // Find index of this course in the original array to get its assignments
      const idx = courses.indexOf(course);
      const blocks = courseNoteBlocks(course, assignmentsByCourse[idx] || [], domain);
      return createPage(secret, notesParentId, course.name || "Course", "📖", blocks);
    });

    // ── 8. Weekly Planner ────────────────────────────────────────────────────
    await appendBlocks(secret, hubId, [h2("🗓️  Weekly Planner")]);
    await createPage(secret, hubId, "🗓️ Weekly Planner", "🗓️", plannerBlocks(allAssignments));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        courseCount:    courses.length,
        assignmentCount: allAssignments.length,
        notionUrl: `https://notion.so/${hubId.replace(/-/g, "")}`,
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
