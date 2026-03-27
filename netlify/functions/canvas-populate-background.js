/**
 * Stage 2 (Background Function) — receives the Hub shell IDs from Stage 1,
 * then fetches ALL semester assignments from Canvas and builds:
 *   • Full Assignment Tracker (all assignments, full semester)
 *   • Exams & Quizzes Tracker
 *   • Per-course Note pages (lecture notes, study notes, flashcards)
 *   • Per-week Planner pages for the full semester
 *
 * Netlify returns 202 immediately; this function runs up to 15 minutes.
 * Credentials are transmitted over HTTPS and never stored.
 */

const https = require("https");

// ─── HTTP ─────────────────────────────────────────────────────────────────────

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function batchRun(items, size, delay, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    results.push(...await Promise.all(batch.map(fn)));
    if (i + size < items.length) await sleep(delay);
  }
  return results;
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

// Find and update the placeholder "⏳ Building..." paragraph so it becomes
// a real sub-page link after we create the page.
async function findAndDeletePlaceholder(secret, parentId, text) {
  const r = await httpsRequest(`https://api.notion.com/v1/blocks/${parentId}/children`,
    { method: "GET", headers: nh(secret) });
  if (r.status !== 200 || !Array.isArray(r.body?.results)) return;
  const match = r.body.results.find(
    (b) => b.type === "paragraph" &&
      b.paragraph?.rich_text?.[0]?.text?.content?.includes(text)
  );
  if (match) {
    await httpsRequest(`https://api.notion.com/v1/blocks/${match.id}`,
      { method: "DELETE", headers: nh(secret) });
  }
}

async function createPage(secret, parentId, title, emoji, children = []) {
  const r = await nPost(secret, "pages", {
    parent: { page_id: parentId },
    icon: { type: "emoji", emoji },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } },
    children: children.slice(0, 100),
  });
  if (r.status !== 200) return null;
  const id = r.body.id;
  if (children.length > 100) await appendBlocks(secret, id, children.slice(100));
  return id;
}

async function createDbRow(secret, dbId, properties) {
  return nPost(secret, "pages", { parent: { database_id: dbId }, properties });
}

// ─── Block factories ──────────────────────────────────────────────────────────

const rt  = (t) => [{ type: "text", text: { content: String(t) } }];
const h2  = (t) => ({ object: "block", type: "heading_2", heading_2: { rich_text: rt(t) } });
const h3  = (t) => ({ object: "block", type: "heading_3", heading_3: { rich_text: rt(t) } });
const p   = (t) => ({ object: "block", type: "paragraph", paragraph: { rich_text: rt(t) } });
const div = ()  => ({ object: "block", type: "divider",   divider:   {} });
const todo     = (t, done = false) => ({ object: "block", type: "to_do",              to_do:              { rich_text: rt(t), checked: done } });
const bullet   = (t)               => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(t) } });
const callout  = (t, emoji, color = "purple_background") => ({
  object: "block", type: "callout",
  callout: { rich_text: rt(t), icon: { type: "emoji", emoji }, color },
});
const toggle = (t, children = []) => ({
  object: "block", type: "toggle",
  toggle: { rich_text: rt(t), children },
});

// ─── Canvas ───────────────────────────────────────────────────────────────────

async function getAllAssignments(domain, token, courseId) {
  const r = await httpsRequest(
    `https://${domain}/api/v1/courses/${courseId}/assignments?per_page=100&order_by=due_at`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } }
  );
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

// ─── Data transforms ──────────────────────────────────────────────────────────

function assignmentType(a) {
  const types = a.submission_types || [];
  if (types.includes("online_quiz")) return "Quiz";
  if (types.includes("discussion_topic")) return "Discussion";
  if (types.includes("external_tool")) return "Assignment";
  if (types.every((t) => t === "none") || types.length === 0) {
    if (/final|midterm/i.test(a.name || "")) return "Exam";
    if (/quiz/i.test(a.name || "")) return "Quiz";
    if (/lab/i.test(a.name || "")) return "Lab";
    if (/project/i.test(a.name || "")) return "Project";
    return "Other";
  }
  return "Assignment";
}

