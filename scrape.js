import fs from "fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BATCH_SIZE            = Number(process.env.BATCH_SIZE            || 5);
const CONCURRENCY           = Number(process.env.CONCURRENCY           || 2);
const PER_COURSE_DELAY_MS   = Number(process.env.PER_COURSE_DELAY_MS   || 2500);
const DAYS_AHEAD            = Number(process.env.DAYS_AHEAD            || 7);
const COURSE_LIMIT          = Number(process.env.COURSE_LIMIT          || 999);
const COURSE_OFFSET         = Number(process.env.COURSE_OFFSET         || 0);
const CACHE_HOURS           = Number(process.env.CACHE_HOURS           || 24);

// ─── URL filtering ────────────────────────────────────────────────────────────
// Only hard-skip URLs that are confirmed zero-data dead ends.
// A zero-row result is acceptable; silently skipping a valid page is not.

const HARD_SKIP_PATTERNS = [
  /warnerhotels\.co\.uk/i,   // hotel deals page, no tee sheet
  /cutt\.ly\//i,             // URL shortener — unpredictable destination
];

function isHardSkip(url) {
  return HARD_SKIP_PATTERNS.some((p) => p.test(url));
}

// ─── Provider detection ───────────────────────────────────────────────────────
// Order matters — more specific patterns first.

function detectProvider(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("brsgolf"))                          return "brs";
  if (u.includes("intelligentgolf"))                  return "intelligentgolf";
  if (u.includes("clubv1"))                           return "clubv1";
  if (u.includes("teeitup"))                          return "teeitup";
  if (u.includes("golfnow"))                          return "golfnow";
  if (u.includes("golfmanager"))                      return "golfmanager";
  if (u.includes("back9solutions"))                   return "back9";
  // ESP: match both the direct elitelive domain AND club websites
  // that embed ESP (detected at runtime via DOM — see detectEspViaPage).
  if (u.includes("e-s-p.com"))                        return "esp";
  if (u.includes("esp-leisure"))                      return "esp";
  if (u.includes("elitelive"))                        return "esp";
  if (u.includes("golfgraffix"))                      return "golfgraffix";
  if (u.includes("foresite"))                         return "foresite";
  if (u.includes("golf-net"))                         return "golfnet";
  if (u.includes("mytimeonline"))                     return "mytimeonline";
  return "generic";
}

// Some clubs embed ESP inside their own website (e.g. The Addington).
// After page load we can confirm this by checking for ESP-specific DOM signals.
async function detectEspViaPage(page) {
  return await page.evaluate(() => {
    return !!(
      document.querySelector("#availtimesbox, .prices_container, .fullsheet_container_available, .activity_viewtimes_frame") ||
      document.querySelector("[class*='fullsheet_container']") ||
      typeof window.ESPScreenloader !== "undefined"
    );
  }).catch(() => false);
}

// ─── URL normalisation ────────────────────────────────────────────────────────

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
      if (url.includes("date=")) return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      return `${url}${joiner}date=${date}`;

    case "brs":
      if (url.includes("visitor_home") || url.includes("visitor_menu") || url.includes("visitor_month")) {
        return `${url}${joiner}date=${date}`;
      }
      return url; // hash-based BRS — date set via DOM interaction

    case "intelligentgolf":
      if (url.includes("date=")) return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      return `${url}${joiner}date=${date}`;

    case "teeitup":
      if (url.includes("date=")) return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      return `${url}${joiner}date=${date}`;

    case "esp":
      // ESP date is always set via DOM form interaction after page load —
      // never injected into the URL (session-bound, no stable date param).
      return url;

    case "foresite":
      if (url.includes("date=")) return url.replace(/date=\d{4}-\d{2}-\d{2}/, `date=${date}`);
      return `${url}${joiner}date=${date}`;

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
  const m = value.match(/^(\d{1,2}):(\d{2})(?:\s?(AM|PM))?$/i);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const meridiem = m[3] ? m[3].toUpperCase() : null;

  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;

  if (hour > 23 || minute > 59) return null;
  if (hour < 5 || hour > 21) return null;

  // Standard booking intervals — rejects prices/distances leaking through
  const validMinutes = new Set([
    0, 5, 7, 8, 10, 12, 14, 15, 20, 21, 24, 25, 28,
    30, 35, 36, 40, 42, 45, 48, 49, 50, 56,
  ]);
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

