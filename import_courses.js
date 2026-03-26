import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) throw new Error("Missing SUPABASE_URL");
if (!supabaseKey) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(supabaseUrl, supabaseKey);

const raw = JSON.parse(fs.readFileSync("./clubs.json", "utf8"));

const cleaned = raw
  .filter((row) => row["Club name"] && row["Booking URL"] && row["Booking URL"] !== "N/A")
  .map((row) => ({
    name: row["Club name"].trim(),
    tee_sheet_url: row["Booking URL"].trim(),
  }));

const dedupedMap = new Map();

for (const row of cleaned) {
  const key = row.tee_sheet_url.toLowerCase();
  if (!dedupedMap.has(key)) {
    dedupedMap.set(key, row);
  }
}

const courses = Array.from(dedupedMap.values());

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );

for (const batch of chunk(courses, 500)) {
  const { error } = await supabase
    .from("golf_courses")
    .upsert(batch, {
      onConflict: "tee_sheet_url",
      ignoreDuplicates: false,
    });

  if (error) {
    console.error(error);
    process.exit(1);
  }
}

console.log(`Imported ${courses.length} unique courses from ${cleaned.length} input rows.`);
