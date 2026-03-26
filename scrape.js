import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);
const PER_COURSE_DELAY_MS = Number(process.env.PER_COURSE_DELAY_MS || 2500);
const DAYS_AHEAD = Number(process.env.DAYS_AHEAD || 7);
const COURSE_LIMIT = Number(process.env.COURSE_LIMIT || 50);
const COURSE_OFFSET = Number(process.env.COURSE_OFFSET || 0);
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);

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

function dedupeRows(rows) {
  const map = new Map();

  for (const row of rows) {
    const key = `${row.course_id}|${row.tee_time}|${row.date}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, row);
      continue;
    }

    const existingScore =
      (existing.price ? 1 : 0) +
      (existing.spots_available !== null && existing.spots_available !== undefined ? 1 : 0);

    const newScore =
      (row.price ? 1 : 0) +
      (row.spots_available !== null && row.spots_available !== undefined ? 1 : 0);

    if (newScore > existingScore) {
      map.set(key, row);
    }
  }

  return Array.from(map.values());
}

function normaliseTime(raw) {
  if (!raw) return null;
  const value = raw.replace(/\s+/g, " ").trim().toUpperCase();
  const m = value.match(/^(\d{1,2}):(\d{2})(?:\s?(AM|PM))?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2];
  const meridiem = m[3] ? m[3].toUpperCase() : null;

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  return `${String(hour).padStart(2, "0")}:${minute}`;
}

function normalisePrice(raw) {
  if (!raw) return null;
  const match = raw.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
  return match ? match[0].replace(/\s+/g, "") : null;
}

function parseSpots(raw) {
  if (!raw) return null;
  const match = raw.match(/\b([1-4])\s+(?:spots|players|balls?)\b/i);
  return match ? Number(match[1]) : null;
}

async function shouldScrapeDate(courseId, date) {
  const { data, error } = await supabase
    .from("tee_times")
    .select("scraped_at")
    .eq("course_id", courseId)
    .eq("date", date)
    .order("scraped_at", { ascending: false })
    .limit(1);

  if (error) {
    console.error(`Cache check failed for ${courseId} ${date}: ${error.message}`);
    return true;
  }

  if (!data || data.length === 0) return true;

  const lastScraped = new Date(data[0].scraped_at);
  const now = new Date();
  const hoursOld = (now - lastScraped) / (1000 * 60 * 60);

  return hoursOld > CACHE_HOURS;
}

async function extractByDom(page) {
  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll("*"));

    for (const node of nodes) {
      const text = (node.innerText || "").trim();
      if (!text) continue;
      if (text.length > 200) continue;

      const timeMatch = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
      if (!timeMatch) continue;

      const priceMatch = text.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
      const spotsMatch = text.match(/\b([1-4])\s+(?:spots|players|balls?)\b/i);

      if (!priceMatch && !spotsMatch) continue;

      const key = `${timeMatch[0]}|${priceMatch ? priceMatch[0] : ""}|${spotsMatch ? spotsMatch[1] : ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time_raw: timeMatch[0],
        price_raw: priceMatch ? priceMatch[0] : null,
        spots_raw: spotsMatch ? spotsMatch[0] : null,
        raw: text
      });
    }

    return rows;
  });
}

function tryParseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function walkJson(value, rows = []) {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, rows);
    return rows;
  }

  if (!value || typeof value !== "object") return rows;

  const obj = value;

  const possibleTime =
    obj.tee_time ||
    obj.teeTime ||
    obj.time ||
    obj.startTime ||
    obj.start_time ||
    obj.displayTime ||
    obj.slot_time;

  const possiblePrice =
    obj.price ||
    obj.cost ||
    obj.green_fee ||
    obj.greenFee ||
    obj.amount ||
    obj.rate;

  const possibleSpots =
    obj.spots_available ||
    obj.spotsAvailable ||
    obj.available_spots ||
    obj.availableSpots ||
    obj.players ||
    obj.spaces;

  if (possibleTime) {
    rows.push({
      tee_time_raw: String(possibleTime),
      price_raw: possiblePrice != null ? String(possiblePrice) : null,
      spots_raw: possibleSpots != null ? String(possibleSpots) : null,
      raw_json: obj
    });
  }

  for (const key of Object.keys(obj)) {
    walkJson(obj[key], rows);
  }

  return rows;
}

async function extractFromCapturedResponses(page) {
  const captured = page.__capturedResponses || [];
  const rows = [];

  for (const item of captured) {
    const parsed = tryParseJsonText(item.body);
    if (!parsed) continue;

    const found = walkJson(parsed);
    for (const row of found) {
      rows.push({
        ...row,
        response_url: item.url
      });
    }
  }

  return rows;
}

