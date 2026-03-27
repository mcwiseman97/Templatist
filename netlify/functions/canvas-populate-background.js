/**
 * Stage 2 (Background Function) — called server-side by canvas-to-notion.js.
 * Fetches ALL semester assignments and builds:
 *   • Full Assignment Tracker + Exams & Quizzes databases
 *   • Per-course note pages under Classes
 *   • Per-week planner pages (full semester) under Week Plan
 *   • Daily planner pages (Mon–Fri × 4 weeks) under Daily Planners
 *   • Study Room, Graduation Path, and Notes page content
 */

const https = require("https");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function batchRun(items, size, delay, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...await Promise.all(items.slice(i, i + size).map(fn)));
    if (i + size < items.length) await sleep(delay);
  }
  return results;
}

// ─── Notion helpers ───────────────────────────────────────────────────────────

function nh(secret) {
  return { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" };
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
    if (i + 100 < blocks.length) await sleep(400);
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

const rt     = (t) => [{ type: "text", text: { content: String(t) } }];
const h2     = (t) => ({ object: "block", type: "heading_2",          heading_2:          { rich_text: rt(t) } });
const h3     = (t) => ({ object: "block", type: "heading_3",          heading_3:          { rich_text: rt(t) } });
const p      = (t) => ({ object: "block", type: "paragraph",          paragraph:          { rich_text: rt(t) } });
const div    = ()  => ({ object: "block", type: "divider",            divider:            {} });
const todo   = (t, done = false) => ({ object: "block", type: "to_do",              to_do:              { rich_text: rt(t), checked: done } });
const bullet = (t) => ({ object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(t) } });
const num    = (t) => ({ object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: rt(t) } });
const callout = (t, emoji, color = "purple_background") => ({
  object: "block", type: "callout",
  callout: { rich_text: rt(t), icon: { type: "emoji", emoji }, color },
});
const toggle = (t, children = []) => ({
  object: "block", type: "toggle",
  toggle: { rich_text: rt(t), children },
});

// ─── Canvas helpers ───────────────────────────────────────────────────────────

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

function priority(pts) {
  if (pts == null) return "Medium";
  if (pts >= 100)  return "High";
  if (pts >= 50)   return "Medium";
  return "Low";
}