// ─── DOM extraction (generic fallback) ───────────────────────────────────────

async function extractByDom(page) {
  return await page.evaluate(() => {
    function looksLikeTeeTime(str) {
      return /^(\d{1,2}):(\d{2})(\s?(AM|PM))?$/i.test(str.trim());
    }
    function extractTime(text) {
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
      return el.children.length <= 2;
    }
    function isInTeeTimeContext(el) {
      const signals = /tee|booking|slot|time|available|round|fee|rate|green/i;
      let node = el.parentElement;
      for (let i = 0; i < 6 && node; i++) {
        if (signals.test(node.className || "") || signals.test(node.id || "")) return true;
        node = node.parentElement;
      }
      return false;
    }

    const rows = [];
    const seen = new Set();

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
      if (!price && !spots) continue;
      const key = `${timeRaw}|${price || ""}|${spots || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ tee_time_raw: timeRaw, price_raw: price, spots_raw: spots, raw: text });
    }

    if (rows.length === 0) {
      const allNodes = Array.from(document.querySelectorAll("*"));
      for (const node of allNodes) {
        if (!isLeafOrNearLeaf(node)) continue;
        const text = (node.innerText || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 150) continue;
        const timeRaw = extractTime(text);
        if (!timeRaw || !looksLikeTeeTime(timeRaw)) continue;
        if (!isInTeeTimeContext(node)) continue;
        const price = extractPrice(text);
        const spots = extractSpots(text);
        const key = `${timeRaw}|${price || ""}|${spots || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ tee_time_raw: timeRaw, price_raw: price, spots_raw: spots, raw: text });
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

// ─── Provider-specific date navigation ───────────────────────────────────────

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

async function setBrsDate(page, date) {
  try {
    await page.waitForSelector(".fc-day, .brs-date-cell, [data-date]", { timeout: 5000 }).catch(() => {});
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
 * ESP date interaction.
 *
 * ESP booking pages are sometimes embedded in an iframe on the club's own
 * website (class: activity_viewtimes_iframe_wrapper). We need to:
 *   1. Detect whether the tee sheet is inside an iframe or directly on the page.
 *   2. Fill the date form field in DD/MM/YYYY format.
 *   3. Submit the form and wait for the #availtimesbox to repopulate.
 *
 * The date form field is typically named "play_date" or "date".
 * Submitting triggers a server-side session refresh — we then scrape the
 * updated DOM. The actual booking URLs embedded in the response are
 * session-bound and discarded; only slot times and prices are stored.
 */
async function setEspDate(page, date) {
  const [y, m, d] = date.split("-");
  const espDate = `${d}/${m}/${y}`; // ESP expects DD/MM/YYYY

  // Try direct page first (ESP domain or redirect)
  const directInput = page.locator('input[name="play_date"], input[name="date"], select[name="play_date"]').first();
  if (await directInput.count()) {
    try {
      await directInput.fill(espDate);
      await page.keyboard.press("Enter");
      await page.waitForTimeout(3000);
      return "direct";
    } catch {}
  }

  // Try iframe context — ESP is often embedded in club websites
  const iframeSelectors = [
    ".activity_viewtimes_iframe_wrapper iframe",
    "iframe[src*='e-s-p']",
    "iframe[src*='elitelive']",
    "iframe[src*='esp-leisure']",
    "iframe",
  ];

  for (const sel of iframeSelectors) {
    try {
      const iframeEl = page.frameLocator(sel);
      const iframeInput = iframeEl.locator('input[name="play_date"], input[name="date"]').first();
      if (await iframeInput.count({ timeout: 3000 })) {
        await iframeInput.fill(espDate);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(3000);
        return "iframe";
      }
    } catch {}
  }

  return null;
}

// ─── Provider wait times ──────────────────────────────────────────────────────

const PROVIDER_WAIT_MS = {
  brs:            4000,
  intelligentgolf: 2000,
  clubv1:         3500,
  teeitup:        3000,
  esp:            4000,
  golfmanager:    3500,
  foresite:       3000,
  golfnet:        3000,
  mytimeonline:   3000,
  generic:        3000,
};

async function waitForPageSettle(page, provider) {
  const networkIdleProviders = new Set(["intelligentgolf", "clubv1", "teeitup", "brs"]);
  if (networkIdleProviders.has(provider)) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 8000 });
    } catch {
      await page.waitForTimeout(PROVIDER_WAIT_MS[provider] || 3000);
    }
  } else {
    await page.waitForTimeout(PROVIDER_WAIT_MS[provider] || 3000);
  }
}

