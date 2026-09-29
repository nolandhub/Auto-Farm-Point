import { defaultRng } from "./pacing.js";

/**
 * Fallback topics. Deliberately phrased the way a person types, and entirely
 * free of digits — v2.4 appended a random number to every fallback
 * ("Technology 473"), which is the single clearest bot signature it emitted.
 */
export const LOCAL_POOL = [
  "photosynthesis", "machine learning", "black hole", "roman empire", "deep sea creatures",
  "sourdough starter", "northern lights", "quantum entanglement", "great barrier reef",
  "silk road history", "renewable energy", "espresso brewing", "mount everest climbers",
  "artificial neural networks", "coral bleaching", "ancient egypt pyramids", "jazz improvisation",
  "mediterranean diet", "solar eclipse", "venice canals", "antarctic ice sheet", "bee colony collapse",
  "origami techniques", "volcanic eruption", "migratory birds", "tea ceremony", "sleep cycles",
  "electric vehicles", "gothic architecture", "amazon rainforest", "chess openings",
  "human microbiome", "wind turbines", "samurai armour", "coffee regions", "desert ecosystems",
  "mars rover", "printing press", "glacier retreat", "spice trade", "tidal energy",
  "bird migration routes", "fermentation science", "mountain weather", "urban planning",
  "vaccine development", "ocean currents", "medieval castles", "circadian rhythm",
  "bamboo construction", "wildfire management", "string theory", "monsoon season",
  "bridge engineering", "lunar phases", "olive oil production", "arctic wildlife",
  "cave paintings", "hydroponic farming", "typography history", "plate tectonics",
  "whale songs", "roman aqueducts", "noise pollution", "seed banks", "geothermal heating",
  "paper making", "desert irrigation", "bird nesting habits", "steel production",
  "mangrove forests", "nordic design", "rain shadow effect", "honey harvesting",
  "submarine cables", "clock making", "soil erosion", "peat bogs", "textile dyeing",
  "lighthouse keepers", "avalanche safety", "cheese ageing", "river deltas",
  "wool spinning", "meteor showers", "salt flats", "canal locks", "moss species",
  "wind erosion", "island biogeography", "tide pools", "bread baking", "forest canopy",
  "stone masonry", "dune formation", "kelp forests", "pollination", "glass blowing",
  "permafrost thaw", "boat building", "cloud formation", "herbal medicine", "cartography",
];

/** Natural ways a person rephrases a bare topic. */
const TEMPLATES = [
  (q) => q,
  (q) => `what is ${q}`,
  (q) => `${q} explained`,
  (q) => `${q} history`,
  (q) => `how does ${q} work`,
  (q) => `${q} facts`,
];

const REJECT_PATTERNS = [
  /^(list|index|outline|timeline|glossary|bibliography|history) of\b/i,
  /^[a-z]+:/i,               // Wikipedia namespaces: Category:, Template:, File:
  /^\d{4}\b/,                // "2013 in Norwegian football" and friends
  /^[\d\s.,-]+$/,            // bare numbers
  /\s\d+$/,                  // the v2.4 "Topic 473" signature
  /\(\s*\)/,
];

/**
 * Normalises one raw title, or returns null if it would read as scraped.
 * Rejecting a few legitimate titles ("Apollo 11") is free — there is always
 * another topic — while letting one through costs a recognisable pattern.
 */
export function sanitize(raw) {
  if (typeof raw !== "string") return null;

  let value = raw.replace(/\s+/g, " ").trim();
  if (!value) return null;

  // "Mercury (planet)" reads better as "Mercury"; "(hello)" has nothing else.
  const stripped = value.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (stripped) value = stripped;

  if (value.length < 3 || value.length > 80) return null;
  if (REJECT_PATTERNS.some((re) => re.test(value))) return null;
  return value;
}

export function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function naturalize(query, rng = defaultRng) {
  return TEMPLATES[Math.floor(rng() * TEMPLATES.length)](query);
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Builds exactly `count` search terms from whatever the network returned,
 * topping up from the local pool. Every template variant of every pool entry
 * is a distinct candidate, so uniqueness survives counts far beyond the pool.
 */
export function prepare(rawList, count, rng = defaultRng) {
  const fromSource = dedupe(
    (rawList ?? []).map(sanitize).filter(Boolean).map((q) => naturalize(q, rng))
  );
  if (fromSource.length >= count) return fromSource.slice(0, count);

  const filler = shuffle(
    dedupe(TEMPLATES.flatMap((tpl) => LOCAL_POOL.map((topic) => tpl(topic)))),
    rng
  );

  const out = dedupe([...fromSource, ...filler]).slice(0, count);

  // Only reachable if count exceeds every unique candidate; repeat rather than
  // return short, since a short list would silently truncate the run.
  for (let i = 0; out.length < count; i++) {
    out.push(filler[i % filler.length]);
  }
  return out;
}
