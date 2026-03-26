import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const PER_COURSE_DELAY_MS = Number(process.env.PER_COURSE_DELAY_MS || 4000);
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 7);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextDates(days) {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function chunk(array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  );
}

function detectProvider(url) {
  const u = (url || "").toLowerCase();

  if (u.includes("brsgolf")) return "brs";
  if (u.includes("intelligentgolf")) return "intelligentgolf";
  if (u.includes("clubv1")) return "clubv1";

  return "generic";
}

function normalisePrice(text) {
  const match = text.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

function normaliseTime(text) {
  const match = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
  return match ? match[0].toUpperCase() : null;
}

function normaliseSpots(text) {
  const match = text.match(/\b([1-4])\s+(?:spots|players|balls?)\b/i);
  return match ? Number(match[1]) : null;
}

async function extractByDom(page) {
  return await page.evaluate(() => {
    const seen = new Set();
    const rows = [];

    const nodes = Array.from(document.querySelectorAll("*"));

    for (const node of nodes) {
      const text = (node.innerText || "").trim();
      if (!text) continue;

      const timeMatch = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
      if (!timeMatch) continue;

      const priceMatch = text.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
      const spotsMatch = text.match(/\b([1-4])\s+(?:spots|players|balls?)\b/i);

      const key = `${timeMatch[0]}|${priceMatch ? priceMatch[0] : ""}|${spotsMatch ? spotsMatch[1] : ""}`;

      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time: timeMatch[0].toUpperCase(),
        price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : null,
        spots_available: spotsMatch ? Number(spotsMatch[1]) : null,
        raw: text
      });
    }

    return rows;
  });
}

async function scrapeCourseDate(browser, course, date) {
  const page = await browser.newPage();
  const provider = detectProvider(course.tee_sheet_url);

  try {
    await page.goto(course.tee_sheet_url, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForTimeout(3000);

    const rows = await extractByDom(page);

    return rows.map((row) => ({
      course_id: course.id,
      course_name: course.name,
      tee_sheet_url: course.tee_sheet_url,
      tee_time: row.tee_time,
      price: row.price,
      spots_available: row.spots_available,
      date,
      scraped_at: new Date().toISOString(),
      source_provider: provider,
      raw_payload: row
    }));
  } catch (err) {
    console.error(`Failed ${course.name} ${date}`, err.message);
    return [];
  } finally {
    await page.close();
  }
}

async function upsertRows(rows) {
  if (!rows.length) return;

  const map = new Map();

  for (const row of rows) {
    const key = `${row.course_name}-${row.tee_time}-${row.date}`;
    if (!map.has(key)) map.set(key, row);
  }

  const deduped = Array.from(map.values());

  const { error } = await supabase
    .from("tee_times")
    .upsert(deduped, {
      onConflict: "course_name,tee_time,date"
    });

  if (error) {
    console.error("Upsert error:", error);
  }
}

async function markCourseScraped(courseId) {
  await supabase
    .from("golf_courses")
    .update({ last_scraped: new Date().toISOString() })
    .eq("id", courseId);
}

async function processCourse(browser, course, dates) {
  let allRows = [];

  for (const date of dates) {
    const rows = await scrapeCourseDate(browser, course, date);

    if (rows.length) {
      allRows.push(...rows);
    }

    await sleep(1000);
  }

  await upsertRows(allRows);
  await markCourseScraped(course.id);

  console.log(`${course.name}: ${allRows.length} rows`);

  await sleep(PER_COURSE_DELAY_MS);
}

async function runWorker(courses, dates, workerId) {
  const browser = await chromium.launch({ headless: true });

  try {
    for (const course of courses) {
      console.log(`[worker ${workerId}] ${course.name}`);
      await processCourse(browser, course, dates);
    }
  } finally {
    await browser.close();
  }
}

async function fetchCourses() {
  const { data, error } = await supabase
    .from("golf_courses")
    .select("id,name,tee_sheet_url")
    .order("created_at");

  if (error) {
    console.error(error);
    process.exit(1);
  }

  return data;
}

async function main() {
  const dates = nextDates(DAYS_AHEAD);

  const courses = await fetchCourses();

  const batches = chunk(courses, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);

    await Promise.all(
      slice.map((batch, idx) =>
        runWorker(batch, dates, i + idx + 1)
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
