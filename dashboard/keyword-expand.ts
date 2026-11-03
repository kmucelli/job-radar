/**
 * Smart keyword expansion for Job Radar ad-hoc searches.
 *
 * Turns one typed query into the set of titles a human would consider the same
 * job. "network architect" also finds "network administrator"; "data center
 * engineer" also finds "DC ENGINEER"; "netwrok engineers" is read as "network
 * engineer"; "kubernetes" becomes "kubernetes engineer" plus its role family;
 * "netzwerkadministrator" is recognised as the network-engineering family.
 *
 * Deliberately dependency-free: the dashboard has no node_modules, so this uses
 * nothing but Bun/Node stdlib. All vocabulary lives in keyword-map.json.
 *
 * Scope: expansion is applied ONLY to ad-hoc searches. The daily scrape reads
 * its queries from config.json and is not affected — see scrape-daily.ts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;
const MAP_FILE = join(HERE, "keyword-map.json");
const CACHE_FILE = join(HERE, "data", "keyword-cache.json");

/** Hard ceiling on expansions per query. Each term becomes real HTTP traffic
 *  against every enabled portal, so this is a cost guard, not a style choice. */
export const MAX_EXPANSIONS = 12;

/** Version of the expansion logic. The dashboard keeps previews in the browser
 *  and refreshes the ones produced by an older engine. */
export const EXPAND_ENGINE = 2;

/** Native-language titles added per language, ON TOP of MAX_EXPANSIONS. Only
 *  the ones matching the run's scope are searched, so they do not multiply the
 *  cost of a run the way the English expansions do. */
export const MAX_TRANSLATIONS_PER_LANG = 2;

export type Lang = "pl" | "de" | "nl";
const LANGS: Lang[] = ["pl", "de", "nl"];
const LANG_NAME: Record<Lang, string> = { pl: "Polish", de: "German", nl: "Dutch" };

/** Native-language titles a search scope can use. EU remote is English-only. */
export function scopeLanguages(scope?: string): Lang[] {
  switch (String(scope ?? "").toUpperCase()) {
    case "PL": return ["pl"];
    case "DE": return ["de"];
    case "NL": return ["nl"];
    case "ALL": return [...LANGS];
    default: return [];
  }
}

export interface Expansion {
  term: string;
  /** Why this term was produced — surfaced in the UI so the list is auditable. */
  reason: string;
  source:
    | "original"
    | "correction"
    | "abbreviation"
    | "contraction"
    | "spelling"
    | "synonym"
    | "role"
    | "translation"
    | "vendor"
    | "llm";
  /** Set on translations: the market the title belongs to. */
  lang?: Lang;
}

export interface ExpandResult {
  query: string;
  normalized: string;
  terms: Expansion[];
  /** Flat list of search strings, original first. What the scraper consumes. */
  all: string[];
  /** True when English candidates were dropped by the cap. */
  truncated: boolean;
  engine: number;
}

interface SynonymGroup {
  _group: string;
  terms: string[];
  pl?: string[];
  de?: string[];
  nl?: string[];
}

interface KeywordMap {
  abbreviations: Record<string, string>;
  techAcronyms?: string[];
  contractions: Record<string, string>;
  spellings: Record<string, string[]>;
  modifiers: string[];
  roleNouns?: string[];
  certifications?: string[];
  synonyms: SynonymGroup[];
  _vendorHints: Record<string, string>;
  familyHints?: Record<string, string>;
}

let cachedMap: KeywordMap | null = null;

export function loadMap(): KeywordMap {
  if (cachedMap) return cachedMap;
  const raw = JSON.parse(readFileSync(MAP_FILE, "utf8"));
  cachedMap = raw as KeywordMap;
  return cachedMap;
}

const SPECIAL_LETTERS: Record<string, string> = {
  "ł": "l", "Ł": "L", "ß": "ss", "æ": "ae", "Æ": "AE", "ø": "o", "Ø": "O",
  "đ": "d", "Đ": "D", "œ": "oe", "Œ": "OE", "ı": "i", "þ": "th", "Þ": "TH",
};

/**
 * Fold accented letters to ASCII: "Inżynier" -> "Inzynier", "Łódź" -> "Lodz",
 * "Fördertechnik" -> "Fordertechnik". Letters are folded rather than dropped so
 * Polish/German queries stay readable and still pass the scraper's ASCII-only
 * argument filter. The dashboard search box (smart-filter.js) folds the same way.
 */
