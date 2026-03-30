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

// ─── URL filtering ───────────────────────────────────────────────────────────
// Only skip URLs that are confirmed hard blocks with zero chance of data:
// login walls, URL shorteners that are unpredictable, and N/A entries.
// Everything else gets attempted — a zero-row result is fine, skipping
// a valid booking page is not.

const HARD_SKIP_PATTERNS = [
  /elitelive\/login\.php/i,      // e-s-p.com — requires auth
  /warnerhotels\.co\.uk/i,       // hotel deals page, no tee sheet
  /cutt\.ly\//i,                 // URL shortener — unpredictable destination
];

function isHardSkip(url) {
  return HARD_SKIP_PATTERNS.some((p) => p.test(url));
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

// ─── URL normalisation ────────────────────────────────────────────────────────

/**
 * Strip UTM and referral params before processing — they add noise to
 * provider detection, date injection, and cache keys without adding value.
 */
function stripTrackingParams(url) {
  try {
    const u = new URL(url);
    const remove = [];
    for (const key of u.searchParams.keys()) {
      if (/^utm_|^ref$|^a_aid$|^_g[al]/i.test(key)) remove.push(key);
    }
    remove.forEach((k) => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return url;
  }
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
  const value = raw.replace(/\s+/g, " ").trim();

  // Must be exactly HH:MM or H:MM with optional AM/PM — no surrounding text
  const m = value.match(/^(\d{1,2}):(\d{2})(?:\s?(AM|PM))?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3] ? m[3].toUpperCase() : null;

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  // Hard range gates — impossible clock values
  if (hour > 23 || minute > 59) return null;

  // No golf course opens before 5am or after 9pm
  if (hour < 5 || hour > 21) return null;

  // Tee times always fall on standard booking intervals (5, 7, 8, 10, 12, 15 min).
  // Anything else (e.g. :18, :37, :51) is a price or distance leaking through.
  const validMinutes = new Set([0, 5, 7, 8, 10, 12, 14, 15, 20, 21, 24, 25, 28,
    30, 35, 36, 40, 42, 45, 48, 49, 50, 56]);
  if (!validMinutes.has(minute)) return null;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
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

    // ── Helpers ──────────────────────────────────────────────────────────────

    function looksLikeTeeTime(str) {
      // Must be a bare HH:MM or H:MM AM/PM with no surrounding digits
      // Rejects decimals like 58.51 rendered without currency symbol
      return /^(\d{1,2}):(\d{2})(\s?(AM|PM))?$/i.test(str.trim());
    }

    function extractTime(text) {
      // Only match times that appear as standalone tokens, not inside longer numbers
      const m = text.match(/(?<![.\d])(\d{1,2}:\d{2}(?:\s?[AP]M)?)(?![.\d])/i);
      return m ? m[1].trim() : null;
    }

    function extractPrice(text) {
      const m = text.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
      return m ? m[0].replace(/\s+/g, "") : null;
    }

    function extractSpots(text) {
      const m = text.match(/\b([1-4])\s+(?:spots?|players?|balls?|spaces?)\b/i);
      return m ? m[0] : null;
    }

    function isLeafOrNearLeaf(el) {
      // Avoid scanning container nodes that just aggregate child text —
      // those produce duplicates and mixed-context false positives.
      // Accept nodes that have at most 2 element children.
      return el.children.length <= 2;
    }

    function isInTeeTimeContext(el) {
      // Walk up the DOM looking for a container that signals tee time content.
      // Bail out after 6 levels to stay fast.
      const signals = /tee|booking|slot|time|available|round|fee|rate|green/i;
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        const cls = (node.className || "");
        const id = (node.id || "");
        if (signals.test(cls) || signals.test(id)) return true;
        node = node.parentElement;
      }
      return false;
    }

    // ── Main scan ─────────────────────────────────────────────────────────────

    const rows = [];
    const seen = new Set();

    // Strategy 1: structured row scan
    // Look for elements that contain both a time and a price/spots signal
    // within a tight character budget, and are near-leaf nodes.
    const candidates = Array.from(document.querySelectorAll(
      "tr, li, [class*='slot'], [class*='tee'], [class*='time'], [class*='row'], [class*='item'], [class*='booking'], [class*='available']"
    ));

    for (const el of candidates) {
      if (!isLeafOrNearLeaf(el)) continue;

      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 300) continue;

      const timeRaw = extractTime(text);
      if (!timeRaw || !looksLikeTeeTime(timeRaw)) continue;

      const price = extractPrice(text);
      const spots = extractSpots(text);

      // Require at least one of price or spots to confirm this is a tee time row
      if (!price && !spots) continue;

      const key = `${timeRaw}|${price || ""}|${spots || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time_raw: timeRaw,
        price_raw: price,
        spots_raw: spots,
        raw: text,
      });
    }

    // Strategy 2: contextual fallback
    // For pages where times and prices are in separate sibling elements,
    // scan all near-leaf text nodes but require a tee-time DOM context signal.
    if (rows.length === 0) {
      const allNodes = Array.from(document.querySelectorAll("*"));
      for (const node of allNodes) {
        if (!isLeafOrNearLeaf(node)) continue;

        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 150) continue;

        const timeRaw = extractTime(text);
        if (!timeRaw || !looksLikeTeeTime(timeRaw)) continue;

        // In fallback mode, require the element to be inside a tee-time-shaped container
        if (!isInTeeTimeContext(node)) continue;

        const price = extractPrice(text);
        const spots = extractSpots(text);

        const key = `${timeRaw}|${price || ""}|${spots || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({
          tee_time_raw: timeRaw,
          price_raw: price,
          spots_raw: spots,
          raw: text,
        });
      }
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
  intelligentgolf: 2000,  // we now wait for network idle instead of a fixed delay
  clubv1: 3500,
  teeitup: 3000,
  esp: 4000,
  golfmanager: 3500,
  generic: 3000,
};

// ─── Main scrape orchestration ────────────────────────────────────────────────

/**
 * Wait for the page to settle after navigation/date interaction.
 * For JS-heavy providers (IntelligentGolf, ClubV1) we wait for network idle
 * so XHR tee-time responses are captured before we read the page.
 * Fall back to a fixed delay for simpler providers.
 */
async function waitForPageSettle(page, provider) {
  const networkIdleProviders = new Set(["intelligentgolf", "clubv1", "teeitup", "brs"]);

  if (networkIdleProviders.has(provider)) {
    try {
      // Wait until no more than 0 in-flight network requests for 1 second
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      // networkidle timed out — fall back to fixed delay
      await page.waitForTimeout(PROVIDER_WAIT_MS[provider] || 3000);
    }
  } else {
    await page.waitForTimeout(PROVIDER_WAIT_MS[provider] || 3000);
  }
}

// ─── IntelligentGolf extractor ───────────────────────────────────────────────
// Structure confirmed from live DOM inspection:
//   <div class="teetimes-slot bookable:4">
//     <a href="?date=30-03-2026&course=8&group=1&book=14:10:00">
//       <span class="slot-time">14:10</span>
//       <span class="slot-price">£45.00</span>
//     </a>
//   </div>
//
// Spots available is encoded in the class: "bookable:N"
// Unavailable slots have class "bookable:0" or are absent entirely.
//
async function extractIntelligentGolf(page) {
  // Wait specifically for the slot container to appear
  await page.waitForSelector(".teetimes-slot, .price-buttons", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();

    const slots = document.querySelectorAll("div[class*='teetimes-slot']");

    for (const slot of slots) {
      // Parse spots from class e.g. "teetimes-slot bookable:4"
      const classStr = slot.className || "";
      const spotsMatch = classStr.match(/bookable:(\d+)/);
      const spots = spotsMatch ? Number(spotsMatch[1]) : null;

      // Skip slots with 0 availability
      if (spots !== null && spots === 0) continue;

      // Time from span.slot-time, or from the href book= param as fallback
      let timeRaw = null;
      const timeSpan = slot.querySelector(".slot-time, [class*='slot-time']");
      if (timeSpan) {
        timeRaw = (timeSpan.textContent || "").trim();
      }

      // Fallback: parse time from the href ?book=HH:MM:SS
      if (!timeRaw) {
        const link = slot.querySelector("a[href*='book=']");
        if (link) {
          const m = (link.getAttribute("href") || "").match(/book=(\d{1,2}:\d{2})/);
          if (m) timeRaw = m[1];
        }
      }

      if (!timeRaw) continue;

      // Price from span.slot-price
      let price = null;
      const priceSpan = slot.querySelector(".slot-price, [class*='slot-price']");
      if (priceSpan) {
        const priceText = (priceSpan.textContent || "").trim();
        const priceMatch = priceText.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
        price = priceMatch ? priceMatch[0].replace(/\s+/g, "") : null;
      }

      const key = `${timeRaw}|${price || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time_raw: timeRaw,
        price_raw: price,
        spots_raw: spots !== null ? String(spots) : null,
        raw: slot.innerText.replace(/\s+/g, " ").trim(),
      });
    }

    return rows;
  });
}

// ─── BRS extractor ───────────────────────────────────────────────────────────
// Structure confirmed from live DOM inspection:
//   <p class="group-heading ...">Tee Times from £15.00</p>
//   <div class="columns is-multiline is-mobile">
//     <div data-index="0" class="column ...">
//       <div class="select-players">
//         <div id="teetime-202603301418" class="button is-teetime is-fullwidth">14:18</div>
//         <div class="select-players-dropdown ..."> ... </div>
//       </div>
//     </div>
//     ...
//   </div>
//
// Price is per group-heading, shared across all slots beneath it.
// Unavailable slots have no div.is-teetime inside their column.
// Spots not exposed in the DOM at this stage.
//
async function extractBrs(page) {
  await page.waitForSelector(".is-teetime, .group-heading", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();

    // Build a map of group-heading price → applies to all .columns below it
    // Walk the DOM in order, tracking the current price as we pass headings
    let currentPrice = null;

    const allNodes = Array.from(document.querySelectorAll(
      "p.group-heading, div.is-teetime"
    ));

    for (const node of allNodes) {
      if (node.tagName === "P" && node.classList.contains("group-heading")) {
        // Extract price from heading text e.g. "Tee Times from £15.00"
        const m = (node.textContent || "").match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
        currentPrice = m ? m[0].replace(/\s+/g, "") : null;
        continue;
      }

      if (node.classList.contains("is-teetime")) {
        // Time from text content e.g. "14:18"
        let timeRaw = (node.textContent || "").trim();

        // Fallback: parse from id="teetime-202603301418" → last 4 chars = HHMM
        if (!timeRaw && node.id && node.id.startsWith("teetime-")) {
          const digits = node.id.replace("teetime-", "");
          if (digits.length >= 12) {
            const hh = digits.slice(8, 10);
            const mm = digits.slice(10, 12);
            timeRaw = `${hh}:${mm}`;
          }
        }

        if (!timeRaw) continue;

        const key = `${timeRaw}|${currentPrice || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({
          tee_time_raw: timeRaw,
          price_raw: currentPrice,
          spots_raw: null,
          raw: timeRaw,
        });
      }
    }

    return rows;
  });
}

