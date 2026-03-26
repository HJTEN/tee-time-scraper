// scrape.js
import { createClient } from "@supabase/supabase-js";

// -----------------------------
// ENV
// -----------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Sharding
const TOTAL_SHARDS = Number(process.env.TOTAL_SHARDS || 4);
const SHARD_INDEX = Number(process.env.SHARD_INDEX || 0);

// Controls
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";
const FORCE_REFRESH = String(process.env.FORCE_REFRESH || "false").toLowerCase() === "true";
const MAX_CLUBS = Number(process.env.MAX_CLUBS || 0); // 0 = no cap
const FRESHNESS_HOURS = Number(process.env.FRESHNESS_HOURS || 24);

// -----------------------------
// HELPERS
// -----------------------------
function assertValidShardConfig() {
  if (!Number.isInteger(TOTAL_SHARDS) || TOTAL_SHARDS <= 0) {
    throw new Error(`Invalid TOTAL_SHARDS: ${TOTAL_SHARDS}`);
  }
  if (!Number.isInteger(SHARD_INDEX) || SHARD_INDEX < 0 || SHARD_INDEX >= TOTAL_SHARDS) {
    throw new Error(`Invalid SHARD_INDEX: ${SHARD_INDEX} for TOTAL_SHARDS=${TOTAL_SHARDS}`);
  }
}

function getClubKey(club) {
  return (
    club.club_key ||
    club.clubKey ||
    club.slug ||
    club.id ||
    club.name?.toLowerCase().trim()
  );
}

function chunkByModulo(items, totalShards, shardIndex) {
  return items.filter((_, i) => i % totalShards === shardIndex);
}

