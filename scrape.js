import fs from "fs";
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
const COURSE_LIMIT = Number(process.env.COURSE_LIMIT || 999); // was 50 — now process all by default
const COURSE_OFFSET = Number(process.env.COURSE_OFFSET || 0);
const CACHE_HOURS = Number(process.env.CACHE_HOURS || 24);

// ─── URL classification ───────────────────────────────────────────────────────

/**
 * URLs that are info/static pages with no live tee time widget.
 * Scraping these will always yield zero rows — skip them early.
 */
const STATIC_PAGE_PATTERNS = [
  /\/visitors\/?$/i,
  /\/visitors-and-green-fees\/?$/i,
  /\/visitors-green-fees\/?$/i,
  /\/green[_-]fees\/?$/i,
  /\/green_fees\/?$/i,
  /\/visitors\/green-fees\/?$/i,
  /\/visitors_and_societies\/?$/i,
  /\/visitors_societies\/?$/i,
  /\/visitors-golf\/?$/i,
  /\/visitors\/visitors-golf\/?$/i,
  /\/membership\/?$/i,
  /\/contact-us\/?$/i,
  /\/societies\/?$/i,
  /\/play-golf\/visitors\/?$/i,
  /\/golf\/visitors\/?$/i,
  /\/golf-enquiry\/?$/i,
  /\/golf_enquiry_form\/?$/i,
  /\/book-now\/?$/i,
  /\/last-chance/i,
  /elitelive\/login\.php/i,         // e-s-p.com login wall
  /\/news\.php/i,
  /warnerhotels\.co\.uk/i,
  /cutt\.ly\//i,                    // URL shorteners — unpredictable redirects
];

/**
 * Affiliate/aggregator URLs that don't host booking widgets themselves.
 * Golfscape pages are discovery pages, not tee sheet embeds.
 */
const AGGREGATOR_PATTERNS = [
  /golfscape\.com/i,
  /golfnow\.co\.uk/i,
  /back9solutions\.com/i,          // portal requires auth
  /digitickets\.co\.uk/i,          // event ticketing, not a tee sheet
  /cloud-reservations\.net/i,      // requires session
  /premiersoftware\.co\.uk/i,      // requires session/auth
  /golfgraffix\.com/i,             // clubnet portal — requires auth cookie
  /golfbook\.255it\.com/i,         // requires login
  /rsweb\.foxhills\.co\.uk/i,      // member portal
  /kal\.org\.uk/i,                 // council leisure — no tee data
  /telfordandwrekinleisure/i,
  /pyrfordlakes\.golfmanager\.com/i,
  /e-s-p\.com\/elitelive\/login/i,
];

function isStaticPage(url) {
  return STATIC_PAGE_PATTERNS.some((p) => p.test(url));
}

function isAggregatorPage(url) {
  return AGGREGATOR_PATTERNS.some((p) => p.test(url));
}

// ─── Provider detection ───────────────────────────────────────────────────────

function detectProvider(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("brsgolf")) return "brs";
  if (u.includes("intelligentgolf")) return "intelligentgolf";
  if (u.includes("clubv1")) return "clubv1";
  if (u.includes("teeitup")) return "teeitup";
  if (u.includes("golfnow")) return "golfnow";
  if (u.includes("golfmanager")) return "golfmanager";
  if (u.includes("back9solutions")) return "back9";
  if (u.includes("e-s-p.com/elitelive/book_date")) return "esp";
  if (u.includes("golfgraffix")) return "golfgraffix";
  return "generic";
}

// ─── Date URL injection ───────────────────────────────────────────────────────