// ─── IntelligentGolf extractor ────────────────────────────────────────────────
//
// Confirmed DOM structure:
//   <div class="teetimes-slot bookable:4">
//     <a href="?date=30-03-2026&course=8&group=1&book=14:10:00">
//       <span class="slot-time">14:10</span>
//       <span class="slot-price">£45.00</span>
//     </a>
//   </div>
//
// Spots from class "bookable:N". bookable:0 = skip.
//
async function extractIntelligentGolf(page) {
  await page.waitForSelector(".teetimes-slot, .price-buttons", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const slots = document.querySelectorAll("div[class*='teetimes-slot']");

    for (const slot of slots) {
      const classStr = slot.className || "";
      const spotsMatch = classStr.match(/bookable:(\d+)/);
      const spots = spotsMatch ? Number(spotsMatch[1]) : null;
      if (spots !== null && spots === 0) continue;

      let timeRaw = null;
      const timeSpan = slot.querySelector(".slot-time, [class*='slot-time']");
      if (timeSpan) timeRaw = (timeSpan.textContent || "").trim();

      if (!timeRaw) {
        const link = slot.querySelector("a[href*='book=']");
        if (link) {
          const m = (link.getAttribute("href") || "").match(/book=(\d{1,2}:\d{2})/);
          if (m) timeRaw = m[1];
        }
      }
      if (!timeRaw) continue;

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
      rows.push({ tee_time_raw: timeRaw, price_raw: price, spots_raw: spots !== null ? String(spots) : null, raw: slot.innerText.replace(/\s+/g, " ").trim() });
    }
    return rows;
  });
}