function isFresh(updatedAt, freshnessHours) {
  if (!updatedAt) return false;
  const updatedMs = new Date(updatedAt).getTime();
  if (Number.isNaN(updatedMs)) return false;
  const ageMs = Date.now() - updatedMs;
  return ageMs < freshnessHours * 60 * 60 * 1000;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    const existing = map.get(key) || [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}

async function loadClubs() {
  const pageSize = 1000;
  let from = 0;
  const allRows = [];

  while (true) {
    const { data, error } = await supabase
      .from("clubs")
      .select("*")
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to load clubs from Supabase: ${error.message}`);
    }

    const rows = data || [];
    allRows.push(...rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  const clubs = allRows
    .filter(Boolean)
    .map((club, index) => ({
      ...club,
      __index: index,
      __clubKey: getClubKey(club),
    }))
    .filter((club) => club.__clubKey);

  return clubs;
}

// -----------------------------
// SUPABASE LOOKUPS
// -----------------------------
// This checks whether a club already has RECENT tee time data.
// Adjust field names if your schema differs.
async function fetchFreshnessMap(clubKeys) {
  if (!clubKeys.length) return new Map();

  const pageSize = 500;
  const rows = [];

  for (let i = 0; i < clubKeys.length; i += pageSize) {
    const batch = clubKeys.slice(i, i + pageSize);

    const { data, error } = await supabase
      .from("tee_times")
      .select("club_key, scraped_at, created_at")
      .in("club_key", batch)
      .order("scraped_at", { ascending: false, nullsFirst: false });

    if (error) {
      throw new Error(`Failed to fetch existing tee_times: ${error.message}`);
    }

    rows.push(...(data || []));
  }

  const grouped = groupBy(rows, (r) => r.club_key);
  const freshnessMap = new Map();

  for (const [clubKey, clubRows] of grouped.entries()) {
    const latest = clubRows[0];
    const latestTs = latest.scraped_at || latest.created_at || null;
    freshnessMap.set(clubKey, {
      latestTs,
      isFresh: isFresh(latestTs, FRESHNESS_HOURS),
      rowCount: clubRows.length,
    });
  }

  return freshnessMap;
}

// -----------------------------
// SCRAPER ENTRYPOINTS
// -----------------------------
// Replace this with your actual scraper/provider logic.
// It should return an array of tee time rows ready for upsert/insert.
async function scrapeClubTeeTimes(club) {
  // TODO:
  // - detect provider from booking URL
  // - fetch availability for next few days
  // - normalize to tee_times table shape
  // - return [] if no data found
  //
  // Example return shape:
  // [
  //   {
  //     club_key: club.__clubKey,
  //     club_name: club.name,
  //     tee_time_at: "2026-03-26T10:24:00Z",
  //     booking_url: club.booking_url || null,
  //     provider: "BRS",
  //     scraped_at: new Date().toISOString(),
  //   }
  // ]
  return [];
}

// You can switch this to upsert if you have a suitable unique constraint.
// For example unique(club_key, tee_time_at)
async function saveTeeTimes(rows) {
  if (!rows.length) return { inserted: 0 };

  const { error } = await supabase
    .from("tee_times")
    .upsert(rows, {
      onConflict: "club_key,tee_time_at",
      ignoreDuplicates: false,
    });

  if (error) {
    throw new Error(`Failed to upsert tee_times: ${error.message}`);
  }

  return { inserted: rows.length };
}

// -----------------------------
// MAIN
// -----------------------------
async function main() {
  assertValidShardConfig();

  const allClubs = await loadClubs();

  console.log("--------------------------------------------------");
  console.log("Tee time scrape starting");
  console.log(`Total clubs loaded: ${allClubs.length}`);
  console.log(`TOTAL_SHARDS: ${TOTAL_SHARDS}`);
  console.log(`SHARD_INDEX: ${SHARD_INDEX}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);
  console.log(`FORCE_REFRESH: ${FORCE_REFRESH}`);
  console.log(`MAX_CLUBS: ${MAX_CLUBS || "none"}`);
  console.log(`FRESHNESS_HOURS: ${FRESHNESS_HOURS}`);
  console.log("--------------------------------------------------");

  const shardClubsInitial = chunkByModulo(allClubs, TOTAL_SHARDS, SHARD_INDEX);

  let shardClubs = shardClubsInitial;
  if (MAX_CLUBS > 0) {
    shardClubs = shardClubs.slice(0, MAX_CLUBS);
  }

  console.log(`Clubs assigned to shard before cap: ${shardClubsInitial.length}`);
  console.log(`Clubs assigned to shard after cap: ${shardClubs.length}`);
  console.log(
    `First assigned clubs: ${shardClubs.slice(0, 10).map((c) => c.name).join(" | ")}`
  );
  console.log(
    `Last assigned clubs: ${shardClubs.slice(-10).map((c) => c.name).join(" | ")}`
  );

  const freshnessMap = await fetchFreshnessMap(shardClubs.map((c) => c.__clubKey));

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;
  let skippedFresh = 0;
  let skippedNoBookingUrl = 0;
  let emptyResults = 0;

  const failures = [];

  for (let i = 0; i < shardClubs.length; i++) {
    const club = shardClubs[i];
    const clubKey = club.__clubKey;
    const bookingUrl =
      club.booking_url ||
      club.bookingUrl ||
      club.booking_link ||
      club.bookingLink ||
      club.website ||
      club.url ||
      null;
    const existing = freshnessMap.get(clubKey);

    console.log(
      `[${i + 1}/${shardClubs.length}] ${club.name} | club_key=${clubKey}`
    );

    if (!bookingUrl) {
      skippedNoBookingUrl += 1;
      console.log("  -> skipped: no booking URL");
      continue;
    }

    if (!FORCE_REFRESH && existing?.isFresh) {
      skippedFresh += 1;
      console.log(`  -> skipped: fresh existing data (${existing.latestTs})`);
      continue;
    }

    attempted += 1;

    try {
      const rows = await scrapeClubTeeTimes(club);

      if (!rows || rows.length === 0) {
        emptyResults += 1;
        console.log("  -> no tee times returned");
        continue;
      }

      const normalizedRows = rows.map((row) => ({
        ...row,
        club_key: row.club_key || clubKey,
        club_name: row.club_name || club.name,
        booking_url: row.booking_url || bookingUrl,
        scraped_at: row.scraped_at || new Date().toISOString(),
      }));

      if (DRY_RUN) {
        console.log(`  -> dry run: would save ${normalizedRows.length} rows`);
      } else {
        const result = await saveTeeTimes(normalizedRows);
        console.log(`  -> saved ${result.inserted} rows`);
      }

      succeeded += 1;
    } catch (err) {
      failed += 1;
      failures.push({
        club_key: clubKey,
        club_name: club.name,
        error: err?.message || String(err),
      });
      console.error(`  -> failed: ${err?.message || err}`);
    }
  }

  console.log("--------------------------------------------------");
  console.log("SCRAPE SUMMARY");
  console.log(`Total clubs loaded: ${allClubs.length}`);
  console.log(`Shard assigned: ${shardClubs.length}`);
  console.log(`Attempted: ${attempted}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);
  console.log(`Skipped fresh: ${skippedFresh}`);
  console.log(`Skipped no booking URL: ${skippedNoBookingUrl}`);
  console.log(`Empty results: ${emptyResults}`);
  console.log(`Unattempted due to skips: ${shardClubs.length - attempted}`);
  console.log("--------------------------------------------------");

  if (failures.length) {
    console.log("FAILURES:");
    for (const failure of failures.slice(0, 100)) {
      console.log(
        `- ${failure.club_name} (${failure.club_key}): ${failure.error}`
      );
    }
  }

  if (failed > 0) {
    // Optional: fail the GitHub Action if you want.
    // process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal error in scrape.js:", err);
  process.exit(1);
});
