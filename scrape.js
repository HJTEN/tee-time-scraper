import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "5", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "2", 10);
const PER_COURSE_DELAY_MS = parseInt(process.env.PER_COURSE_DELAY_MS || "2000", 10);
const DAYS_AHEAD = parseInt(process.env.DAYS_AHEAD || "7", 10);
const COURSE_LIMIT = parseInt(process.env.COURSE_LIMIT || "0", 10);
const REGION_FILTER = process.env.REGION_FILTER
  ? process.env.REGION_FILTER.split(",").map((r) => r.trim())
  : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nextDates(daysAhead) {
  const dates = [];
  for (let i = 0; i < daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function upsertTeeTimes(rows) {
  const { error } = await supabase
    .from("tee_times")
    .upsert(rows, { onConflict: "course_id,date,tee_time" });
  if (error) throw error;
}

// --- BRS Golf ---
function parseBrsSlug(url) {
  const m = url.match(/brsgolf\.com\/([^/?#]+)/);
  if (!m) return null;
  const courseMatch = url.match(/#\/course\/(\d+)/);
  return { club: m[1], courseId: courseMatch ? courseMatch[1] : "1" };
}

async function scrapeBrsGolf(course, date) {
  const parsed = parseBrsSlug(course.tee_sheet_url);
  if (!parsed) return [];
  const { club, courseId } = parsed;

  const endpoints = [
    `https://visitors.brsgolf.com/${club}/json/visitor_slots?date=${date}&course_id=${courseId}`,
    `https://visitors.brsgolf.com/${club}/api/visitor_slots?date=${date}&course_id=${courseId}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", Referer: course.tee_sheet_url },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const slots = Array.isArray(data) ? data : (data.slots ?? data.data ?? []);
      if (!slots.length) continue;
      return slots.map((s) => ({
        course_id: course.id,
        date,
        tee_time: s.time ?? s.tee_time ?? s.slot_time ?? s.start_time,
        spots_available: s.available_slots ?? s.spaces ?? s.available ?? null,
        price: s.price ?? s.green_fee ?? null,
        source_provider: "brs",
        tee_sheet_url: course.tee_sheet_url,
      })).filter((r) => r.tee_time);
    } catch {
      // try next endpoint
    }
  }
  return [];
}

// --- Intelligent Golf ---
function parseIntelligentGolfHost(url) {
  const m = url.match(/^https?:\/\/([^.]+)\.intelligentgolf\.co\.uk/);
  return m ? m[1] : null;
}

async function scrapeIntelligentGolf(course, date) {
  const club = parseIntelligentGolfHost(course.tee_sheet_url);
  if (!club) return [];

  const endpoints = [
    `https://${club}.intelligentgolf.co.uk/booking/VisitorAPI/GetAvailability?date=${date}`,
    `https://${club}.intelligentgolf.co.uk/visitor/api/slots?date=${date}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", Referer: course.tee_sheet_url },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const slots = Array.isArray(data) ? data : (data.slots ?? data.teeSlots ?? data.data ?? []);
      if (!slots.length) continue;
      return slots.map((s) => ({
        course_id: course.id,
        date,
        tee_time: s.time ?? s.tee_time ?? s.startTime ?? s.slot_time,
        spots_available: s.available_slots ?? s.spaces ?? s.available ?? null,
        price: s.price ?? s.green_fee ?? s.greenFee ?? null,
        source_provider: "intelligentgolf",
        tee_sheet_url: course.tee_sheet_url,
      })).filter((r) => r.tee_time);
    } catch {
      // try next endpoint
    }
  }
  return [];
}

// --- ClubV1 ---
function parseClubV1Host(url) {
  const m = url.match(/^https?:\/\/([^.]+)\.hub\.clubv1\.com/);
  return m ? m[1] : null;
}

async function scrapeClubV1(course, date) {
  const club = parseClubV1Host(course.tee_sheet_url);
  if (!club) return [];

  const endpoints = [
    `https://${club}.hub.clubv1.com/api/TeeSheet?date=${date}`,
    `https://${club}.hub.clubv1.com/Visitors/TeeSheetData?date=${date}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", Referer: course.tee_sheet_url },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const slots = Array.isArray(data) ? data : (data.slots ?? data.teeSlots ?? data.data ?? []);
      if (!slots.length) continue;
      return slots.map((s) => ({
        course_id: course.id,
        date,
        tee_time: s.time ?? s.tee_time ?? s.startTime ?? s.TeeTime,
        spots_available: s.available_slots ?? s.spaces ?? s.AvailableSpaces ?? null,
        price: s.price ?? s.Price ?? null,
        source_provider: "clubv1",
        tee_sheet_url: course.tee_sheet_url,
      })).filter((r) => r.tee_time);
    } catch {
      // try next endpoint
    }
  }
  return [];
}

// --- Generic Playwright scraper ---
async function scrapeGeneric(browser, course, date) {
  const page = await browser.newPage();
  const collected = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (!response.headers()["content-type"]?.includes("application/json")) return;
    if (!/slot|tee|booking|avail/i.test(url)) return;
    try {
      const body = await response.json();
      const slots = Array.isArray(body) ? body : (body.slots ?? body.data ?? body.teeSlots ?? []);
      for (const s of slots) {
        const teeTime = s.time ?? s.tee_time ?? s.startTime ?? s.slot_time ?? s.TeeTime;
        if (teeTime) {
          collected.push({
            course_id: course.id,
            date,
            tee_time: teeTime,
            spots_available: s.available_slots ?? s.spaces ?? s.available ?? s.AvailableSpaces ?? null,
            price: s.price ?? s.green_fee ?? s.Price ?? null,
            source_provider: "generic",
            tee_sheet_url: course.tee_sheet_url,
          });
        }
      }
    } catch {
      // not valid JSON or unexpected shape
    }
  });

  try {
    const pageUrl = course.tee_sheet_url.replace(/date=[\d-]+/, `date=${date}`);
    await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30000 });
  } catch {
    // navigation timeout or error — return whatever was intercepted
  } finally {
    await page.close();
  }

  return collected;
}

async function scrapeCourseForDate(browser, course, date) {
  const url = course.tee_sheet_url;

  if (url.includes("brsgolf.com")) {
    const rows = await scrapeBrsGolf(course, date);
    if (rows.length) return rows;
  }

  if (url.includes("intelligentgolf.co.uk")) {
    const rows = await scrapeIntelligentGolf(course, date);
    if (rows.length) return rows;
  }

  if (url.includes("hub.clubv1.com")) {
    const rows = await scrapeClubV1(course, date);
    if (rows.length) return rows;
  }

  return scrapeGeneric(browser, course, date);
}

async function markCourseScraped(courseId) {
  const { error } = await supabase
    .from("golf_courses")
    .update({ last_scraped: new Date().toISOString() })
    .eq("id", courseId);
  if (error) throw error;
}

async function processCourse(browser, course, dates) {
  const collected = [];

  for (const date of dates) {
    const rows = await scrapeCourseForDate(browser, course, date);
    if (rows.length) collected.push(...rows);
    await sleep(1000);
  }

  if (collected.length) {
    await upsertTeeTimes(collected);
  }

  await markCourseScraped(course.id);
  console.log(`${course.name}: ${collected.length} rows upserted`);
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

function chunk(array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
    array.slice(i * size, i * size + size)
  );
}

async function fetchCourses() {
  let query = supabase
    .from("golf_courses")
    .select("id,name,tee_sheet_url,region")
    .order("created_at", { ascending: true });

  if (REGION_FILTER) {
    query = query.in("region", REGION_FILTER);
  }

  if (COURSE_LIMIT > 0) query = query.limit(COURSE_LIMIT);

  const { data, error } = await query;
  if (error) throw error;

  console.log(
    `Fetched ${data.length} courses${REGION_FILTER ? ` (region: ${REGION_FILTER.join(", ")})` : ""}`
  );
  return data;
}

async function main() {
  const dates = nextDates(DAYS_AHEAD);
  const courses = await fetchCourses();

  if (!courses.length) {
    console.log("No courses to scrape. Check REGION_FILTER and golf_courses.region values.");
    return;
  }

  const batches = chunk(courses, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map((batch, idx) => runWorker(batch, dates, i + idx + 1))
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
