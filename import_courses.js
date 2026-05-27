import fs from "fs";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { realtime: { transport: ws } }
);

function loadCourses(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));

  // New format: { region, clubs: [{ name, booking_url, ... }] }
  if (raw.clubs && Array.isArray(raw.clubs)) {
    return raw.clubs
      .filter((c) => c.name && c.booking_url)
      .map((c) => ({
        name: c.name.trim(),
        tee_sheet_url: c.booking_url.trim(),
      }));
  }

  // Old format: [{ "Club name", "Booking URL" }]
  if (Array.isArray(raw)) {
    return raw
      .filter((c) => c["Club name"] && c["Booking URL"] && c["Booking URL"] !== "N/A")
      .map((c) => ({
        name: c["Club name"].trim(),
        tee_sheet_url: c["Booking URL"].trim(),
      }));
  }

  return [];
}

// Load all JSON files passed as arguments, or default to the region files
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(".").filter((f) => f.endsWith(".json") && f !== "package.json");

const seen = new Set();
const courses = [];

for (const file of files) {
  for (const course of loadCourses(file)) {
    if (!seen.has(course.tee_sheet_url)) {
      seen.add(course.tee_sheet_url);
      courses.push(course);
    }
  }
}

const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, i * size + size)
  );

for (const batch of chunk(courses, 500)) {
  const { error } = await supabase
    .from("golf_courses")
    .upsert(batch, { onConflict: "tee_sheet_url", ignoreDuplicates: false });

  if (error) {
    console.error(error);
    process.exit(1);
  }
}

console.log(`Imported ${courses.length} courses from ${files.length} file(s).`);