export function foldDiacritics(s: string): string {
  return String(s)
    .replace(/[łŁßæÆøØđĐœŒıþÞ]/g, (c) => SPECIAL_LETTERS[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, fold accents, strip punctuation, collapse whitespace. The single
 *  canonical form every comparison in this module runs against. */
export function normalize(s: string): string {
  return foldDiacritics(String(s))
    .toLowerCase()
    .replace(/[_/]/g, " ")
    .replace(/[^a-z0-9+#. -]/g, " ")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Make a user-supplied query safe to pass to the scraper. It is spawned with
 * shell:true on Windows, so anything outside a job-title charset is dropped
 * rather than escaped, and commas (the --queries delimiter) never survive.
 * Accents are folded first so "inżynier" arrives as "inzynier", not "in ynier".
 */
export function sanitizeQuery(s: string): string {
  return foldDiacritics(String(s))
    .replace(/[^A-Za-z0-9 +#./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Most terms one ad-hoc search may run. Every term is a full sweep of every
 *  enabled portal in every configured location (about 20 s of an "Everywhere"
 *  run), so 100 terms is already a search of roughly half an hour. */
export const MAX_ADHOC_QUERIES = 100;

/** Longest single term accepted; no job title needs more. */
const MAX_QUERY_CHARS = 80;

/**
 * The term list of an ad-hoc search, as the scraper will run it: sanitised,
 * de-duplicated (case-insensitively, first spelling wins) and never longer than
 * `max`. A longer list is refused, not cut. The dashboard's run button counts
 * every selected term, and the old silent cap of 25 meant that the expansions
 * of the first two keywords filled the list and later keywords never ran.
 */
export function adhocQueryList(
  raw: unknown,
  max = MAX_ADHOC_QUERIES,
): { queries: string[]; error?: string } {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "string") continue;
    const q = sanitizeQuery(item);
    const key = q.toLowerCase();
    if (!q || q.length > MAX_QUERY_CHARS || seen.has(key)) continue;
    seen.add(key);
    queries.push(q);
  }
  if (!queries.length) return { queries, error: "no usable queries" };
  if (queries.length > max) {
    return {
      queries: [],
      error:
        `${queries.length} search terms selected, but one search runs at most ${max}. ` +
        "Switch off related terms you do not need or remove a keyword, then search again.",
    };
  }
  return { queries };
}

/** Replace whole words only, so "dc" never matches inside "dcim". */
function replaceWord(hay: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return hay.replace(new RegExp(`(^|[\\s-])${esc}([\\s-]|$)`, "g"), `$1${to}$2`);
}

function hasWord(hay: string, word: string): boolean {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s-])${esc}([\\s-]|$)`).test(hay);
}

/** Words of a phrase, hyphens treated as spaces: "pre-sales" -> ["pre", "sales"]. */
function tokens(s: string): string[] {
  return normalize(s).split(/[\s-]+/).filter(Boolean);
}

function sameSeq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** True when `needle` appears in `hay` as consecutive whole words. */
function containsSeq(hay: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const STOP = new Set(["and", "of", "the", "for", "ds.", "ds", "&", "und", "en", "w", "i"]);

/** Word-overlap (Jaccard) between two phrases, ignoring filler words. */
function similarity(a: string[], b: string[]): number {
  const A = new Set(a.filter((t) => !STOP.has(t)));
  const B = new Set(b.filter((t) => !STOP.has(t)));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Optimal-string-alignment distance (insert, delete, substitute, swap), with an
 *  early exit once every path exceeds `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

interface PreparedGroup {
  name: string;
  terms: string[];
  native: Record<Lang, string[]>;
  /** English members and native titles, as words — what a query is matched against. */
  members: string[][];
}

interface Prepared {
  map: KeywordMap;
  /** Every word in keyword-map.json: the dictionary for typo and plural fixes. */
  vocab: Set<string>;
  roleNouns: Set<string>;
  /** Role nouns long enough to recognise inside compounds ("netzwerkadministrator"). */
  longRoleNouns: string[];
  /** Words that say nothing about the field (roles, seniority, filler). */
  generic: Set<string>;
  certs: Set<string>;
  tech: Set<string>;
  modifiers: string[];
  groups: PreparedGroup[];
  /** Every family member and native title, as space-joined words. */
  titles: Set<string>;
  /** [technology, family] from _vendorHints and familyHints. */
  hints: [string, string][];
}

let prepared: Prepared | null = null;

function prepare(): Prepared {
  if (prepared) return prepared;
  const map = loadMap();
  const vocab = new Set<string>();
  const addWords = (s: string) => {
    for (const w of tokens(s)) vocab.add(w);
  };

  for (const [k, v] of Object.entries(map.abbreviations ?? {})) { addWords(k); addWords(v); }
  for (const [k, v] of Object.entries(map.contractions ?? {})) { addWords(k); addWords(v); }
  for (const [k, vs] of Object.entries(map.spellings ?? {})) { addWords(k); vs.forEach(addWords); }
  (map.modifiers ?? []).forEach(addWords);
  (map.roleNouns ?? []).forEach(addWords);
  (map.certifications ?? []).forEach(addWords);

  const hints: [string, string][] = [];
  for (const source of [map._vendorHints ?? {}, map.familyHints ?? {}]) {
    for (const [token, group] of Object.entries(source)) {
      if (token.startsWith("_")) continue;
      hints.push([normalize(token), group]);
      addWords(token);
    }
  }

  const groups: PreparedGroup[] = map.synonyms.map((g) => {
    const native: Record<Lang, string[]> = {
      pl: (g.pl ?? []).map(normalize),
      de: (g.de ?? []).map(normalize),
      nl: (g.nl ?? []).map(normalize),
    };
    const everything = [...g.terms, ...native.pl, ...native.de, ...native.nl];
    everything.forEach(addWords);
    return { name: g._group, terms: g.terms.map(normalize), native, members: everything.map(tokens) };
  });

  const roleNouns = new Set((map.roleNouns ?? []).map(normalize));
  prepared = {
    map,
    vocab,
    roleNouns,
    longRoleNouns: [...roleNouns].filter((r) => r.length >= 6),
    generic: new Set([...roleNouns, ...(map.modifiers ?? []).flatMap(tokens), ...STOP]),
    certs: new Set((map.certifications ?? []).map(normalize)),
    tech: new Set((map.techAcronyms ?? []).map(normalize)),
    modifiers: (map.modifiers ?? []).map(normalize).sort((a, b) => b.length - a.length),
    groups,
    titles: new Set(groups.flatMap((g) => g.members.map((m) => m.join(" ")))),
    hints,
  };
  return prepared;
}

/** "engineers" -> "engineer"; "netwrok" -> "network". Only words that are not in
 *  the dictionary are touched, and only when exactly one fix is closest. */
function correctWord(word: string, ctx: Prepared): { to: string; why: "plural" | "typo" } | null {
  if (word.length < 4 || !/^[a-z]+$/.test(word) || ctx.vocab.has(word)) return null;
  if (word.endsWith("s") && ctx.vocab.has(word.slice(0, -1))) return { to: word.slice(0, -1), why: "plural" };
  if (word.endsWith("es") && ctx.vocab.has(word.slice(0, -2))) return { to: word.slice(0, -2), why: "plural" };

  const max = word.length >= 10 ? 2 : 1;
  let best = "";
  let bestDistance = max + 1;
  let tie = false;
  for (const v of ctx.vocab) {
    // Typos rarely hit the first letter; requiring it avoids "fixing" unrelated words.
    if (v[0] !== word[0] || v.length < 4 || !/^[a-z]+$/.test(v)) continue;
    const d = editDistance(word, v, max);
    if (d > max) continue;
    if (d < bestDistance) { best = v; bestDistance = d; tie = false; }
    else if (d === bestDistance) tie = true;
  }
  return best && !tie ? { to: best, why: "typo" } : null;
}

function correctQuery(norm: string, ctx: Prepared): { text: string; reason: string } | null {
  const notes: string[] = [];
  const words = norm.split(" ").map((w) => {
    const fix = correctWord(w, ctx);
    if (!fix) return w;
    notes.push(fix.why === "plural" ? `singular of "${w}"` : `did you mean "${fix.to}"?`);
    return fix.to;
  });
  return notes.length ? { text: words.join(" "), reason: notes.join(", ") } : null;
}

/** Spell out abbreviations. `titleOnly` skips the techAcronyms, whose long form
 *  is not how employers write a title. */
function expandAbbreviations(s: string, ctx: Prepared, titleOnly: boolean): { text: string; used: string[] } {
  let out = s;
  const used: string[] = [];
  for (const [abbr, full] of Object.entries(ctx.map.abbreviations ?? {})) {
    if (titleOnly && ctx.tech.has(abbr)) continue;
    if (!hasWord(out, abbr)) continue;
    out = replaceWord(out, abbr, full);
    used.push(`"${abbr}" = "${full}"`);
  }
  return { text: normalize(out), used };
}

/** Rewrite spelling variants to their canonical form: "data centre" -> "data center". */
function canonicalSpelling(s: string, ctx: Prepared): { text: string; used: string[] } {
  let out = s;
  const used: string[] = [];
  for (const [canonical, variants] of Object.entries(ctx.map.spellings ?? {})) {
    for (const v of [...variants].sort((a, b) => b.length - a.length)) {
      const nv = normalize(v);
      if (!out.includes(nv)) continue;
      out = out.replace(nv, canonical);
      used.push(`spelling of "${nv}"`);
    }
  }
  return { text: normalize(out), used };
}

/** Strip a seniority/qualifier so "senior network architect" matches the
 *  "network architect" family. Returns it, and where it was, for re-application. */
function splitModifier(q: string, modifiers: string[]): { modifier: string; base: string; position: "prefix" | "suffix" | "" } {
  for (const m of modifiers) {
    if (q === m) continue;
    if (q.startsWith(m + " ")) return { modifier: m, base: q.slice(m.length + 1).trim(), position: "prefix" };
    if (q.endsWith(" " + m)) return { modifier: m, base: q.slice(0, -(m.length + 1)).trim(), position: "suffix" };
  }
  return { modifier: "", base: q, position: "" };
}

/**
 * Which role families a query belongs to, and how strongly:
 *   3 = the query IS a member (or native title) of the family
 *   2 = the query CONTAINS a member as whole words ("cloud network engineer")
 *   1 = the query is a short topic inside a member ("devops" -> "devops engineer");
 *       only for queries that are not job titles themselves, so "network engineer"
 *       no longer pulls in every family that merely mentions it
 *       ("principal network engineer" in the architecture family).
 */
function matchGroups(seeds: string[], ctx: Prepared): { group: PreparedGroup; strength: number }[] {
  const hits: { group: PreparedGroup; strength: number }[] = [];
  const seedWords = seeds.map(tokens).filter((w) => w.length);
  for (const group of ctx.groups) {
    let strength = 0;
    for (const words of seedWords) {
      const isTitle = ctx.titles.has(words.join(" "));
      const topical = words.some((w) => !ctx.generic.has(w));
      for (const member of group.members) {
        if (sameSeq(words, member)) strength = Math.max(strength, 3);
        else if (containsSeq(words, member)) strength = Math.max(strength, 2);
        else if (!isTitle && topical && containsSeq(member, words)) strength = Math.max(strength, 1);
      }
    }
    if (strength) hits.push({ group, strength });
  }
  return hits;
}

/** Modifiers that read naturally when put back on a family title. */
const NOT_REAPPLIED = new Set(["head of"]);

/**
 * Expand a single query into related search terms.
 *
 * Every candidate gets a score — how sure we are it is the same job — and the
 * best MAX_EXPANSIONS are kept. The query as typed always comes first, so a run
 * still does exactly what the user typed even if every expansion is dropped.
 * `scope` limits the native-language titles to that market; omit it to get all
 * of them (the dashboard preview does, and filters by scope when it runs).
 */
export function expandQuery(query: string, opts: { max?: number; scope?: string } = {}): ExpandResult {
  const ctx = prepare();
  const max = opts.max ?? MAX_EXPANSIONS;
  const original = String(query).trim();
  const norm = normalize(original);
  if (!norm) {
    return { query: original, normalized: "", terms: [], all: [], truncated: false, engine: EXPAND_ENGINE };
  }

  const candidates = new Map<string, { e: Expansion; score: number; order: number }>();
  let order = 0;
  const offer = (term: string, score: number, reason: string, source: Expansion["source"]) => {
    const t = normalize(term);
    if (!t) return;
    const prev = candidates.get(t);
    if (!prev) {
      candidates.set(t, { e: { term: t, reason, source }, score, order: order++ });
    } else if (score > prev.score && prev.e.source !== "original") {
      prev.score = score;
      prev.e = { term: t, reason, source };
    }
  };

  offer(norm, 100, "as typed", "original");

  // --- 1. Typos and plurals ------------------------------------------------
  const fixed = correctQuery(norm, ctx);
  const working = fixed ? fixed.text : norm;
  if (fixed) offer(working, 95, fixed.reason, "correction");

  // --- 2. Abbreviations ----------------------------------------------------
  // "sr network eng" -> "senior network engineer" is the query the user meant.
  // Tech acronyms ("aci") still expand for matching, but their long form is a
  // poor search term, so it ranks low.
  const titleForm = expandAbbreviations(working, ctx, true);
  if (titleForm.used.length) offer(titleForm.text, 92, titleForm.used.join(", "), "abbreviation");
  const fullForm = expandAbbreviations(titleForm.text, ctx, false);
  if (fullForm.used.length) offer(fullForm.text, 45, fullForm.used.join(", "), "abbreviation");

  // --- 3. Canonical spelling -----------------------------------------------
  const canon = canonicalSpelling(titleForm.text, ctx);
  if (canon.used.length) offer(canon.text, 91, canon.used.join(", "), "spelling");
  const canonFull = canonicalSpelling(fullForm.text, ctx).text;

  // --- 4. Seniority --------------------------------------------------------
  const { modifier, base, position } = splitModifier(canon.text, ctx.modifiers);
  if (modifier) offer(base, 90, `without "${modifier}"`, "original");

  const seeds = Array.from(new Set([norm, working, titleForm.text, fullForm.text, canon.text, canonFull, base]));
  // Closeness is measured against what the user meant, not against spelled-out
  // tech acronyms: "cisco application centric infrastructure" would otherwise
  // make every "...infrastructure..." title look related to "cisco aci".
  const meantWords = Array.from(new Set([working, titleForm.text, canon.text, base])).map(tokens);
  const closeness = (term: string) => Math.max(0, ...meantWords.map((w) => similarity(tokens(term), w)));

  // --- 5. Contractions, allowlisted ----------------------------------------
  for (const s of new Set([canon.text, base])) {
    for (const [full, abbr] of Object.entries(ctx.map.contractions ?? {})) {
      if (s.includes(full)) offer(s.replace(full, abbr), 50, `"${full}" = "${abbr}"`, "contraction");
    }
  }

  // --- 6. Role families ----------------------------------------------------
  const hits = matchGroups(seeds, ctx);
  const BASE_SCORE: Record<number, number> = { 3: 60, 2: 45, 1: 35 };
  for (const { group, strength } of hits) {
    for (const t of group.terms) offer(t, BASE_SCORE[strength] + 20 * closeness(t), `same family: ${group.name}`, "synonym");
  }

  // --- 7. Technology / certification hints, only when no family matched ----
  const hintGroups: PreparedGroup[] = [];
  if (!hits.length) {
    for (const [token, groupName] of ctx.hints) {
      if (!seeds.some((s) => hasWord(s, token))) continue;
      const group = ctx.groups.find((g) => g.name === groupName);
      if (!group) continue;
      if (!hintGroups.includes(group)) hintGroups.push(group);
      for (const t of group.terms) offer(t, 30 + 20 * closeness(t), `"${token}" implies ${groupName}`, "vendor");
    }
  }

  // --- 8. A bare topic becomes a title -------------------------------------
  // "kubernetes" -> "kubernetes engineer". Not for certifications ("ccie
  // engineer" is not a posting) or when the query already holds a full title.
  const baseWords = tokens(base);
  const hasRole = baseWords.some((w) => ctx.roleNouns.has(w) || ctx.longRoleNouns.some((r) => w.endsWith(r)));
  const topical = baseWords.some((w) => !ctx.generic.has(w));
  const hasCert = baseWords.some((w) => ctx.certs.has(w));
  if (!hasRole && topical && !hasCert && !hits.some((h) => h.strength >= 2)) {
    offer(`${base} engineer`, 70, `"${base}" as a job title`, "role");
  }

  // --- 9. Spelling variants of what we have (low priority) -----------------
  // Below every distinct title: a second spelling of one title finds less than
  // a different title would, so it only fills slots that are left over.
  for (const c of Array.from(candidates.values())) {
    for (const [canonical, variants] of Object.entries(ctx.map.spellings ?? {})) {
      if (!c.e.term.includes(canonical)) continue;
      for (const v of variants) offer(c.e.term.replace(canonical, normalize(v)), Math.min(c.score, 40) - 15, `spelling of "${canonical}"`, "spelling");
    }
  }

  // --- 10. Keep the user's seniority on the family titles ------------------
  // "senior network engineer" should search "senior network administrator",
  // not the bare title, which the cap would otherwise prefer.
  if (modifier && !NOT_REAPPLIED.has(modifier)) {
    const isQualified = (t: string) => ctx.modifiers.some((m) => t === m || t.startsWith(m + " ") || t.endsWith(" " + m));
    for (const c of Array.from(candidates.values())) {
      if (!["synonym", "vendor", "role"].includes(c.e.source) || isQualified(c.e.term)) continue;
      const qualified = position === "suffix" ? `${c.e.term} ${modifier}` : `${modifier} ${c.e.term}`;
      offer(qualified, c.score + 1, `${c.e.reason} (+ "${modifier}")`, c.e.source);
      c.score -= 15;
    }
  }

  // --- 11. Rank, then cap --------------------------------------------------
  const ranked = Array.from(candidates.values()).sort((a, b) => b.score - a.score || a.order - b.order);
  const kept = ranked.slice(0, max).map((c) => c.e);

  // --- 12. Native-language titles, outside the cap -------------------------
  const langs = opts.scope === undefined ? LANGS : scopeLanguages(opts.scope);
  const families = [...hits].sort((a, b) => b.strength - a.strength).map((h) => h.group).concat(hintGroups);
  const taken = new Set(kept.map((e) => e.term));
  const native: Expansion[] = [];
  for (const lang of langs) {
    let added = 0;
    for (const group of families) {
      for (const term of group.native[lang]) {
        if (added >= MAX_TRANSLATIONS_PER_LANG) break;
        if (taken.has(term)) continue;
        taken.add(term);
        added++;
        native.push({ term, reason: `${LANG_NAME[lang]} title (${group.name})`, source: "translation", lang });
      }
    }
  }

  const terms = [...kept, ...native];
  return {
    query: original,
    normalized: norm,
    terms,
    all: terms.map((t) => t.term),
    truncated: ranked.length > max,
    engine: EXPAND_ENGINE,
  };
}

/** Expand several queries and merge, preserving order and removing duplicates. */
export function expandMany(queries: string[], opts: { max?: number; scope?: string } = {}): ExpandResult[] {
  const seen = new Set<string>();
  const results: ExpandResult[] = [];
  for (const q of queries) {
    const r = expandQuery(q, opts);
    r.terms = r.terms.filter((t) => !seen.has(t.term));
    r.terms.forEach((t) => seen.add(t.term));
    r.all = r.terms.map((t) => t.term);
    results.push(r);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Optional LLM enrichment.
//
// Off unless an API key is present. Results are cached to disk permanently so
// the same query never costs twice, and a failure degrades to the offline map
// rather than breaking the search.
// ---------------------------------------------------------------------------

function readCache(): Record<string, string[]> {
  try {
    return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeCache(c: Record<string, string[]>) {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch {
    /* cache is an optimisation; failing to persist must not break a search */
  }
}

export function llmAvailable(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY);
}

/**
 * Ask an LLM for extra title variants. Returns [] when no key is configured,
 * on any network/parse error, or on a non-200 — never throws.
 */
export async function llmExpand(query: string, max = 8): Promise<string[]> {
  const key = normalize(query);
  const cache = readCache();
  if (cache[key]) return cache[key];
  if (!llmAvailable()) return [];

  const prompt =
    `List up to ${max} alternative job titles that an employer might use for a role ` +
    `equivalent to "${query}", in IT networking/data centre/infrastructure. ` +
    `Include common abbreviations and regional variants. ` +
    `Reply with ONLY a JSON array of lowercase strings, no prose.`;

  try {
    let text = "";
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-latest",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return [];
      text = (await r.json())?.content?.[0]?.text ?? "";
    } else {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 300,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return [];
      text = (await r.json())?.choices?.[0]?.message?.content ?? "";
    }

    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    const clean = arr.map(normalize).filter(Boolean).slice(0, max);
    cache[key] = clean;
    writeCache(cache);
    return clean;
  } catch {
    return [];
  }
}

/** Offline expansion, optionally topped up by the LLM. Native-language titles
 *  stay last and do not count against the cap. */
export async function expandQuerySmart(
  query: string,
  opts: { max?: number; useLlm?: boolean; scope?: string } = {},
): Promise<ExpandResult> {
  const base = expandQuery(query, opts);
  if (!opts.useLlm || !llmAvailable()) return base;

  const max = opts.max ?? MAX_EXPANSIONS;
  const offline = base.terms.filter((t) => t.source !== "translation");
  const native = base.terms.filter((t) => t.source === "translation");
  const have = new Set(base.all);
  for (const t of await llmExpand(query)) {
    if (offline.length >= max) break;
    if (have.has(t)) continue;
    have.add(t);
    offline.push({ term: t, reason: "AI suggestion", source: "llm" });
  }
  base.terms = [...offline, ...native];
  base.all = base.terms.map((t) => t.term);
  return base;
}
