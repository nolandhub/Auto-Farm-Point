import { log } from "./log.js";

/**
 * Topic sources, tried in order. Lives in the service worker rather than the
 * popup so the daily automatic run works with no window open — in v2.4 the
 * fetching happened in popup.js, which meant nothing could run unattended.
 *
 * Both endpoints send permissive CORS headers, so no host permission is needed
 * and the extension asks for nothing beyond bing.com.
 */

const TIMEOUT_MS = 8_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Random article titles: the most human-looking source available. */
async function wikipedia(count) {
  const batchSize = 10;
  const batches = Math.ceil(count / batchSize);
  const requests = [];

  for (let i = 0; i < batches; i++) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      list: "random",
      rnlimit: String(Math.min(batchSize, count - i * batchSize)),
      rnnamespace: "0",
      origin: "*",
    });
    requests.push(fetchJson(`https://en.wikipedia.org/w/api.php?${params}`));
  }

  const settled = await Promise.allSettled(requests);
  const titles = settled
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value?.query?.random?.map((item) => item.title) ?? []);

  if (titles.length === 0) throw new Error("no titles returned");
  return titles;
}

/** Semantically related words. Weaker, but reliable and rate-limit friendly. */
async function datamuse(count) {
  const seeds = ["technology", "science", "history", "nature", "business", "art", "travel"];
  const seed = seeds[Math.floor(Math.random() * seeds.length)];
  const data = await fetchJson(
    `https://api.datamuse.com/words?ml=${seed}&max=${Math.min(count + 10, 100)}`
  );
  if (!Array.isArray(data) || data.length === 0) throw new Error("empty response");
  return data.map((item) => item.word);
}

const PROVIDERS = [
  { name: "Wikipedia", fetch: wikipedia },
  { name: "Datamuse", fetch: datamuse },
];

/**
 * Returns whatever the first working source gives. Never throws — callers top
 * up from the local pool, so an offline machine still runs.
 */
export async function fetchTopics(count) {
  for (const provider of PROVIDERS) {
    try {
      const topics = await provider.fetch(count);
      log.info("topic source responded", { source: provider.name, count: topics.length });
      return { topics, source: provider.name };
    } catch (error) {
      log.warn("topic source failed", { source: provider.name, error: String(error) });
    }
  }
  log.warn("every topic source failed, falling back to the local pool");
  return { topics: [], source: "Local" };
}