// ─── ClubV1 extractor ────────────────────────────────────────────────────────
// Structure confirmed from live DOM inspection:
//   <div class="tee available" data-teetime="2026-03-30 12:30"
//        data-hour-val="12" data-min-val="30">
//     <div class="time theme_bg"> 12:30 </div>
//     <div class="info">
//       <div class="col-xs-12 col-sm-9">
//         <div class="prices">
//           <div class="price ball-1"><div class="value">30.00</div></div>
//           <div class="price ball-2"><div class="value">60.00</div></div>
//           <div class="price ball-3"><div class="value">90.00</div></div>
//           <div class="price ball-4"><div class="value">120.00</div></div>
//         </div>
//       </div>
//       <div class="col-xs-12 col-sm-3">
//         <div class="controls"><a ... >Book</a></div>
//       </div>
//     </div>
//   </div>
//
// Unavailable slots: div.tee without class "available" — skipped.
// Price: we take ball-1 (single player green fee) as the canonical price.
// Spots: derived from how many ball-N divs are present.
//
async function extractClubV1(page) {
  await page.waitForSelector(".tee.available, div.tees", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();

    // Only select slots with class "available" — excludes booked/closed slots
    const slots = document.querySelectorAll("div.tee.available");

    for (const slot of slots) {
      // Time from data-teetime attribute "2026-03-30 12:30" → take the time part
      let timeRaw = null;
      const dataTeeTime = slot.getAttribute("data-teetime") || "";
      if (dataTeeTime.includes(" ")) {
        timeRaw = dataTeeTime.split(" ")[1].trim(); // "12:30"
      }

      // Fallback: time from div.time text content
      if (!timeRaw) {
        const timeEl = slot.querySelector(".time, .time.theme_bg");
        if (timeEl) timeRaw = (timeEl.textContent || "").trim();
      }

      // Fallback: data-hour-val + data-min-val
      if (!timeRaw) {
        const h = slot.getAttribute("data-hour-val");
        const m = slot.getAttribute("data-min-val");
        if (h && m) timeRaw = `${h.padStart(2,"0")}:${m.padStart(2,"0")}`;
      }

      if (!timeRaw) continue;

      // Price: take ball-1 value (single player fee) as the canonical price
      // Values are plain numbers like "30.00" — prepend £
      let price = null;
      const ball1 = slot.querySelector(".price.ball-1 .value, .price.ball-1 div.value");
      if (ball1) {
        const val = (ball1.textContent || "").trim();
        if (val && /^\d+(\.\d{1,2})?$/.test(val)) {
          price = `£${val}`;
        }
      }

      // Spots: count how many ball-N price divs are present
      const ballDivs = slot.querySelectorAll("[class*='price ball-']");
      const spots = ballDivs.length > 0 ? ballDivs.length : null;

      const key = `${timeRaw}|${price || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time_raw: timeRaw,
        price_raw: price,
        spots_raw: spots !== null ? String(spots) : null,
        raw: slot.innerText.replace(/\s+/g, " ").trim(),
      });
    }

    return rows;
  });
}

async function scrapeProvider(page, provider, date) {
  await page.waitForLoadState("domcontentloaded");

  // Initial settle — let the JS framework bootstrap
  await waitForPageSettle(page, provider);

  // Provider-specific date interaction
  if (provider === "brs") {
    await setBrsDate(page, date);
  } else if (provider === "esp") {
    await setEspDate(page, date);
  } else {
    await setDateIfPresent(page, date);
  }

  // After date change, wait for the resulting XHR to complete
  if (["intelligentgolf", "clubv1", "teeitup", "brs"].includes(provider)) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      await page.waitForTimeout(2000);
    }
  } else {
    await page.waitForTimeout(1500);
  }

  const responseRows = await extractFromCapturedResponses(page);

  // Use targeted provider extractor where available, generic DOM scan for others
  let domRows;
  if (provider === "intelligentgolf") {
    domRows = await extractIntelligentGolf(page);
  } else if (provider === "brs") {
    domRows = await extractBrs(page);
  } else if (provider === "clubv1") {
    domRows = await extractClubV1(page);
  } else {
    domRows = await extractByDom(page);
  }

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeCourseDate(browser, course, date) {
  const page = await browser.newPage();

  // Strip UTM/referral params — they corrupt date injection and add no scraping value
  const cleanUrl = stripTrackingParams(course.tee_sheet_url);
  const provider = detectProvider(cleanUrl);
  const targetUrl = buildDateUrl(cleanUrl, provider, date);

  page.__capturedResponses = [];

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      if (
        contentType.includes("application/json") ||
        contentType.includes("text/json") ||
        // Broaden the URL pattern match — IntelligentGolf uses paths like
        // /api/json.php, /php/visitor_times.php, /booking/times etc.
        /api|times|teetime|tee.?time|booking|availability|slots|schedule|visitor|json\.php/i.test(url)
      ) {
        const body = await response.text();
        if (body && body.length > 10) {
          page.__capturedResponses.push({ url, body });
        }
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

// ─── Past date cleanup ────────────────────────────────────────────────────────

async function cleanPastDates() {
  const today = new Date().toISOString().slice(0, 10);
  const { error, count } = await supabase
    .from("tee_times")
    .delete({ count: "exact" })
    .lt("date", today);
  if (error) {
    console.error("Past date cleanup error:", error.message);
  } else {
    console.log(`Cleaned ${count ?? "?"} rows with date < ${today}`);
  }
}

// ─── Name matching fix ────────────────────────────────────────────────────────
// The resolved view joins tee_times.course_name → clubs.club_name via
// normalize_clublyst_club_name(). When course_name in tee_times doesn't
// exactly match clubs.club_name, the join fails even if the normalised
// keys are identical (e.g. different punctuation, spacing).
// This function looks up the canonical club_name from the clubs table
// and returns it so we write the correct name into tee_times from the start.

const clubNameCache = new Map(); // avoid repeated DB lookups per run

async function resolveCanonicalName(scrapedName) {
  if (clubNameCache.has(scrapedName)) return clubNameCache.get(scrapedName);

  // First try exact match
  const { data: exact } = await supabase
    .from("clubs")
    .select("club_name")
    .eq("club_name", scrapedName)
    .limit(1);

  if (exact && exact.length > 0) {
    clubNameCache.set(scrapedName, exact[0].club_name);
    return exact[0].club_name;
  }

  // Try case-insensitive match
  const { data: all } = await supabase
    .from("clubs")
    .select("club_name");

  if (all) {
    const lower = scrapedName.toLowerCase().trim();
    const match = all.find((c) => c.club_name.toLowerCase().trim() === lower);
    if (match) {
      clubNameCache.set(scrapedName, match.club_name);
      return match.club_name;
    }

    // Try normalised match — strip "golf club/course/centre" suffixes and punctuation
    function normalise(s) {
      return s.toLowerCase()
        .replace(/\bgolf\s+(club|course|centre|center|links|park)\b/gi, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const normScraped = normalise(scrapedName);
    const normMatch = all.find((c) => normalise(c.club_name) === normScraped);
    if (normMatch) {
      clubNameCache.set(scrapedName, normMatch.club_name);
      return normMatch.club_name;
    }
  }

  // No match found — use the scraped name as-is
  clubNameCache.set(scrapedName, scrapedName);
  return scrapedName;
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

  const skipped = [];
  const courses = [];

  for (const [index, row] of raw.entries()) {
    const name = (row["Club name"] || "").trim();
    const url = (row["Booking URL"] || "").trim();

    // Skip truly invalid entries only
    if (!name || !url || url === "N/A") continue;

    // Skip confirmed hard blocks — login walls, broken shorteners
    if (isHardSkip(url)) {
      skipped.push(name);
      continue;
    }

    courses.push({ source_index: index, name, tee_sheet_url: url });
  }

  console.log(`\n── Course loading ──────────────────────────────────────`);
  console.log(`  Total entries:  ${raw.length}`);
  console.log(`  Attempting:     ${courses.length}`);
  console.log(`  Hard skipped:   ${skipped.length}`);
  if (skipped.length) skipped.forEach((n) => console.log(`    ✗ ${n}`));
  console.log(`────────────────────────────────────────────────────────\n`);

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

  // Resolve canonical name from clubs table before upserting
  // so tee_times.course_name matches clubs.club_name exactly
  if (allRows.length > 0) {
    const canonicalName = await resolveCanonicalName(rawCourse.name);
    if (canonicalName !== rawCourse.name) {
      console.log(`  Name resolved: "${rawCourse.name}" → "${canonicalName}"`);
      allRows.forEach((r) => { r.course_name = canonicalName; });
    }
  }

  await upsertRows(allRows);
  await markCourseScraped(course.id);

  const provider = detectProvider(stripTrackingParams(rawCourse.tee_sheet_url));
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
  // Clean past-dated rows before scraping so the view always shows fresh data
  console.log("\n── Cleaning past dates ─────────────────────────────────");
  await cleanPastDates();

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