// ─── BRS extractor ────────────────────────────────────────────────────────────
//
// Confirmed DOM structure:
//   <p class="group-heading">Tee Times from £15.00</p>
//   <div class="columns is-multiline is-mobile">
//     <div data-index="0" class="column">
//       <div class="select-players">
//         <div id="teetime-202603301418" class="button is-teetime is-fullwidth">14:18</div>
//       </div>
//     </div>
//   </div>
//
// Price comes from the group-heading above the slot group.
//
async function extractBrs(page) {
  await page.waitForSelector(".is-teetime, .group-heading", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    let currentPrice = null;

    const allNodes = Array.from(document.querySelectorAll("p.group-heading, div.is-teetime"));

    for (const node of allNodes) {
      if (node.tagName === "P" && node.classList.contains("group-heading")) {
        const m = (node.textContent || "").match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
        currentPrice = m ? m[0].replace(/\s+/g, "") : null;
        continue;
      }
      if (node.classList.contains("is-teetime")) {
        let timeRaw = (node.textContent || "").trim();
        if (!timeRaw && node.id && node.id.startsWith("teetime-")) {
          const digits = node.id.replace("teetime-", "");
          if (digits.length >= 12) {
            timeRaw = `${digits.slice(8, 10)}:${digits.slice(10, 12)}`;
          }
        }
        if (!timeRaw) continue;
        const key = `${timeRaw}|${currentPrice || ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ tee_time_raw: timeRaw, price_raw: currentPrice, spots_raw: null, raw: timeRaw });
      }
    }
    return rows;
  });
}

// ─── ClubV1 extractor ────────────────────────────────────────────────────────
//
// Confirmed DOM structure:
//   <div class="tee available" data-teetime="2026-03-30 12:30"
//        data-hour-val="12" data-min-val="30">
//     <div class="time theme_bg">12:30</div>
//     <div class="prices">
//       <div class="price ball-1"><div class="value">30.00</div></div>
//       <div class="price ball-2"><div class="value">60.00</div></div>
//     </div>
//   </div>
//
// ball-1 = single player fee (canonical price). Spots = count of ball-N divs.
//
async function extractClubV1(page) {
  await page.waitForSelector(".tee.available, div.tees", { timeout: 8000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();
    const slots = document.querySelectorAll("div.tee.available");

    for (const slot of slots) {
      let timeRaw = null;
      const dataTeeTime = slot.getAttribute("data-teetime") || "";
      if (dataTeeTime.includes(" ")) timeRaw = dataTeeTime.split(" ")[1].trim();
      if (!timeRaw) {
        const timeEl = slot.querySelector(".time, .time.theme_bg");
        if (timeEl) timeRaw = (timeEl.textContent || "").trim();
      }
      if (!timeRaw) {
        const h = slot.getAttribute("data-hour-val");
        const m = slot.getAttribute("data-min-val");
        if (h && m) timeRaw = `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
      }
      if (!timeRaw) continue;

      let price = null;
      const ball1 = slot.querySelector(".price.ball-1 .value, .price.ball-1 div.value");
      if (ball1) {
        const val = (ball1.textContent || "").trim();
        if (val && /^\d+(\.\d{1,2})?$/.test(val)) price = `£${val}`;
      }

      const ballDivs = slot.querySelectorAll("[class*='price ball-']");
      const spots = ballDivs.length > 0 ? ballDivs.length : null;

      const key = `${timeRaw}|${price || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ tee_time_raw: timeRaw, price_raw: price, spots_raw: spots !== null ? String(spots) : null, raw: slot.innerText.replace(/\s+/g, " ").trim() });
    }
    return rows;
  });
}

// ─── ESP extractor ────────────────────────────────────────────────────────────
//
// Confirmed DOM structure (from The Addington live inspection):
//
//   <div id="availtimesbox">
//     <div class="prices_container">
//       <div class="fullsheet_container">
//         <div class="fullsheet_container_available">
//           <a onclick="ESPScreenloader.startspinner();"
//              href="?gotdata=2&StartDate=06%2F04%2F26&EndDate=06%2F04%2F26
//                    &Start=12%3A20&End=13%3A19&Valid=N&Price=175.00&">
//             " 12:20"
//             <br>
//             "£175.00 "
//           </a>
//         </div>
//         <div class="fullsheet_container_available"> ... </div>
//       </div>
//     </div>
//   </div>
//
// Key observations:
//   - Available slots: div.fullsheet_container_available
//   - Unavailable/booked slots: div.fullsheet_container (without _available)
//   - Time and price are mixed text nodes inside the <a> tag
//   - The href contains URL-encoded time params as a fallback source:
//       Start=HH%3AMM (decoded: HH:MM)
//       Price=NNN.NN
//   - The href is session-bound — we NEVER store it, only extract data from it
//   - ESP may be embedded in an iframe on club websites
//
// Strategy:
//   1. Try direct page context first.
//   2. Fall back to iframe context if #availtimesbox not found directly.
//   3. Extract from text nodes + href params as fallback.
//
async function extractEsp(page) {
  // Wait for the availability container — either directly or inside an iframe
  const directBox = await page.locator("#availtimesbox").count().catch(() => 0);

  if (directBox > 0) {
    return await extractEspFromContext(page);
  }

  // Try iframe contexts
  const iframeSelectors = [
    ".activity_viewtimes_iframe_wrapper iframe",
    "iframe[src*='e-s-p']",
    "iframe[src*='elitelive']",
    "iframe[src*='esp-leisure']",
    "iframe",
  ];

  for (const sel of iframeSelectors) {
    try {
      const frame = page.frameLocator(sel);
      const boxCount = await frame.locator("#availtimesbox").count({ timeout: 3000 });
      if (boxCount > 0) {
        return await extractEspFromFrame(page, sel);
      }
    } catch {}
  }

  // Neither direct nor iframe found — return empty
  return [];
}

/**
 * Extract ESP slots from the page directly (no iframe).
 */
async function extractEspFromContext(page) {
  await page.waitForSelector("#availtimesbox", { timeout: 6000 }).catch(() => {});

  return await page.evaluate(() => {
    const rows = [];
    const seen = new Set();

    const slots = document.querySelectorAll(".fullsheet_container_available");

    for (const slot of slots) {
      const link = slot.querySelector("a[href]");
      if (!link) continue;

      // Primary: extract time from visible text content
      let timeRaw = null;
      let price = null;

      const fullText = (link.innerText || link.textContent || "").replace(/\s+/g, " ").trim();
      const timeMatch = fullText.match(/(\d{1,2}:\d{2})/);
      if (timeMatch) timeRaw = timeMatch[1];

      const priceMatch = fullText.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
      if (priceMatch) price = priceMatch[0].replace(/\s+/g, "");

      // Fallback: decode time and price from href params
      // href: ?...&Start=12%3A20&...&Price=175.00&
      if (!timeRaw || !price) {
        const href = link.getAttribute("href") || "";
        const decoded = decodeURIComponent(href);

        if (!timeRaw) {
          const startMatch = decoded.match(/[?&]Start=(\d{1,2}:\d{2})/i);
          if (startMatch) timeRaw = startMatch[1];
        }
        if (!price) {
          const priceMatch2 = decoded.match(/[?&]Price=([\d.]+)/i);
          if (priceMatch2) price = `£${priceMatch2[1]}`;
        }
      }

      if (!timeRaw) continue;

      const key = `${timeRaw}|${price || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({
        tee_time_raw: timeRaw,
        price_raw: price,
        spots_raw: null, // ESP doesn't expose spots in the availability DOM
        raw: fullText,
      });
    }

    return rows;
  });
}

