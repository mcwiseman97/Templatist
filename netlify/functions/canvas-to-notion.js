const https = require("https");

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

// Step 1: Validate Canvas token + domain by fetching the current user profile
async function validateCanvas(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/users/self`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (result.status === 401 || result.status === 403) {
    throw new Error("canvas_auth: Invalid Canvas API token.");
  }
  if (result.status !== 200) {
    throw new Error(`canvas_domain: Could not reach Canvas at "${domain}". Check the domain and try again.`);
  }
}

// Step 2: Validate Notion secret + page ID by retrieving the page
async function validateNotion(secret, pageId) {
  const result = await httpsRequest(
    `https://api.notion.com/v1/pages/${pageId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Notion-Version": "2022-06-28",
      },
    }
  );
  if (result.status === 401) {
    throw new Error("notion_auth: Invalid Notion integration secret.");
  }
  if (result.status === 404) {
    throw new Error("notion_page: Page not found. Check the Page ID and make sure your integration is shared with that page.");
  }
  if (result.status !== 200) {
    throw new Error(`notion_error: Unexpected Notion error (${result.status}).`);
  }
}

// Step 3: Fetch active Canvas courses
async function getCanvasCourses(domain, token) {
  const result = await httpsRequest(
    `https://${domain}/api/v1/courses?enrollment_state=active&per_page=100`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (result.status !== 200 || !Array.isArray(result.body)) {
    throw new Error("canvas_error: Failed to retrieve courses.");
  }
  return result.body;
}

// Step 4: Create the Notion database and populate with courses
async function createNotionDatabase(notionSecret, pageId, courses) {
  const gradeOptions = ["A", "B", "C", "D", "F", "Pending"].map((g) => ({ name: g }));
  const statusOptions = ["Active", "Completed", "Dropped"].map((s) => ({ name: s }));

  const dbResult = await httpsRequest(
    "https://api.notion.com/v1/databases",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionSecret}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
    },
    JSON.stringify({
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: "Semester Dashboard" } }],
      properties: {
        Name: { title: {} },
        "Course Code": { rich_text: {} },
        Status: { select: { options: statusOptions } },
        Grade: { select: { options: gradeOptions } },
        Credits: { number: { format: "number" } },
        Term: { rich_text: {} },
        Notes: { rich_text: {} },
      },
    })
  );

  if (dbResult.status !== 200) {
    throw new Error(`notion_error: Could not create database (${dbResult.status}).`);
  }

  const databaseId = dbResult.body.id;

  for (const course of courses) {
    await httpsRequest(
      "https://api.notion.com/v1/pages",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionSecret}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
      },
      JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          Name: { title: [{ text: { content: course.name || "Unnamed Course" } }] },
          "Course Code": { rich_text: [{ text: { content: course.course_code || "" } }] },
          Status: { select: { name: "Active" } },
        },
      })
    );
  }

  return databaseId;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const { canvasToken, canvasDomain, notionPageId, notionSecret } = body;

  if (!canvasToken || !canvasDomain || !notionPageId || !notionSecret) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "all_fields", message: "All four fields are required." }),
    };
  }

  const cleanDomain = canvasDomain.trim().replace(/^https?:\/\//, "");
  const cleanPageId = notionPageId.trim().replace(/-/g, "");
  const cleanToken = canvasToken.trim();
  const cleanSecret = notionSecret.trim();

  try {
    // Validate Canvas credentials first
    await validateCanvas(cleanDomain, cleanToken);

    // Validate Notion credentials second
    await validateNotion(cleanSecret, cleanPageId);

    // Both valid — fetch courses and build
    const courses = await getCanvasCourses(cleanDomain, cleanToken);
    const databaseId = await createNotionDatabase(cleanSecret, cleanPageId, courses);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        courseCount: courses.length,
        databaseId,
        notionUrl: `https://notion.so/${databaseId.replace(/-/g, "")}`,
      }),
    };
  } catch (err) {
    const msg = err.message || "";

    // Canvas errors
    if (msg.startsWith("canvas_auth")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "canvas_auth", message: msg.replace("canvas_auth: ", "") }) };
    }
    if (msg.startsWith("canvas_domain")) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas_domain", message: msg.replace("canvas_domain: ", "") }) };
    }
    if (msg.startsWith("canvas_error")) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "canvas", message: "Could not retrieve your Canvas courses." }) };
    }

    // Notion errors
    if (msg.startsWith("notion_auth")) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: "notion_auth", message: msg.replace("notion_auth: ", "") }) };
    }
    if (msg.startsWith("notion_page")) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: "notion_page", message: msg.replace("notion_page: ", "") }) };
    }
    if (msg.startsWith("notion_error")) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "notion", message: "Could not create your Notion database." }) };
    }

    return { statusCode: 500, headers, body: JSON.stringify({ error: "server", message: "An unexpected error occurred." }) };
  }
};
