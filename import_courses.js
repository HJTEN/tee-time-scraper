import fs from "fs";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const courses = JSON.parse(fs.readFileSync("./clubs.json", "utf8"))
  .filter((row) => row["Club name"] && row["Booking URL"] && row["Booking URL"] !== "N/A")
  .map((row) => ({
    name: row["Club name"].trim(),
    tee_sheet_url: row["Booking URL"].trim(),
  }));

const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

for (const batch of chunk(courses, 500)) {
  const { error } = await supabase
    .from("golf_courses")
    .upsert(batch, { onConflict: "tee_sheet_url", ignoreDuplicates: false });

  if (error) {
    console.error(error);
    process.exit(1);
  }
}

console.log(`Imported ${courses.length} courses.`);