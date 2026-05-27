import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);

const files = [
  { path: "london-clubs.json", region: "London" },
  { path: "south-east-clubs.json", region: "South East" },
];

let total = 0;
let failed = 0;

for (const { path, region } of files) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  const urls = raw.clubs
    .filter((c) => c.booking_url)
    .map((c) => c.booking_url.trim());

  console.log(`Stamping ${urls.length} courses as "${region}"...`);

  for (const url of urls) {
    const { error } = await supabase
      .from("golf_courses")
      .update({ region })
      .eq("tee_sheet_url", url);

    if (error) {
      console.error(`  FAILED: ${url}`, error.message);
      failed++;
    } else {
      total++;
    }
  }
}

console.log(`\nDone. ${total} courses stamped, ${failed} failed.`);