function normaliseExtractedRows(rawRows) {
  const out = [];

  for (const row of rawRows) {
    const teeTime = normaliseTime(row.tee_time_raw);
    if (!teeTime) continue;

    let price = normalisePrice(row.price_raw || "");
    let spotsAvailable = parseSpots(row.spots_raw || "");

    if (!price && row.price_raw && /^[0-9]+(?:\.[0-9]{1,2})?$/.test(String(row.price_raw).trim())) {
      price = `£${String(row.price_raw).trim()}`;
    }

    if (
      (spotsAvailable === null || spotsAvailable === undefined) &&
      row.spots_raw &&
      /^[1-4]$/.test(String(row.spots_raw).trim())
    ) {
      spotsAvailable = Number(String(row.spots_raw).trim());
    }

    out.push({
      tee_time: teeTime,
      price,
      spots_available: spotsAvailable ?? null,
      raw_payload: row
    });
  }

  return out;
}

async function setDateIfPresent(page, date) {
  const selectors = [
    'input[type="date"]',
    'input[name*="date" i]',
    'input[id*="date" i]',
    '[placeholder*="date" i]'
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      try {
        await locator.fill(date, { timeout: 1500 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(2500);
        return true;
      } catch {}
    }
  }

  return false;
}

function buildDateUrl(url, provider, date) {
  if (provider === "clubv1") {
    if (url.includes("date=")) {
      return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
    }
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}date=${date}`;
  }

  return url;
}

async function scrapeBRS(page, date) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
  await setDateIfPresent(page, date);

  const responseRows = await extractFromCapturedResponses(page);
  const domRows = await extractByDom(page);

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeIntelligentGolf(page, date) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3500);
  await setDateIfPresent(page, date);

  const responseRows = await extractFromCapturedResponses(page);
  const domRows = await extractByDom(page);

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeClubV1(page, date) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
  await setDateIfPresent(page, date);

  const responseRows = await extractFromCapturedResponses(page);
  const domRows = await extractByDom(page);

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeGeneric(page, date) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3000);
  await setDateIfPresent(page, date);

  const responseRows = await extractFromCapturedResponses(page);
  const domRows = await extractByDom(page);

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeCourseDate(browser, course, date) {
  const page = await browser.newPage();
  const provider = detectProvider(course.tee_sheet_url);
  const targetUrl = buildDateUrl(course.tee_sheet_url, provider, date);

  page.__capturedResponses = [];

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";

      if (
        contentType.includes("application/json") ||
        /api|times|teetime|tee-time|booking|availability/i.test(url)
      ) {
        const body = await response.text();
        page.__capturedResponses.push({ url, body });
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    let rows = [];

    if (provider === "brs") {
      rows = await scrapeBRS(page, date);
    } else if (provider === "intelligentgolf") {
      rows = await scrapeIntelligentGolf(page, date);
    } else if (provider === "clubv1") {
      rows = await scrapeClubV1(page, date);
    } else {
      rows = await scrapeGeneric(page, date);
    }

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
      raw_payload: row.raw_payload
    }));
  } catch (err) {
    console.error(`Failed ${course.name} ${date}: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

async function upsertRows(rows) {
  if (!rows.length) return;

  const deduped = dedupeRows(rows);

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
  const { error } = await supabase
    .from("golf_courses")
    .update({ last_scraped: new Date().toISOString() })
    .eq("id", courseId);

  if (error) {
    console.error("markCourseScraped error:", error.message);
  }
}

async function processCourse(browser, course, dates) {
  const allRows = [];

  for (const date of dates) {
    const shouldScrape = await shouldScrapeDate(course.id, date);

    if (!shouldScrape) {
      console.log(`Skipping ${course.name} ${date} (fresh cache)`);
      continue;
    }

    const rows = await scrapeCourseDate(browser, course, date);
    if (rows.length) allRows.push(...rows);

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
  const from = COURSE_OFFSET;
  const to = COURSE_OFFSET + COURSE_LIMIT - 1;

  const { data, error } = await supabase
    .from("golf_courses")
    .select("id,name,tee_sheet_url")
    .order("created_at")
    .range(from, to);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(`Loaded ${data.length} courses (offset ${COURSE_OFFSET}, limit ${COURSE_LIMIT})`);
  return data;
}

async function main() {
  const dates = nextDates(DAYS_AHEAD);
  const courses = await fetchCourses();
  const batches = chunk(courses, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map((batch, idx) => runWorker(batch, dates, i + idx + 1))
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