/**
 * Extract ESP slots from within an iframe context.
 * Playwright's frameLocator API lets us query inside the iframe.
 */
async function extractEspFromFrame(page, iframeSel) {
  const frame = page.frameLocator(iframeSel);

  await frame.locator("#availtimesbox").waitFor({ timeout: 6000 }).catch(() => {});

  // Use locator-based extraction (frameLocator doesn't support page.evaluate)
  const slotLocators = frame.locator(".fullsheet_container_available a[href]");
  const count = await slotLocators.count().catch(() => 0);

  const rows = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    try {
      const el = slotLocators.nth(i);
      const fullText = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const href = (await el.getAttribute("href").catch(() => "")) || "";
      const decoded = decodeURIComponent(href);

      let timeRaw = null;
      let price = null;

      const timeMatch = fullText.match(/(\d{1,2}:\d{2})/);
      if (timeMatch) timeRaw = timeMatch[1];

      const priceMatch = fullText.match(/[£€$]\s?\d+(?:\.\d{1,2})?/);
      if (priceMatch) price = priceMatch[0].replace(/\s+/g, "");

      if (!timeRaw) {
        const startMatch = decoded.match(/[?&]Start=(\d{1,2}:\d{2})/i);
        if (startMatch) timeRaw = startMatch[1];
      }
      if (!price) {
        const priceMatch2 = decoded.match(/[?&]Price=([\d.]+)/i);
        if (priceMatch2) price = `£${priceMatch2[1]}`;
      }

      if (!timeRaw) continue;

      const key = `${timeRaw}|${price || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);

      rows.push({ tee_time_raw: timeRaw, price_raw: price, spots_raw: null, raw: fullText });
    } catch {}
  }

  return rows;
}

// ─── Main scrape orchestration ────────────────────────────────────────────────

async function scrapeProvider(page, provider, date) {
  await page.waitForLoadState("domcontentloaded");
  await waitForPageSettle(page, provider);

  // Provider-specific date interaction
  let espContext = null;
  if (provider === "brs") {
    await setBrsDate(page, date);
  } else if (provider === "esp") {
    espContext = await setEspDate(page, date);
  } else {
    await setDateIfPresent(page, date);
  }

  // Wait for data to load after date interaction
  if (["intelligentgolf", "clubv1", "teeitup", "brs"].includes(provider)) {
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {
      await page.waitForTimeout(2000);
    }
  } else if (provider === "esp") {
    // ESP does a server-side form post — wait for the DOM to repopulate
    await page.waitForTimeout(3000);
    await page.waitForSelector("#availtimesbox, .fullsheet_container_available", { timeout: 5000 }).catch(() => {});
  } else {
    await page.waitForTimeout(1500);
  }

  const responseRows = await extractFromCapturedResponses(page);

  // Dispatch to the correct extractor
  let domRows = [];
  if (provider === "intelligentgolf") {
    domRows = await extractIntelligentGolf(page);
  } else if (provider === "brs") {
    domRows = await extractBrs(page);
  } else if (provider === "clubv1") {
    domRows = await extractClubV1(page);
  } else if (provider === "esp") {
    domRows = await extractEsp(page);
  } else {
    domRows = await extractByDom(page);
  }

  // If ESP wasn't detected via URL but DOM confirms it, re-extract with ESP extractor
  if (provider === "generic" && domRows.length === 0) {
    const isEsp = await detectEspViaPage(page);
    if (isEsp) {
      console.log(`  ↳ ESP detected via DOM — re-extracting with ESP extractor`);
      domRows = await extractEsp(page);
    }
  }

  return normaliseExtractedRows([...responseRows, ...domRows]);
}

async function scrapeCourseDate(browser, course, date) {
  const page = await browser.newPage();

  const cleanUrl = stripTrackingParams(course.tee_sheet_url);
  let provider = detectProvider(cleanUrl);
  const targetUrl = buildDateUrl(cleanUrl, provider, date);

  page.__capturedResponses = [];

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      if (
        contentType.includes("application/json") ||
        contentType.includes("text/json") ||
        /api|times|teetime|tee.?time|booking|availability|slots|schedule|visitor|json\.php/i.test(url)
      ) {
        const body = await response.text();
        if (body && body.length > 10) page.__capturedResponses.push({ url, body });
      }
    } catch {}
  });

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

    // If a club website URL resolves to an ESP page, upgrade the provider
    if (provider === "generic") {
      const isEsp = await detectEspViaPage(page);
      if (isEsp) {
        provider = "esp";
        console.log(`  ↳ ${course.name}: ESP detected via DOM (club website embeds ESP)`);
        // Trigger date interaction now that we know it's ESP
        await setEspDate(page, date);
        await page.waitForTimeout(3000);
        await page.waitForSelector("#availtimesbox, .fullsheet_container_available", { timeout: 5000 }).catch(() => {});
      }
    }

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

const clubNameCache = new Map();

async function resolveCanonicalName(scrapedName) {
  if (clubNameCache.has(scrapedName)) return clubNameCache.get(scrapedName);

  const { data: exact } = await supabase
    .from("clubs")
    .select("club_name")
    .eq("club_name", scrapedName)
    .limit(1);

  if (exact && exact.length > 0) {
    clubNameCache.set(scrapedName, exact[0].club_name);
    return exact[0].club_name;
  }

  const { data: all } = await supabase.from("clubs").select("club_name");

  if (all) {
    const lower = scrapedName.toLowerCase().trim();
    const match = all.find((c) => c.club_name.toLowerCase().trim() === lower);
    if (match) { clubNameCache.set(scrapedName, match.club_name); return match.club_name; }

    function normalise(s) {
      return s.toLowerCase()
        .replace(/\bgolf\s+(club|course|centre|center|links|park)\b/gi, "")
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    const normScraped = normalise(scrapedName);
    const normMatch = all.find((c) => normalise(c.club_name) === normScraped);
    if (normMatch) { clubNameCache.set(scrapedName, normMatch.club_name); return normMatch.club_name; }
  }

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

// ─── Course loading ───────────────────────────────────────────────────────────

function loadCoursesFromJson() {
  const raw = JSON.parse(fs.readFileSync("./clubs.json", "utf8"));

  const skipped = [];
  const courses = [];

  for (const [index, row] of raw.entries()) {
    const name = (row["Club name"] || "").trim();
    const url = (row["Booking URL"] || "").trim();
    if (!name || !url || url === "N/A") continue;
    if (isHardSkip(url)) { skipped.push(name); continue; }
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