function isExam(a) {
  const t = assignmentType(a);
  return t === "Quiz" || t === "Exam";
}

function priority(points) {
  if (points == null) return "Medium";
  if (points >= 100) return "High";
  if (points >= 50)  return "Medium";
  return "Low";
}

function shortDate(iso) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function longDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

// ─── Semester week generation ─────────────────────────────────────────────────

function getSemesterWeeks(courses) {
  let start = null;
  let end   = null;

  for (const c of courses) {
    if (c.term_start) {
      const d = new Date(c.term_start);
      if (!start || d < start) start = d;
    }
    if (c.term_end) {
      const d = new Date(c.term_end);
      if (!end || d > end) end = d;
    }
  }

  if (!start) {
    start = new Date();
    start.setDate(start.getDate() - start.getDay()); // Back to Sunday
  }
  if (!end) {
    end = new Date(start.getTime() + 17 * 7 * 24 * 60 * 60 * 1000); // 17 weeks default
  }

  // Normalise start to the nearest Sunday
  const sunday = new Date(start);
  sunday.setDate(start.getDate() - start.getDay());
  sunday.setHours(0, 0, 0, 0);

  const weeks = [];
  let cur = new Date(sunday);
  let weekNum = 1;
  while (cur <= end) {
    weeks.push({ sunday: new Date(cur), weekNum });
    cur.setDate(cur.getDate() + 7);
    weekNum++;
  }
  return weeks;
}

function assignmentsForWeek(allAssignments, sunday) {
  const weekEnd = new Date(sunday.getTime() + 7 * 24 * 60 * 60 * 1000);
  return allAssignments.filter(({ assignment: a }) => {
    if (!a.due_at) return false;
    const d = new Date(a.due_at);
    return d >= sunday && d < weekEnd;
  });
}