function buildDateUrl(url, provider, date) {
  const joiner = url.includes("?") ? "&" : "?";

  switch (provider) {
    case "clubv1":
      // clubv1 uses ?date= or replaces existing date= param
      if (url.includes("date=")) {
        return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      }
      return `${url}${joiner}date=${date}`;

    case "brs":
      // BRS visitor booking pages take a date query param on some endpoints
      if (url.includes("visitor_home") || url.includes("visitor_menu") || url.includes("visitor_month")) {
        return `${url}${joiner}date=${date}`;
      }
      // Hash-based BRS URLs (#/course/1) — date set via DOM interaction below
      return url;

    case "intelligentgolf":
      // IntelligentGolf visitor booking pages accept ?date=
      if (url.includes("date=")) {
        return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      }
      return `${url}${joiner}date=${date}`;

    case "teeitup":
      // tee it up uses &date= in query string
      if (url.includes("date=")) {
        return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      }
      return `${url}${joiner}date=${date}`;

    case "esp":
      // e-s-p elitelive book_date pages accept date via form interaction
      return url;

    default:
      return url;
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

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

function dedupeRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.course_name}|${row.tee_time}|${row.date}`;
    const existing = map.get(key);
    if (!existing) { map.set(key, row); continue; }
    const score = (r) => (r.price ? 1 : 0) + (r.spots_available != null ? 1 : 0);
    if (score(row) > score(existing)) map.set(key, row);
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

function tryParseJsonText(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// ─── JSON walking ─────────────────────────────────────────────────────────────

function walkJson(value, rows = []) {
  if (Array.isArray(value)) { for (const item of value) walkJson(item, rows); return rows; }
  if (!value || typeof value !== "object") return rows;
  const obj = value;
  const possibleTime = obj.tee_time || obj.teeTime || obj.time || obj.startTime ||
    obj.start_time || obj.displayTime || obj.slot_time || obj.StartTime || obj.TeeTime;
  const possiblePrice = obj.price || obj.cost || obj.green_fee || obj.greenFee ||
    obj.amount || obj.rate || obj.Price || obj.GreenFee || obj.totalPrice || obj.total_price;
  const possibleSpots = obj.spots_available || obj.spotsAvailable || obj.available_spots ||
    obj.availableSpots || obj.players || obj.spaces || obj.availableSlots || obj.slots;

  if (possibleTime) {
    rows.push({
      tee_time_raw: String(possibleTime),
      price_raw: possiblePrice != null ? String(possiblePrice) : null,
      spots_raw: possibleSpots != null ? String(possibleSpots) : null,
      raw_json: obj,
    });
  }
  for (const key of Object.keys(obj)) walkJson(obj[key], rows);
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
    if (spotsAvailable == null && row.spots_raw && /^[1-4]$/.test(String(row.spots_raw).trim())) {
      spotsAvailable = Number(String(row.spots_raw).trim());
    }
    out.push({ tee_time: teeTime, price, spots_available: spotsAvailable ?? null, raw_payload: row });
  }
  return out;
}

// ─── DOM extraction ───────────────────────────────────────────────────────────

async function extractByDom(page) {
  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const nodes = Array.from(document.querySelectorAll("*"));
    for (const node of nodes) {
      const text = (node.innerText || "").trim();
      if (!text || text.length > 200) continue;
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
        raw: text,
      });
    }
    return rows;
  });
}

async function extractFromCapturedResponses(page) {
  const captured = page.__capturedResponses || [];
  const rows = [];
  for (const item of captured) {
    const parsed = tryParseJsonText(item.body);
    if (!parsed) continue;
    const found = walkJson(parsed);
    for (const row of found) rows.push({ ...row, response_url: item.url });
  }
  return rows;
}

// ─── Date picker interaction ──────────────────────────────────────────────────

async function setDateIfPresent(page, date) {
  const selectors = [
    'input[type="date"]',
    'input[name*="date" i]',
    'input[id*="date" i]',
    '[placeholder*="date" i]',
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

// ─── Provider-specific date navigation ───────────────────────────────────────

/**
 * For BRS hash-based pages, try clicking the date in the calendar widget.
 */
async function setBrsDate(page, date) {
  try {
    // BRS renders a date picker — try clicking the target date cell
    const [year, month, day] = date.split("-").map(Number);
    const dayStr = String(day);

    // Wait for calendar to be present
    await page.waitForSelector(".fc-day, .brs-date-cell, [data-date]", { timeout: 5000 }).catch(() => {});

    // Try data-date attribute approach
    const dateCell = page.locator(`[data-date="${date}"]`).first();
    if (await dateCell.count()) {
      await dateCell.click({ timeout: 2000 });
      await page.waitForTimeout(2000);
      return true;
    }
  } catch {}
  return false;
}

/**
 * For ESP elitelive book_date pages, fill the date form field.
 */
async function setEspDate(page, date) {
  try {
    await page.waitForSelector('input[name="play_date"], input[name="date"], select[name="play_date"]', { timeout: 5000 });
    const input = page.locator('input[name="play_date"], input[name="date"]').first();
    if (await input.count()) {
      // ESP uses DD/MM/YYYY format
      const [y, m, d] = date.split("-");
      await input.fill(`${d}/${m}/${y}`);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(2500);
      return true;
    }
  } catch {}
  return false;
}

// ─── Provider-aware wait times ────────────────────────────────────────────────

const PROVIDER_WAIT_MS = {
  brs: 4000,
  intelligentgolf: 4500,
  clubv1: 3500,
  teeitup: 3000,
  esp: 4000,
  golfmanager: 3500,
  generic: 3000,
};

// ─── Main scrape orchestration ────────────────────────────────────────────────

async function scrapeProvider(page, provider, date) {
  await page.waitForLoadState("domcontentloaded");
  const waitMs = PROVIDER_WAIT_MS[provider] || 3000;
  await page.waitForTimeout(waitMs);

  // Provider-specific date interaction
  if (provider === "brs") {
    await setBrsDate(page, date);
  } else if (provider === "esp") {
    await setEspDate(page, date);
  } else {
    await setDateIfPresent(page, date);
  }

  // Extra settle time after date interaction
  await page.waitForTimeout(1500);

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
        /api|times|teetime|tee-time|booking|availability|slots|schedule/i.test(url)
      ) {
        const body = await response.text();
        page.__capturedResponses.push({ url, body });
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const rows = await scrapeProvider(page, provider, date);
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
      raw_payload: row.raw_payload,
    }));
  } catch (err) {
    console.error(`Failed ${course.name} ${date}: ${err.message}`);
    return [];
  } finally {
    await page.close();
  }
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function ensureGolfCourse(course) {
  const { data: existing, error: readError } = await supabase
    .from("golf_courses")
    .select("id,name,tee_sheet_url,last_scraped")
    .eq("name", course.name)
    .eq("tee_sheet_url", course.tee_sheet_url)
    .limit(1);
  if (readError) throw readError;
  if (existing && existing.length > 0) return existing[0];
  const { data: inserted, error: insertError } = await supabase
    .from("golf_courses")
    .insert({ name: course.name, tee_sheet_url: course.tee_sheet_url })
    .select("id,name,tee_sheet_url,last_scraped")
    .single();
  if (insertError) throw insertError;
  return inserted;
}

async function shouldScrapeDate(courseId, date) {
  const { data, error } = await supabase
    .from("tee_times")
    .select("scraped_at")
    .eq("course_id", courseId)
    .eq("date", date)
    .order("scraped_at", { ascending: false })
    .limit(1);
  if (error) { console.error(`Cache check failed for ${courseId} ${date}:`, error.message); return true; }
  if (!data || data.length === 0) return true;
  const hoursOld = (new Date() - new Date(data[0].scraped_at)) / (1000 * 60 * 60);
  return hoursOld > CACHE_HOURS;
}

async function upsertRows(rows) {
  if (!rows.length) return;
  const deduped = dedupeRows(rows);
  const { error } = await supabase
    .from("tee_times")
    .upsert(deduped, { onConflict: "course_name,tee_time,date" });
  if (error) console.error("Upsert error:", error);
}

async function markCourseScraped(courseId) {
  const { error } = await supabase
    .from("golf_courses")
    .update({ last_scraped: new Date().toISOString() })
    .eq("id", courseId);
  if (error) console.error("markCourseScraped error:", error.message);
}

// ─── Course loading & classification ─────────────────────────────────────────

function loadCoursesFromJson() {
  const raw = JSON.parse(fs.readFileSync("./clubs.json", "utf8"));

  const skippedStatic = [];
  const skippedAggregator = [];
  const courses = [];

  for (const [index, row] of raw.entries()) {
    const name = (row["Club name"] || "").trim();
    const url = (row["Booking URL"] || "").trim();

    if (!name || !url || url === "N/A") continue;

    if (isStaticPage(url)) {
      skippedStatic.push(name);
      continue;
    }

    if (isAggregatorPage(url)) {
      skippedAggregator.push(name);
      continue;
    }

    courses.push({ source_index: index, name, tee_sheet_url: url });
  }

  console.log(`\n── URL classification ──────────────────────────────────`);
  console.log(`  Total entries:        ${raw.length}`);
  console.log(`  Scrapeable:           ${courses.length}`);
  console.log(`  Skipped (static):     ${skippedStatic.length}`);
  console.log(`  Skipped (aggregator): ${skippedAggregator.length}`);
  console.log(`────────────────────────────────────────────────────────\n`);

  if (skippedStatic.length) {
    console.log("Static page skips (need real booking URL):");
    skippedStatic.forEach((n) => console.log(`  ✗ ${n}`));
    console.log();
  }

  if (skippedAggregator.length) {
    console.log("Aggregator/auth-wall skips (need direct tee sheet URL):");
    skippedAggregator.forEach((n) => console.log(`  ✗ ${n}`));
    console.log();
  }

  const sliced = courses.slice(COURSE_OFFSET, COURSE_OFFSET + COURSE_LIMIT);
  console.log(`Processing ${sliced.length} courses (offset ${COURSE_OFFSET}, limit ${COURSE_LIMIT})\n`);
  return sliced;
}

// ─── Per-course processing ────────────────────────────────────────────────────

async function processCourse(browser, rawCourse, dates) {
  let course;
  try {
    course = await ensureGolfCourse(rawCourse);
  } catch (err) {
    console.error(`Failed to ensure golf_course for ${rawCourse.name}: ${err.message}`);
    return;
  }

  const allRows = [];

  for (const date of dates) {
    const shouldScrape = await shouldScrapeDate(course.id, date);
    if (!shouldScrape) {
      console.log(`  Skipping ${course.name} ${date} (fresh cache)`);
      continue;
    }
    const rows = await scrapeCourseDate(browser, course, date);
    if (rows.length) allRows.push(...rows);
    await sleep(1000);
  }

  await upsertRows(allRows);
  await markCourseScraped(course.id);

  const provider = detectProvider(rawCourse.tee_sheet_url);
  const status = allRows.length > 0 ? "✓" : "✗";
  console.log(`${status} ${course.name} [${provider}]: ${allRows.length} rows`);

  await sleep(PER_COURSE_DELAY_MS);
}

// ─── Worker & main ────────────────────────────────────────────────────────────

async function runWorker(courses, dates, workerId) {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const course of courses) {
      await processCourse(browser, course, dates);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  const dates = nextDates(DAYS_AHEAD);
  const courses = loadCoursesFromJson();
  const batches = chunk(courses, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map((batch, idx) => runWorker(batch, dates, i + idx + 1))
    );
  }

  console.log("\n── Run complete ──────────────────────────────────────────");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