function shortDate(iso) {
  if (!iso) return "No date";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

// ─── Semester weeks ───────────────────────────────────────────────────────────

function getSemesterWeeks(courses) {
  let start = null, end = null;
  for (const c of courses) {
    if (c.term_start) { const d = new Date(c.term_start); if (!start || d < start) start = d; }
    if (c.term_end)   { const d = new Date(c.term_end);   if (!end   || d > end)   end   = d; }
  }
  if (!start) { start = new Date(); start.setDate(start.getDate() - start.getDay()); }
  if (!end)   { end = new Date(start.getTime() + 17 * 7 * 24 * 60 * 60 * 1000); }

  const sun = new Date(start);
  sun.setDate(start.getDate() - start.getDay());
  sun.setHours(0, 0, 0, 0);

  const weeks = [];
  let cur = new Date(sun), n = 1;
  while (cur <= end) { weeks.push({ sunday: new Date(cur), weekNum: n++ }); cur.setDate(cur.getDate() + 7); }
  return weeks;
}

function weekRange(sunday) {
  const sat = new Date(sunday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(sunday)} – ${fmt(sat)}`;
}

function dayLabel(sunday, offset) {
  const d = new Date(sunday.getTime() + offset * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function assignmentsForWeek(all, sunday) {
  const end = new Date(sunday.getTime() + 7 * 24 * 60 * 60 * 1000);
  return all.filter(({ assignment: a }) => {
    if (!a.due_at) return false;
    const d = new Date(a.due_at);
    return d >= sunday && d < end;
  });
}

// ─── Template builders ────────────────────────────────────────────────────────

function weekPageBlocks(weekNum, sunday, weekAssignments) {
  const dayItems = (offset) =>
    weekAssignments
      .filter(({ assignment: a }) => a.due_at && new Date(a.due_at).getDay() === offset)
      .map(({ course: c, assignment: a }) => todo(`${a.name}  ·  ${c.name}`));

  return [
    callout(`Week ${weekNum}  ·  ${weekRange(sunday)}`, "📅", "gray_background"),
    div(),

    h2("📋  Assignments Due"),
    ...(weekAssignments.length === 0
      ? [callout("No assignments due — enjoy the breather! 🎉", "✅", "green_background")]
      : weekAssignments.map(({ course: c, assignment: a }) =>
          todo(`${a.name}  ·  ${c.name}  ·  ${shortDate(a.due_at)}${a.points_possible != null ? "  (" + a.points_possible + " pts)" : ""}`)
        )
    ),
    div(),

    h2("📅  Daily Plan"),
    h3(`Monday  ·  ${dayLabel(sunday, 1)}`),
    ...dayItems(1), todo(" "), todo(" "),
    h3(`Tuesday  ·  ${dayLabel(sunday, 2)}`),
    ...dayItems(2), todo(" "), todo(" "),
    h3(`Wednesday  ·  ${dayLabel(sunday, 3)}`),
    ...dayItems(3), todo(" "), todo(" "),
    h3(`Thursday  ·  ${dayLabel(sunday, 4)}`),
    ...dayItems(4), todo(" "), todo(" "),
    h3(`Friday  ·  ${dayLabel(sunday, 5)}`),
    ...dayItems(5), todo(" "), todo(" "),
    div(),

    h2("🎯  Study Goals"),
    todo(" "), todo(" "), todo(" "),
    div(),

    h2("🪞  Weekly Reflection"),
    p("What did I accomplish this week?"),
    bullet(" "), bullet(" "),
    p("What do I need to carry into next week?"),
    bullet(" "), bullet(" "),
    p("Wins this week 🏆"),
    bullet(" "),
  ];
}

function dailyPlannerBlocks(dateLabel) {
  return [
    callout(dateLabel, "📆", "blue_background"),
    div(),
    h2("🌅  Morning Intentions"),
    p("Top 3 priorities for today:"),
    todo(" "), todo(" "), todo(" "),
    div(),
    h2("📚  Class & Study Blocks"),
    h3("Morning"),
    todo(" "), todo(" "),
    h3("Afternoon"),
    todo(" "), todo(" "),
    h3("Evening"),
    todo(" "), todo(" "),
    div(),
    h2("📝  Notes & To-Dos"),
    bullet(" "), bullet(" "), bullet(" "),
    div(),
    h2("🌙  End of Day"),
    p("What did I complete today?"),
    bullet(" "), bullet(" "),
    p("What carries over to tomorrow?"),
    bullet(" "),
  ];
}

function courseNoteBlocks(course, assignments, domain) {
  const canvasUrl = `https://${domain}/courses/${course.id}`;
  return [
    callout(`${course.course_code || ""}  •  ${course.instructor || "—"}  •  ${course.term_name || "—"}`, "📌", "blue_background"),
    div(),

    h2("📋  All Assignments"),
    ...(assignments.length === 0
      ? [p("No assignments found — check Canvas directly.")]
      : assignments.map((a) =>
          todo(`${a.name}  ·  ${shortDate(a.due_at)}${a.points_possible != null ? "  (" + a.points_possible + " pts)" : ""}`)
        )
    ),
    div(),

    h2("📖  Lecture Notes"),
    p("Add a toggle for each class session or week."),
    toggle("Week 1", [p("Notes from class...")]),
    toggle("Week 2", [p("Notes from class...")]),
    toggle("Week 3", [p("Notes from class...")]),
    toggle("Week 4", [p("Notes from class...")]),
    toggle("Week 5", [p("Notes from class...")]),
    toggle("Week 6", [p("Notes from class...")]),
    toggle("Week 7", [p("Notes from class...")]),
    toggle("Week 8", [p("Notes from class...")]),
    div(),

    h2("✏️  Study Notes"),
    toggle("Chapter / Topic 1", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Chapter / Topic 2", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Chapter / Topic 3", [bullet(" "), bullet(" "), bullet(" ")]),
    div(),

    h2("🃏  Flashcards"),
    p("Term on the outside → Definition inside the toggle."),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    toggle("Term", [p("Definition")]),
    div(),

    h2("🎯  Exam Prep"),
    toggle("Midterm", [
      p("Topics:"), bullet(" "), bullet(" "),
      p("Things to review:"), bullet(" "), bullet(" "),
    ]),
    toggle("Final Exam", [
      p("Topics:"), bullet(" "), bullet(" "),
      p("Things to review:"), bullet(" "), bullet(" "),
    ]),
    div(),

    h2("🔗  Resources"),
    bullet(`Canvas: ${canvasUrl}`),
    bullet("Textbook: "),
    bullet("Slides / Notes: "),
    bullet("Office Hours: "),
  ];
}

function studyRoomBlocks() {
  return [
    callout("Plan your study sessions, track your focus, and build good study habits.", "📖", "purple_background"),
    div(),
    h2("🍅  Pomodoro Planner"),
    p("Use 25-minute focus blocks with 5-minute breaks. Mark each block when complete."),
    todo("🍅 Block 1  ·  Subject: ___"),
    todo("🍅 Block 2  ·  Subject: ___"),
    todo("🍅 Block 3  ·  Subject: ___"),
    todo("🍅 Block 4  ·  Subject: ___"),
    div(),
    h2("📅  Weekly Study Schedule"),
    p("Block out dedicated study time for each course."),
    toggle("Monday", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    toggle("Tuesday", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    toggle("Wednesday", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    toggle("Thursday", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    toggle("Friday", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    toggle("Weekend", [bullet("Course: "), bullet("Topic: "), bullet("Duration: ")]),
    div(),
    h2("📈  Study Habits Tracker"),
    todo("Review notes within 24 hours of class"),
    todo("Complete practice problems before exams"),
    todo("Use active recall (not just re-reading)"),
    todo("Teach concepts out loud to test understanding"),
    todo("Get 7–8 hours of sleep before exams"),
    div(),
    h2("💡  Study Tips"),
    bullet("Spaced repetition beats cramming every time"),
    bullet("Active recall > passive re-reading"),
    bullet("Break big tasks into 25-min focus blocks"),
    bullet("Study the hardest subjects when you're most alert"),
  ];
}

function graduationBlocks() {
  return [
    callout("Track your degree requirements and plan your path to graduation.", "🎓", "yellow_background"),
    div(),
    h2("📊  Credit Progress"),
    p("Total credits required:  ____    Credits completed:  ____    Credits remaining:  ____"),
    div(),
    h2("📋  Core Requirements"),
    toggle("General Education", [
      todo("English / Writing"),
      todo("Math"),
      todo("Science"),
      todo("Social Science"),
      todo("Humanities"),
      todo("Fine Arts"),
    ]),
    toggle("Major Requirements", [
      todo("Core Course 1"),
      todo("Core Course 2"),
      todo("Core Course 3"),
      todo("Core Course 4"),
      todo("Core Course 5"),
    ]),
    toggle("Electives", [
      todo(" "),
      todo(" "),
      todo(" "),
    ]),
    div(),
    h2("🗓️  Semester Planning"),
    toggle("Current Semester", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Next Semester",    [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Year 2",           [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Year 3",           [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Year 4",           [bullet(" "), bullet(" "), bullet(" ")]),
    div(),
    h2("🎯  Academic Goals"),
    todo("Target GPA this semester: ____"),
    todo("Cumulative GPA goal: ____"),
    todo("Internship / research / co-op plans"),
    todo("Graduate on time"),
  ];
}

function notesBlocks() {
  return [
    callout("A scratchpad for everything that doesn't fit elsewhere — ideas, reminders, to-dos.", "📓", "gray_background"),
    div(),
    h2("⚡  Quick Capture"),
    p("Dump thoughts here first, sort them later."),
    bullet(" "), bullet(" "), bullet(" "), bullet(" "),
    div(),
    h2("📌  Pinned Notes"),
    toggle("Important Dates", [bullet(" "), bullet(" "), bullet(" ")]),
    toggle("Login Info / Codes", [bullet(" "), bullet(" ")]),
    toggle("Professor Contact Info", [bullet(" "), bullet(" ")]),
    div(),
    h2("💭  Ideas & Reflections"),
    p("Things I want to explore, read, or think more about."),
    bullet(" "), bullet(" "), bullet(" "),
    div(),
    h2("✅  General To-Dos"),
    todo(" "), todo(" "), todo(" "), todo(" "), todo(" "),
  ];
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400 }; }

  const {
    canvasToken, canvasDomain, notionSecret,
    classesId, assignmentsDbId, examsDbId,
    weekPlanId, dailyPlannersId, studyRoomId, graduationId, notesId,
    courses,
  } = body;

  if (!canvasToken || !canvasDomain || !notionSecret || !courses?.length)
    return { statusCode: 400 };

  const domain = canvasDomain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const token  = canvasToken.trim();
  const secret = notionSecret.trim();

  try {
    // ── 1. Fetch ALL semester assignments in parallel ──────────────────────
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

    // ── 2. Populate Assignment Tracker DB ─────────────────────────────────
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

    // ── 3. Populate Exams & Quizzes DB ────────────────────────────────────
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

    // ── 4. Per-course note pages ──────────────────────────────────────────
    await batchRun(courses, 2, 450, (course, _i) => {
      const idx    = courses.indexOf(course);
      const blocks = courseNoteBlocks(course, assignmentsByCourse[idx] || [], domain);
      return createPage(secret, classesId, course.name || "Course", "📖", blocks); // icon only, no emoji in title
    });

    // ── 5. Per-week planner pages (full semester, sequential for correct order) ─
    const weeks = getSemesterWeeks(courses);
    for (const { sunday, weekNum } of weeks) {
      const weekAssignments = assignmentsForWeek(allAssignments, sunday);
      const blocks = weekPageBlocks(weekNum, sunday, weekAssignments);
      await createPage(secret, weekPlanId, `Week ${weekNum}  ·  ${weekRange(sunday)}`, "📅", blocks);
      await sleep(300);
    }

    // ── 6. Daily planner pages (next 20 weekdays, sequential for correct order) ─
    const weekdays = [];
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (weekdays.length < 20) {
      if (cursor.getDay() >= 1 && cursor.getDay() <= 5) {
        weekdays.push(new Date(cursor));
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const date of weekdays) {
      const label = date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      await createPage(secret, dailyPlannersId, label, "📆", dailyPlannerBlocks(label));
      await sleep(300);
    }

    // ── 7. Build out static section pages ────────────────────────────────
    await appendBlocks(secret, studyRoomId,  studyRoomBlocks());
    await sleep(400);
    await appendBlocks(secret, graduationId, graduationBlocks());
    await sleep(400);
    await appendBlocks(secret, notesId,      notesBlocks());

    return { statusCode: 200 };
  } catch (_err) {
    return { statusCode: 500 };
  }
};
