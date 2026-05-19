import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    realtime: {
      transport: ws,
    },
  }
);

async function markCourseScraped(courseId) {
  const { error } = await supabase
    .from("golf_courses")
    .update({ last_scraped: new Date().toISOString() })
    .eq("id", courseId);

  if (error) throw error;
}

async function processCourse(browser, course, dates) {
  const collected = [];

  for (const date of dates) {
    const rows = await scrapeCourseForDate(browser, course, date);
    if (rows.length) collected.push(...rows);
    await sleep(1000);
  }

  if (collected.length) {
    await upsertTeeTimes(collected);
  }

  await markCourseScraped(course.id);
  console.log(`${course.name}: ${collected.length} rows upserted`);
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

function chunk(array, size) {
  return Array.from({ length: Math.ceil(array.length / size) }, (_, i) => array.slice(i * size, i * size + size));
}

async function fetchCourses() {
  let query = supabase.from("golf_courses").select("id,name,tee_sheet_url").order("created_at", { ascending: true });
  if (COURSE_LIMIT > 0) query = query.limit(COURSE_LIMIT);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function main() {
  const dates = nextDates(DAYS_AHEAD);
  const courses = await fetchCourses();
  const batches = chunk(courses, BATCH_SIZE);

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map((batch, idx) => runWorker(batch, dates, i + idx + 1)));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