function weekLabel(sunday) {
  const sat = new Date(sunday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(sunday)} – ${fmt(sat)}`;
}

function dayName(sunday, offset) {
  const d = new Date(sunday.getTime() + offset * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

// ─── Template builders ────────────────────────────────────────────────────────

function buildWeekPage(weekNum, sunday, weekAssignments) {
  const label = weekLabel(sunday);
  const dayAssignments = (day) =>
    weekAssignments.filter(({ assignment: a }) => {
      if (!a.due_at) return false;
      return new Date(a.due_at).getDay() === day;
    });

  const blocks = [
    callout(`Week ${weekNum}  •  ${label}`, "📅", "gray_background"),
    div(),

    // Assignments due this week
    h2("📋  Assignments Due This Week"),
    ...(weekAssignments.length === 0
      ? [callout("No assignments due this week.", "✅", "green_background")]
      : weekAssignments.map(({ course: c, assignment: a }) =>
          todo(`${a.name}  ·  ${c.name}  ·  ${shortDate(a.due_at)}${a.points_possible != null ? "  ·  " + a.points_possible + " pts" : ""}`)
        )
    ),
    div(),

    // Daily planning grid (Mon–Fri)
    h2("📅  Daily Plan"),
    h3(`Monday  ·  ${dayName(sunday, 1)}`),
    ...dayAssignments(1).map(({ assignment: a }) => todo(`${a.name}  ·  ${shortDate(a.due_at)}`)),
    todo(" "),
    todo(" "),

    h3(`Tuesday  ·  ${dayName(sunday, 2)}`),
    ...dayAssignments(2).map(({ assignment: a }) => todo(`${a.name}  ·  ${shortDate(a.due_at)}`)),
    todo(" "),
    todo(" "),

    h3(`Wednesday  ·  ${dayName(sunday, 3)}`),
    ...dayAssignments(3).map(({ assignment: a }) => todo(`${a.name}  ·  ${shortDate(a.due_at)}`)),
    todo(" "),
    todo(" "),

    h3(`Thursday  ·  ${dayName(sunday, 4)}`),
    ...dayAssignments(4).map(({ assignment: a }) => todo(`${a.name}  ·  ${shortDate(a.due_at)}`)),
    todo(" "),
    todo(" "),

    h3(`Friday  ·  ${dayName(sunday, 5)}`),
    ...dayAssignments(5).map(({ assignment: a }) => todo(`${a.name}  ·  ${shortDate(a.due_at)}`)),
    todo(" "),
    todo(" "),

    div(),

    // Study goals
    h2("🎯  Study Goals This Week"),
    todo(" "),
    todo(" "),
    todo(" "),
    div(),

    // Reflection
    h2("🪞  Weekly Reflection"),
    p("What did I accomplish this week?"),
    bullet(" "),
    bullet(" "),
    p("What do I still need to finish or carry into next week?"),
    bullet(" "),
    bullet(" "),
    p("Wins this week 🏆"),
    bullet(" "),
  ];

  return blocks;
}

function buildCourseNotePage(course, courseAssignments, domain) {
  const instructor = course.instructor || "—";
  const term       = course.term_name  || "—";
  const canvasUrl  = `https://${domain}/courses/${course.id}`;

  const blocks = [
    callout(`${course.course_code || ""}  •  ${instructor}  •  ${term}`, "📌", "blue_background"),
    div(),

    // All semester assignments as to-dos
    h2("📋  All Assignments This Semester"),
    ...(courseAssignments.length === 0
      ? [p("No assignments found — check Canvas directly.")]
      : courseAssignments.map((a) =>
          todo(
            `${a.name}  ·  ${shortDate(a.due_at)}${a.points_possible != null ? "  ·  " + a.points_possible + " pts" : ""}`
          )
        )
    ),
    div(),

    // Lecture notes with weekly toggle stubs
    h2("📖  Lecture Notes"),
    p("Add a new toggle for each class session. Keep these organized by date or topic."),
    toggle("Week 1  —  Notes", [p("Add your notes here...")]),
    toggle("Week 2  —  Notes", [p("Add your notes here...")]),
    toggle("Week 3  —  Notes", [p("Add your notes here...")]),
    toggle("Week 4  —  Notes", [p("Add your notes here...")]),
    toggle("Week 5  —  Notes", [p("Add your notes here...")]),
    toggle("Week 6  —  Notes", [p("Add your notes here...")]),
    toggle("Week 7  —  Notes", [p("Add your notes here...")]),
    toggle("Week 8  —  Notes", [p("Add your notes here...")]),
    div(),

    // Study notes
    h2("✏️  Study Notes & Summaries"),
    p("Key concepts, formulas, theorems, and definitions worth reviewing."),
    toggle("Chapter / Topic 1", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Chapter / Topic 2", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Chapter / Topic 3", [bullet(" "), bullet(" "), bullet(" ")]),
    div(),

    // Flashcards
    h2("🃏  Flashcards"),
    p("Term on the outside → Definition inside the toggle."),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    div(),

    // Exam prep
    h2("🎯  Exam Prep"),
    toggle("Midterm Prep", [
      p("Topics covered:"), bullet(" "), bullet(" "),
      p("Things to review:"), bullet(" "), bullet(" "),
      p("Practice problems:"), bullet(" "),
    ]),
    toggle("Final Exam Prep", [
      p("Topics covered:"), bullet(" "), bullet(" "),
      p("Things to review:"), bullet(" "), bullet(" "),
      p("Practice problems:"), bullet(" "),
    ]),
    div(),

    // Resources
    h2("🔗  Resources"),
    bullet(`Canvas: ${canvasUrl}`),
    bullet("Textbook: "),
    bullet("Slides / Drive: "),
    bullet("Office Hours: "),
  ];

  return blocks;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  // Background functions ignore the response body — Netlify sends 202 automatically.
  // We still return a value for local netlify dev compatibility.

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400 }; }

  const {
    canvasToken, canvasDomain, notionSecret,
    hubPageId, assignmentsDbId, examsDbId, courses,
  } = body;

  if (!canvasToken || !canvasDomain || !notionSecret || !hubPageId || !assignmentsDbId || !courses)
    return { statusCode: 400 };

  const domain = canvasDomain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token  = canvasToken.trim();
  const secret = notionSecret.trim();

  try {
    // ── 1. Fetch ALL semester assignments from Canvas in parallel ─────────────
    const assignmentsByCourse = await Promise.all(
      courses.map((c) => getAllAssignments(domain, token, c.id))
    );

    const allAssignments = [];
    courses.forEach((course, i) =>
      (assignmentsByCourse[i] || []).forEach((a) =>
        allAssignments.push({ course, assignment: a })
      )
    );
    allAssignments.sort((a, b) => {
      const da = a.assignment.due_at ? new Date(a.assignment.due_at) : Infinity;
      const db = b.assignment.due_at ? new Date(b.assignment.due_at) : Infinity;
      return da - db;
    });

    // ── 2. Populate Assignment Tracker DB ─────────────────────────────────────
    await batchRun(allAssignments, 3, 400, ({ course: c, assignment: a }) => {
      const props = {
        Name:     { title:     [{ text: { content: a.name || "Unnamed" } }] },
        Course:   { rich_text: [{ text: { content: c.name || "" } }] },
        Type:     { select:    { name: assignmentType(a) } },
        Points:   { number:    a.points_possible ?? null },
        Status:   { select:    { name: "Not Started" } },
        Priority: { select:    { name: priority(a.points_possible) } },
      };
      if (a.due_at) props["Due Date"] = { date: { start: a.due_at.replace("Z", "+00:00") } };
      return createDbRow(secret, assignmentsDbId, props);
    });

    // ── 3. Populate Exams & Quizzes DB ────────────────────────────────────────
    const exams = allAssignments.filter(({ assignment: a }) => isExam(a));
    await batchRun(exams, 3, 400, ({ course: c, assignment: a }) => {
      const props = {
        Name:   { title:     [{ text: { content: a.name || "Unnamed" } }] },
        Course: { rich_text: [{ text: { content: c.name || "" } }] },
        Type:   { select:    { name: assignmentType(a) === "Quiz" ? "Quiz" : "Midterm" } },
        Status: { select:    { name: "Upcoming" } },
      };
      if (a.due_at) props["Date"] = { date: { start: a.due_at.replace("Z", "+00:00") } };
      return createDbRow(secret, examsDbId, props);
    });

    // ── 4. Course Notes section ───────────────────────────────────────────────
    // Remove the "⏳ Building..." placeholder text for Course Notes
    await findAndDeletePlaceholder(secret, hubPageId, "Building your course note pages");

    const notesParentId = await createPage(secret, hubPageId, "📓 Course Notes", "📓", [
      callout("One dedicated workspace per course. Lecture notes, study summaries, flashcards, and exam prep — all in one place.", "📚", "blue_background"),
      div(),
    ]);

    await batchRun(courses, 2, 400, (course, _i) => {
      const idx = courses.indexOf(course);
      const blocks = buildCourseNotePage(course, assignmentsByCourse[idx] || [], domain);
      return createPage(secret, notesParentId, course.name || "Course", "📖", blocks);
    });

    // ── 5. Weekly Planner section ─────────────────────────────────────────────
    await findAndDeletePlaceholder(secret, hubPageId, "Building your full semester planner");

    const plannerParentId = await createPage(secret, hubPageId, "🗓️ Weekly Planner", "🗓️", [
      callout("One page per week for the full semester. Each week has your assignments, daily plan, study goals, and a reflection section.", "🗓️", "gray_background"),
      div(),
    ]);

    const weeks = getSemesterWeeks(courses);

    // Create week pages in batches of 2 (each page has ~60 blocks)
    await batchRun(weeks, 2, 500, ({ sunday, weekNum }) => {
      const weekAssignments = assignmentsForWeek(allAssignments, sunday);
      const blocks = buildWeekPage(weekNum, sunday, weekAssignments);
      const label  = weekLabel(sunday);
      return createPage(secret, plannerParentId, `Week ${weekNum}  ·  ${label}`, "📅", blocks);
    });

    return { statusCode: 200 };
  } catch (_err) {
    // Background functions log errors to Netlify's function logs
    return { statusCode: 500 };
  }
};
