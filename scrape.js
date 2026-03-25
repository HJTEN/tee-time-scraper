import fs from "fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const clubs = JSON.parse(fs.readFileSync("./clubs.json", "utf8"));

function extractProvider(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("brsgolf")) return "brs";
  if (u.includes("intelligentgolf")) return "intelligentgolf";
  if (u.includes("clubv1")) return "clubv1";
  return "generic";
}

async function extractRows(page, club) {
  const provider = extractProvider(club["Booking URL"]);

  if (provider === "brs") {
    return await page.evaluate((club) => {
      const rows = [];
      const seen = new Set();
      const all = Array.from(document.querySelectorAll("*"));

      for (const el of all) {
        const text = (el.innerText || "").trim();
        if (!text) continue;

        const timeMatch = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
        if (!timeMatch) continue;

        const priceMatch = text.match(/[£$€]\s?\d+(?:\.\d{1,2})?/);
        const spotsMatch = text.match(/\b([1-4])\s+(?:spots|players|balls?)\b/i);

        const key = `${timeMatch[0]}-${priceMatch ? priceMatch[0] : ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({
          course_name: club["Club name"],
          tee_sheet_url: club["Booking URL"],
          tee_time: timeMatch[0],
          price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : null,
          spots_available: spotsMatch ? Number(spotsMatch[1]) : null,
          date: new Date().toISOString().slice(0, 10),
          scraped_at: new Date().toISOString()
        });
      }

      return rows;
    }, club);
  }

  if (provider === "intelligentgolf" || provider === "clubv1") {
    return await page.evaluate((club) => {
      const rows = [];
      const seen = new Set();
      const all = Array.from(document.querySelectorAll("*"));

      for (const el of all) {
        const text = (el.innerText || "").trim();
        if (!text) continue;

        const timeMatch = text.match(/\b\d{1,2}:\d{2}(?:\s?[AP]M)?\b/i);
        if (!timeMatch) continue;

        const priceMatch = text.match(/[£$€]\s?\d+(?:\.\d{1,2})?/);

        const key = `${timeMatch[0]}-${priceMatch ? priceMatch[0] : ""}`;
        if (seen.has(key)) continue;
        seen.add(key);

        rows.push({
          course_name: club["Club name"],
          tee_sheet_url: club["Booking URL"],
          tee_time: timeMatch[0],
          price: priceMatch ? priceMatch[0].replace(/\s+/g, "") : null,
          spots_available: null,
          date: new Date().toISOString().slice(0, 10),
          scraped_at: new Date().toISOString()
        });
      }

      return rows;
    }, club);
  }

  return [];
}

async function scrapeClub(browser, club) {
  const page = await browser.newPage();

  try {
    console.log(`Scraping ${club["Club name"]}`);
    await page.goto(club["Booking URL"], {
      waitUntil: "networkidle",
      timeout: 60000
    });

    await page.waitForTimeout(4000);

    const rows = await extractRows(page, club);

    console.log(`Found ${rows.length} rows for ${club["Club name"]}`);

    if (!rows.length) return;

    const { error } = await supabase.from("tee_times").insert(rows);

    if (error) {
      console.error(`Insert failed for ${club["Club name"]}: ${error.message}`);
    }
  } catch (err) {
    console.error(`Failed ${club["Club name"]}: ${err.message}`);
  } finally {
    await page.close();
  }
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  const sample = clubs.filter(
    c =>
      c["Booking URL"] &&
      c["Booking URL"] !== "N/A" &&
      (
        c["Booking URL"].includes("brsgolf") ||
        c["Booking URL"].includes("intelligentgolf") ||
        c["Booking URL"].includes("clubv1")
      )
  ).slice(0, 20);

  for (const club of sample) {
    await scrapeClub(browser, club);
    await new Promise(r => setTimeout(r, 4000));
  }

  await browser.close();
}

run();
