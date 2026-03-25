import fs from "fs";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const clubs = JSON.parse(fs.readFileSync("./clubs.json", "utf8"));

async function scrapeClub(browser, club) {

  const page = await browser.newPage();

  console.log("Scraping:", club["Club name"]);

  try {

    await page.goto(club["Booking URL"], {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    const slots = await page.evaluate(() => {

      const results = [];
      const elements = document.querySelectorAll("*");

      elements.forEach(el => {

        const text = el.innerText;

        if (!text) return;

        const timeMatch = text.match(/\b\d{1,2}:\d{2}\b/);

        if (!timeMatch) return;

        const priceMatch = text.match(/£\d+/);

        results.push({
          time: timeMatch[0],
          price: priceMatch ? priceMatch[0].replace("£","") : null
        });

      });

      return results;

    });

    const seen = new Set();

    for (const slot of slots) {

      if (seen.has(slot.time)) continue;
      seen.add(slot.time);

      await supabase.from("tee_times").insert({
        club_name: club["Club name"],
        tee_time: slot.time,
        price: slot.price,
        captured_at: new Date()
      });

    }

  } catch (err) {

    console.log("Failed:", club["Club name"]);

  }

  await page.close();
}

async function run() {

  const browser = await chromium.launch({
    headless: true
  });

  for (const club of clubs) {

    const url = club["Booking URL"];

    if (!url || url === "N/A") continue;

    await scrapeClub(browser, club);

    await new Promise(r => setTimeout(r, 4000));

  }

  await browser.close();
}

run();