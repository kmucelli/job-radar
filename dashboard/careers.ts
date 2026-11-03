/**
 * careers.ts — job postings straight from employers' own career sites.
 *
 * Job boards only carry what a company chooses to advertise there; large
 * employers publish most openings on their own career site alone. Nearly all of
 * those sites run on an applicant-tracking system (ATS) with a public JSON feed,
 * so one adapter per ATS covers every company on it. The companies live in
 * companies.json: id, name, sector, the ATS and the parameters it needs.
 *
 * Per run, each company's Polish postings are listed once (kept on disk for
 * LIST_TTL_MS, so ad-hoc searches during the day reuse the morning's list),
 * matched against the run's queries by title, and only the matches get their
 * full advert read: the scorer needs the text to judge relevance, and reading
 * every advert would multiply the traffic for postings that are thrown away.
 *
 * robots.txt is honoured per host at run time; a company whose feed it disallows
 * is skipped and reported. Checked 2026-11-03:
 *   workday     <tenant>.wdN.myworkdayjobs.com/wday/cxs/…           allowed (only /refreshFacet/ is not)
 *   greenhouse  boards-api.greenhouse.io/v1/boards/<board>/jobs       allowed (only /embed/ is not)
 *   lever       api.lever.co, api.eu.lever.co /v0/postings/<board>    allowed
 *   oracle      <pod>.fa.<dc>.oraclecloud.com/hcmRestApi/…            robots.txt answers 403 = no rules (RFC 9309)
 *   amazon      www.amazon.jobs/en/search.json                        allowed (only /internal is not)
 *   teamtailor  <career site>/jobs.rss                                allowed (checked per site at run time)
 *   workable    apply.workable.com/api/v1/widget/accounts/<board>      allowed (empty Disallow)
 * Not usable: SmartRecruiters and eRecruiter (robots.txt disallows their feeds),
 * Google Careers (robots.txt disallows its job search). Also not covered: SAP
 * SuccessFactors, Avature, Taleo, iCIMS and in-house sites (no public feed), and
 * Ashby, whose API host fails TLS verification behind this network's proxy.
 *
 *   bun run careers [--file companies.json] [--id a,b] [--query "network engineer"] [--days 30] [--fresh]
 *   (package script for `bun run careers.ts --probe …`, run in the dashboard folder)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEntities, fold, htmlToText, request, toIso, withinDays, type RawJob, type SourceResult } from "./sources.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "data");
export const COMPANIES_FILE = join(HERE, "companies.json");
/** Same folder layout and entry shape as the other advert caches (sha1(url).json). */
export const ADVERT_DIR = join(DATA, "cache", "careers");
const LIST_DIR = join(DATA, "cache", "careers-list");

/** How long one company's list of Polish postings is reused before it is fetched again. */
export const LIST_TTL_MS = 6 * 3600_000;
/** Adverts read per company per run; the rest keep their listing text until a later run. */
const MAX_ADVERTS_PER_COMPANY = 30;
/** Workday serves 20 postings per page; 60 pages is 1,200 Polish postings, far above any one employer. */
const WORKDAY_MAX_PAGES = 60;
const ORACLE_PAGE = 25;
const ORACLE_MAX_PAGES = 40;
const AMAZON_PAGE = 100;
const AMAZON_MAX_PAGES = 10;
const UA_TOKEN = "job-radar";

export const ATS_KINDS = ["workday", "greenhouse", "lever", "oracle", "amazon", "teamtailor", "workable"] as const;
export type Ats = (typeof ATS_KINDS)[number];

export interface Company {
  /** Stable slug, used for cache files and --id. */
  id: string;
  name: string;
  /** e.g. "IT services", "Banking", "Telecom". */
  sector: string;
  /** Polish company or a foreign one with a Polish office. */
  origin: "polish" | "foreign";
  ats: Ats;
  /** workday: <tenant>.wdN.myworkdayjobs.com; oracle: <pod>.fa.<dc>.oraclecloud.com */
  host?: string;
  /** workday: the tenant in /wday/cxs/<tenant>/<site>/jobs */
  tenant?: string;
  /** workday: the career-site name; oracle: the site number (CX_…) */
  site?: string;
  /** greenhouse: board token; lever and workable: account name */
  board?: string;
  /** lever: "eu" for accounts served from api.eu.lever.co */
  region?: "eu";
  /** teamtailor: the career site's RSS feed, e.g. https://jobs.codilime.com/jobs.rss */
  feed?: string;
  /** The careers page people visit; documentation only. */
  careersUrl: string;
  enabled?: boolean;
  note?: string;
}

/** One Polish posting as a career site lists it, before its advert is read. */
export interface Listing {
  id: string;
  title: string;
  url: string;
  location: string;
  date: string | null;
  description: string;
  remote: boolean;
  /** Where the full advert lives, for sites whose list carries none. */
  detail?: string;
}

export interface CompanyReport {
  id: string;
  name: string;
  listed: number;
  matched: number;
  adverts: number;
  cached: boolean;
  error?: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Country names and the cities employers hire in, accent-folded, matched as whole words. */
const PL_WORDS = [
  "poland", "polska", "polen", "pologne", "polonia",
  "warsaw", "warszawa", "krakow", "cracow", "wroclaw", "gdansk", "gdynia", "sopot", "poznan", "lodz",
  "katowice", "gliwice", "szczecin", "lublin", "bydgoszcz", "rzeszow", "bialystok", "kielce", "opole",
  "torun", "olsztyn", "bielsko-biala", "czestochowa", "radom", "tychy", "sosnowiec", "plock", "legnica",
];
const PL_WORD_RE = new RegExp(`(^|[^a-z])(${PL_WORDS.join("|")})([^a-z]|$)`);
/** "Remote (PL)", "Gdansk, Pomeranian Voivodeship, POL": the country code on its own. */
const PL_CODE_RE = /(^|[\s,(/-])(PL|POL)($|[\s,)/-])/;

/** True when a location string names Poland or a Polish city. "Annapolis" and "Napoli" do not count. */
export function isPolishLocation(text: string): boolean {
  const s = String(text ?? "");
  return PL_WORD_RE.test(fold(s)) || PL_CODE_RE.test(s);
}

const wordsOf = (s: string) => fold(s).split(/[^a-z0-9+#]+/).filter(Boolean);

/**
 * Every word of the query starts a word of the title, in any order: "network
 * engineer" finds "Senior Network Engineer" and "Engineer, Networking". Words of
 * two letters or fewer must match whole, so "it" does not find "Italian".
 */
export function titleMatches(title: string, query: string): boolean {
  const q = wordsOf(query);
  if (!q.length) return false;
  const t = wordsOf(title);
  return q.every((w) => t.some((x) => (w.length <= 2 ? x === w : x.startsWith(w))));
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309)
// ---------------------------------------------------------------------------

function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${re}${anchored ? "$" : ""}`).test(path);
}

/**
 * Whether robots.txt lets `agent` fetch `path` (path plus query string). The
 * groups naming the agent apply, else the "*" groups; the longest matching rule
 * wins and Allow wins a tie. An empty Disallow allows everything.
 */
export function robotsAllows(robotsTxt: string, path: string, agent = UA_TOKEN): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let group: (typeof groups)[number] | null = null;
  let inAgentLines = false;
  for (const raw of String(robotsTxt ?? "").split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, "").trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!group || !inAgentLines) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(value.toLowerCase());
      inAgentLines = true;
      continue;
    }
    inAgentLines = false;
    if ((key === "allow" || key === "disallow") && group && value) group.rules.push({ allow: key === "allow", path: value });
  }
  const own = groups.filter((g) => g.agents.includes(agent));
  const rules = (own.length ? own : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best: { allow: boolean; path: string } | null = null;
  for (const r of rules) {
    if (!patternMatches(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** robots.txt per origin for this process: text, null (no rules: 4xx) or undefined (unreachable: 5xx/network). */
const robotsCache = new Map<string, Promise<string | null | undefined>>();

async function fetchRobots(origin: string): Promise<string | null | undefined> {
  try {
    const r = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": `${UA_TOKEN}/1.0 (personal use)`, Accept: "text/plain, */*" },
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return await r.text();
    return r.status >= 400 && r.status < 500 ? null : undefined;
  } catch {
    return undefined;
  }
}

/** Throws when robots.txt disallows `url` or cannot be read (RFC 9309: unreachable means disallow all). */
async function assertRobotsAllow(url: string): Promise<void> {
  const u = new URL(url);
  let pending = robotsCache.get(u.origin);
  if (!pending) robotsCache.set(u.origin, (pending = fetchRobots(u.origin)));
  const txt = await pending;
  if (txt === undefined) throw new Error(`robots.txt of ${u.host} unreachable`);
  if (txt !== null && !robotsAllows(txt, u.pathname + u.search)) throw new Error(`robots.txt of ${u.host} disallows ${u.pathname}`);
}
// ---------------------------------------------------------------------------
// Workday — POST /wday/cxs/<tenant>/<site>/jobs, 20 postings per page
// ---------------------------------------------------------------------------

/**
 * The location facet to filter on, read from a tenant's own facet list. Some
 * tenants have a country facet ("Poland"); others only list cities ("Krakow,
 * Poland", "Poland, Gdansk", "BIG - Zielinskiego Krakow"), sometimes nested one
 * level down. A country value wins; otherwise the facet whose Polish values
 * cover the most postings, with all of those values (Workday ORs within a facet).
 */
export function workdayPolandFacet(facets: any[]): { param: string; ids: string[] } | null {
  const groups = new Map<string, { ids: string[]; count: number; country: string[] }>();
  const walk = (list: any[]) => {
    for (const f of list ?? []) {
      for (const v of f?.values ?? []) {
        if (v?.facetParameter && Array.isArray(v.values)) {
          walk([v]);
          continue;
        }
        const d = String(v?.descriptor ?? "").trim();
        if (!v?.id || !isPolishLocation(d)) continue;
        const g = groups.get(f.facetParameter) ?? { ids: [], count: 0, country: [] };
        if (/^(poland|polska)$/i.test(d)) g.country.push(v.id);
        if (!g.ids.includes(v.id)) g.ids.push(v.id);
        g.count += Number(v.count) || 0;
        groups.set(f.facetParameter, g);
      }
    }
  };
  walk(facets);
  for (const [param, g] of groups) if (g.country.length) return { param, ids: g.country };
  let best: { param: string; ids: string[]; count: number } | null = null;
  for (const [param, g] of groups) if (!best || g.count > best.count) best = { param, ids: g.ids, count: g.count };
  return best && { param: best.param, ids: best.ids };
}

/** "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → an ISO date. */
export function workdayPostedDate(postedOn: unknown, now = Date.now()): string | null {
  const s = fold(String(postedOn ?? ""));
  const days = /today/.test(s) ? 0 : /yesterday/.test(s) ? 1 : Number(s.match(/(\d+)\+?\s*days?\s+ago/)?.[1] ?? NaN);
  return Number.isFinite(days) ? new Date(now - days * 86_400_000).toISOString() : null;
}

export function mapWorkday(c: Company, postings: any[], now = Date.now()): Listing[] {
  return (postings ?? [])
    .filter((p) => p?.externalPath && p?.title)
    .map((p) => {
      const where = String(p.locationsText ?? "");
      return {
        id: String(p.bulletFields?.[0] ?? p.externalPath),
        title: String(p.title).trim(),
        url: `https://${c.host}/${c.site}${p.externalPath}`,
        // "2 Locations": the facet guarantees one of them is Polish.
        location: /^\d+\s+locations?$/i.test(where) ? `Poland (${where.toLowerCase()})` : where,
        date: workdayPostedDate(p.postedOn, now),
        description: "",
        remote: /remote/i.test(String(p.remoteType ?? where)),
        detail: String(p.externalPath),
      };
    });
}

async function listWorkday(c: Company, gapMs: number): Promise<Listing[]> {
  const api = `https://${c.host}/wday/cxs/${c.tenant}/${c.site}/jobs`;
  await assertRobotsAllow(api);
  const post = async (appliedFacets: Record<string, string[]>, offset: number) => {
    const r = await request(api, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ appliedFacets, limit: 20, offset, searchText: "" }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(r.text);
  };
  const facet = workdayPolandFacet((await post({}, 0)).facets ?? []);
  if (!facet) return []; // the site lists no Polish location right now
  const out: Listing[] = [];
  let total = Infinity;
  for (let page = 0; page < WORKDAY_MAX_PAGES && page * 20 < total; page++) {
    await sleep(gapMs);
    const j = await post({ [facet.param]: facet.ids }, page * 20);
    // Workday reports the total on the first page only.
    if (page === 0) total = Number(j.total) || 0;
    const batch = mapWorkday(c, j.jobPostings ?? []);
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
}

async function workdayAdvert(c: Company, l: Listing): Promise<Partial<Listing>> {
  const r = await request(`https://${c.host}/wday/cxs/${c.tenant}/${c.site}${l.detail}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const info = JSON.parse(r.text).jobPostingInfo ?? {};
  const places = [info.location, ...(info.additionalLocations ?? [])].filter(Boolean).map(String);
  const polish = places.filter(isPolishLocation);
  return {
    description: htmlToText(info.jobDescription ?? ""),
    date: toIso(info.startDate) ?? l.date,
    location: (polish.length ? polish : places).join(" / ") || l.location,
    remote: l.remote || /remote/i.test(String(info.remoteType ?? "")),
  };
}

// ---------------------------------------------------------------------------
// Greenhouse — GET boards-api.greenhouse.io/v1/boards/<board>/jobs?content=true
// ---------------------------------------------------------------------------

export function mapGreenhouse(json: any): Listing[] {
  return (json?.jobs ?? [])
    .filter((j: any) => j?.absolute_url && j?.title)
    .filter((j: any) =>
      isPolishLocation([j.location?.name, ...(j.offices ?? []).flatMap((o: any) => [o?.name, o?.location])].filter(Boolean).join(" | ")),
    )
    .map((j: any) => ({
      id: String(j.id),
      title: String(j.title).trim(),
      url: String(j.absolute_url),
      location: String(j.location?.name ?? ""),
      date: toIso(j.first_published ?? j.updated_at),
      // `content` is HTML with its markup entity-escaped.
      description: htmlToText(decodeEntities(j.content ?? "")),
      remote: /remote/i.test(String(j.location?.name ?? "")),
    }));
}

async function listGreenhouse(c: Company): Promise<Listing[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(c.board ?? "")}/jobs?content=true`;
  await assertRobotsAllow(url);
  const r = await request(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return mapGreenhouse(JSON.parse(r.text));
}

// ---------------------------------------------------------------------------
// Lever — GET api[.eu].lever.co/v0/postings/<board>?mode=json
// ---------------------------------------------------------------------------

export function mapLever(json: any): Listing[] {
  return (Array.isArray(json) ? json : [])
    .filter((p: any) => p?.hostedUrl && p?.text)
    .filter((p: any) => p.country === "PL" || isPolishLocation([p.categories?.location, ...(p.categories?.allLocations ?? [])].filter(Boolean).join(" | ")))
    .map((p: any) => ({
      id: String(p.id),
      title: String(p.text).trim(),
      url: String(p.hostedUrl),
      location: (p.categories?.allLocations?.length ? p.categories.allLocations : [p.categories?.location]).filter(Boolean).join(" / "),
      date: toIso(p.createdAt),
      description: [p.descriptionPlain, ...(p.lists ?? []).map((l: any) => `${l?.text ?? ""}: ${htmlToText(l?.content ?? "")}`), p.additionalPlain]
        .filter(Boolean)
        .join("\n"),
      remote: p.workplaceType === "remote",
    }));
}

async function listLever(c: Company): Promise<Listing[]> {
  const url = `https://api${c.region === "eu" ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(c.board ?? "")}?mode=json`;
  await assertRobotsAllow(url);
  const r = await request(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return mapLever(JSON.parse(r.text));
}
// ---------------------------------------------------------------------------
// Oracle Recruiting Cloud — GET /hcmRestApi/resources/latest/recruitingCEJobRequisitions
// ---------------------------------------------------------------------------

export function mapOracle(c: Company, requisitions: any[]): Listing[] {
  return (requisitions ?? [])
    .filter((q) => q?.Id && q?.Title)
    .filter(
      (q) =>
        q.PrimaryLocationCountry === "PL" ||
        isPolishLocation(String(q.PrimaryLocation ?? "")) ||
        (q.secondaryLocations ?? []).some((s: any) => s?.CountryCode === "PL" || isPolishLocation(String(s?.Name ?? ""))),
    )
    .map((q) => ({
      id: String(q.Id),
      title: String(q.Title).trim(),
      url: `https://${c.host}/hcmUI/CandidateExperience/en/sites/${c.site}/job/${q.Id}`,
      location: String(q.PrimaryLocation ?? ""),
      date: toIso(q.PostedDate),
      description: htmlToText([q.ShortDescriptionStr, q.ExternalResponsibilitiesStr, q.ExternalQualificationsStr].filter(Boolean).join("\n")),
      remote: /remote/i.test(String(q.WorkplaceType ?? "")),
      detail: String(q.Id),
    }));
}

async function listOracle(c: Company, gapMs: number): Promise<Listing[]> {
  const base = `https://${c.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;
  await assertRobotsAllow(base);
  const out: Listing[] = [];
  let total = Infinity;
  for (let page = 0; page < ORACLE_MAX_PAGES && page * ORACLE_PAGE < total; page++) {
    if (page) await sleep(gapMs);
    // location=Poland is the site's own country search; the facet list is truncated to the top locations.
    const url = `${base}?onlyData=true&expand=requisitionList.secondaryLocations&finder=findReqs;siteNumber=${c.site},location=Poland,limit=${ORACLE_PAGE},offset=${page * ORACLE_PAGE}`;
    const r = await request(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const item = JSON.parse(r.text).items?.[0] ?? {};
    if (page === 0) total = Number(item.TotalJobsCount) || 0;
    const reqs = item.requisitionList ?? [];
    if (!reqs.length) break;
    out.push(...mapOracle(c, reqs));
  }
  return out;
}

async function oracleAdvert(c: Company, l: Listing): Promise<Partial<Listing>> {
  const url = `https://${c.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${l.detail}%22,siteNumber=${c.site}`;
  const r = await request(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = JSON.parse(r.text).items?.[0] ?? {};
  const text = htmlToText([d.ExternalDescriptionStr, d.ExternalResponsibilitiesStr, d.ExternalQualificationsStr].filter(Boolean).join("\n"));
  return text ? { description: text } : {};
}

// ---------------------------------------------------------------------------
// Amazon — GET www.amazon.jobs/en/search.json, its own career site
// ---------------------------------------------------------------------------

export function mapAmazon(json: any): Listing[] {
  return (json?.jobs ?? [])
    .filter((j: any) => j?.job_path && j?.title)
    .map((j: any) => ({
      id: String(j.id_icims ?? j.id),
      title: String(j.title).trim(),
      url: `https://www.amazon.jobs${j.job_path}`,
      location: String(j.normalized_location ?? j.location ?? ""),
      date: toIso(j.posted_date),
      description: htmlToText([j.description, j.basic_qualifications, j.preferred_qualifications].filter(Boolean).join("\n")),
      remote: false,
    }));
}

async function listAmazon(gapMs: number): Promise<Listing[]> {
  const base = "https://www.amazon.jobs/en/search.json";
  await assertRobotsAllow(base);
  const out: Listing[] = [];
  let total = Infinity;
  for (let page = 0; page < AMAZON_MAX_PAGES && page * AMAZON_PAGE < total; page++) {
    if (page) await sleep(gapMs);
    const r = await request(`${base}?normalized_country_code%5B%5D=POL&result_limit=${AMAZON_PAGE}&offset=${page * AMAZON_PAGE}&sort=recent`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(r.text);
    if (page === 0) total = Number(j.hits) || 0;
    const batch = mapAmazon(j);
    if (!batch.length) break;
    out.push(...batch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Teamtailor — the career site's own RSS feed (<site>/jobs.rss)
// ---------------------------------------------------------------------------

/** Inner text of every <name>…</name> in an XML fragment, CDATA unwrapped and entities decoded. */
function xmlAll(xml: string, name: string): string[] {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g");
  return [...String(xml ?? "").matchAll(re)].map((m) =>
    decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1")).trim(),
  );
}
const xmlOne = (xml: string, name: string) => xmlAll(xml, name)[0] ?? "";

export function parseTeamtailorRss(xml: string): Listing[] {
  // A wrong feed URL often redirects to the HTML careers page, which would read as "no jobs".
  if (!/<rss[\s>]|<channel[\s>]/i.test(String(xml ?? ""))) throw new Error("not an RSS feed");
  return String(xml ?? "")
    .split("<item>")
    .slice(1)
    .map((item) => ({
      item,
      places: xmlAll(item, "tt:location").map((loc) =>
        [xmlOne(loc, "tt:city"), xmlOne(loc, "tt:country") || xmlOne(loc, "tt:name")].filter(Boolean).join(", "),
      ),
    }))
    .filter(({ places }) => places.some(isPolishLocation))
    .map(({ item, places }) => ({
      id: xmlOne(item, "guid") || xmlOne(item, "link"),
      title: xmlOne(item, "title"),
      url: xmlOne(item, "link"),
      location: [...new Set(places.filter(isPolishLocation))].join(" / "),
      date: toIso(xmlOne(item, "pubDate")),
      description: htmlToText(xmlOne(item, "description")),
      remote: /fully/i.test(xmlOne(item, "remoteStatus")),
    }))
    .filter((l) => l.title && l.url);
}

async function listTeamtailor(c: Company): Promise<Listing[]> {
  const url = String(c.feed);
  await assertRobotsAllow(url);
  const r = await request(url, { headers: { Accept: "application/rss+xml, application/xml" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseTeamtailorRss(r.text);
}

// ---------------------------------------------------------------------------
// Workable — GET apply.workable.com/api/v1/widget/accounts/<board>?details=true
// ---------------------------------------------------------------------------

const workablePolish = (l: any) => l?.countryCode === "PL" || isPolishLocation(String(l?.city ?? ""));

export function mapWorkable(json: any): Listing[] {
  return (json?.jobs ?? [])
    .filter((j: any) => j?.title && (j.url || j.shortlink))
    .filter((j: any) => (j.locations ?? []).some(workablePolish) || j.country === "Poland" || isPolishLocation(String(j.city ?? "")))
    .map((j: any) => {
      const polish = (j.locations ?? []).filter(workablePolish);
      const places = polish.length ? polish : [{ city: j.city, country: j.country }];
      return {
        id: String(j.shortcode ?? j.url),
        title: String(j.title).trim(),
        url: String(j.url ?? j.shortlink),
        location: [...new Set(places.map((l: any) => [l.city, l.country].filter(Boolean).join(", ")))].join(" / "),
        date: toIso(j.published_on ?? j.created_at),
        description: htmlToText(j.description ?? ""),
        remote: Boolean(j.telecommuting),
      };
    });
}

async function listWorkable(c: Company): Promise<Listing[]> {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(c.board ?? "")}?details=true`;
  await assertRobotsAllow(url);
  const r = await request(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return mapWorkable(JSON.parse(r.text));
}

// ---------------------------------------------------------------------------
// Dispatch, validation, caches
// ---------------------------------------------------------------------------

const REQUIRED: Record<Ats, (keyof Company)[]> = {
  workday: ["host", "tenant", "site"],
  greenhouse: ["board"],
  lever: ["board"],
  oracle: ["host", "site"],
  amazon: [],
  teamtailor: ["feed"],
  workable: ["board"],
};

/** Problems with a company list, one line each; empty when it is usable. */
export function validateCompanies(list: unknown): string[] {
  if (!Array.isArray(list)) return ["companies must be a JSON array"];
  const problems: string[] = [];
  const ids = new Set<string>();
  list.forEach((c: any, i) => {
    const at = `#${i + 1} ${c?.id ?? "(no id)"}`;
    for (const k of ["id", "name", "sector", "origin", "ats", "careersUrl"]) if (!c?.[k]) problems.push(`${at}: missing ${k}`);
    if (c?.id && ids.has(c.id)) problems.push(`${at}: duplicate id`);
    ids.add(c?.id);
    if (c?.origin && c.origin !== "polish" && c.origin !== "foreign") problems.push(`${at}: origin must be "polish" or "foreign"`);
    if (!ATS_KINDS.includes(c?.ats)) problems.push(`${at}: unknown ats "${c?.ats}" (use ${ATS_KINDS.join(", ")})`);
    else for (const k of REQUIRED[c.ats as Ats]) if (!c[k]) problems.push(`${at}: ${c.ats} needs "${k}"`);
  });
  return problems;
}

export function loadCompanies(file = COMPANIES_FILE): Company[] {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw?.companies;
  const problems = validateCompanies(list);
  if (problems.length) throw new Error(`${file}: ${problems.slice(0, 5).join("; ")}`);
  return list;
}

async function listCompany(c: Company, gapMs: number): Promise<Listing[]> {
  switch (c.ats) {
    case "workday": return listWorkday(c, gapMs);
    case "greenhouse": return listGreenhouse(c);
    case "lever": return listLever(c);
    case "oracle": return listOracle(c, gapMs);
    case "amazon": return listAmazon(gapMs);
    case "teamtailor": return listTeamtailor(c);
    case "workable": return listWorkable(c);
  }
}

/** The full advert, for the sites whose list carries no description. */
async function readAdvert(c: Company, l: Listing): Promise<Partial<Listing>> {
  if (c.ats === "workday") return workdayAdvert(c, l);
  if (c.ats === "oracle") return oracleAdvert(c, l);
  return {};
}

/** A list cached under a different feed (host, tenant, board…) belongs to an old configuration. */
const feedKey = (c: Company) => [c.ats, c.host, c.tenant, c.site, c.board, c.region, c.feed].join("|");

function readListCache(c: Company, now: number): Listing[] | null {
  const file = join(LIST_DIR, `${c.id}.json`);
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return d.feed === feedKey(c) && now - Number(d.at) < LIST_TTL_MS && Array.isArray(d.listings) ? d.listings : null;
  } catch {
    return null; // unreadable entry: fetch afresh and overwrite it
  }
}

function writeListCache(c: Company, listings: Listing[], now: number) {
  mkdirSync(LIST_DIR, { recursive: true });
  writeFileSync(join(LIST_DIR, `${c.id}.json`), JSON.stringify({ at: now, feed: feedKey(c), listings }));
}

/** Same entry shape as scrape-daily.ts's advert caches, so its language tagging can read these too. */
function readAdvertCache(url: string): Partial<Listing> | null {
  const file = join(ADVERT_DIR, `${sha1(url)}.json`);
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")).detail ?? {};
    return d.description ? d : null;
  } catch {
    return null; // unreadable entry: read the advert again
  }
}

function writeAdvertCache(url: string, detail: Partial<Listing>, now: number) {
  mkdirSync(ADVERT_DIR, { recursive: true });
  writeFileSync(join(ADVERT_DIR, `${sha1(url)}.json`), JSON.stringify({ at: now, url, detail }));
}
// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface CareersOptions {
  /** Companies read at once. They sit on different hosts, so this mostly bounds open sockets. */
  concurrency?: number;
  /** Pause between two requests to the same company. */
  gapMs?: number;
  /** Reuse lists younger than LIST_TTL_MS and cached adverts. Default true. */
  useCache?: boolean;
  /** Store lists and adverts in the cache. Default true; scrape-daily's --dry turns it off. */
  writeCache?: boolean;
  now?: number;
}

function toRawJob(c: Company, l: Listing): RawJob {
  return {
    id: `${c.id}:${l.id}`,
    title: l.title,
    company: c.name,
    url: l.url,
    location: l.location,
    salary: null,
    date: l.date,
    technologies: [],
    description: l.description,
    remote: l.remote,
  };
}

async function inPool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Math.max(1, Math.min(size, items.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

/**
 * Polish postings of every enabled company whose title matches one of
 * `queries` and that is at most `jobageDays` old, with the advert read where
 * the site's list carries none. Never throws: a failing site is reported in
 * `report` and `error`, and the other companies still count.
 */
export async function fetchCareers(
  companies: Company[],
  queries: string[],
  jobageDays: number,
  opts: CareersOptions = {},
): Promise<SourceResult & { report: CompanyReport[] }> {
  const now = opts.now ?? Date.now();
  const gapMs = opts.gapMs ?? 300;
  const useCache = opts.useCache !== false;
  const writeCache = opts.writeCache !== false;
  const terms = queries.filter((q) => wordsOf(q).length > 0);
  const active = companies.filter((c) => c.enabled !== false);
  const results: RawJob[] = [];
  const report: CompanyReport[] = [];

  await inPool(active, opts.concurrency ?? 4, async (c) => {
    const rep: CompanyReport = { id: c.id, name: c.name, listed: 0, matched: 0, adverts: 0, cached: false };
    report.push(rep);
    try {
      let listings = useCache ? readListCache(c, now) : null;
      rep.cached = listings !== null;
      if (!listings) {
        listings = await listCompany(c, gapMs);
        if (writeCache) writeListCache(c, listings, now);
      }
      rep.listed = listings.length;
      const matched = listings.filter((l) => withinDays(l.date, jobageDays, now) && terms.some((q) => titleMatches(l.title, q)));
      rep.matched = matched.length;
      for (const l of matched) {
        if (!l.description && l.detail) {
          const cached = useCache ? readAdvertCache(l.url) : null;
          if (cached) Object.assign(l, cached);
          else if (rep.adverts < MAX_ADVERTS_PER_COMPANY) {
            rep.adverts++;
            try {
              const detail = await readAdvert(c, l);
              Object.assign(l, detail);
              if (writeCache && detail.description) writeAdvertCache(l.url, detail, now);
            } catch (e) {
              // A missing advert costs the posting its text, not its place in the results.
              console.log(`  careers: advert of ${l.url} unreadable: ${msg(e)}`);
            }
            await sleep(gapMs);
          }
        }
        results.push(toRawJob(c, l));
      }
    } catch (e) {
      rep.error = msg(e);
    }
  });

  report.sort((a, b) => a.name.localeCompare(b.name));
  const failed = report.filter((r) => r.error);
  const error = failed.length
    ? `${failed.length} of ${active.length} career sites failed: ` +
      failed.slice(0, 4).map((r) => `${r.name} (${r.error})`).join("; ") +
      (failed.length > 4 ? "; …" : "")
    : undefined;
  return { results, error, report };
}

/** One line for the run log. */
export function summarizeCareers(report: CompanyReport[]): string {
  const sum = (k: "listed" | "matched" | "adverts") => report.reduce((n, r) => n + r[k], 0);
  const ok = report.filter((r) => !r.error).length;
  const cached = report.filter((r) => r.cached).length;
  return `${ok}/${report.length} career sites read (${cached} from cache): ${sum("listed")} Polish postings, ` +
    `${sum("matched")} match the queries, ${sum("adverts")} adverts read`;
}

// ---------------------------------------------------------------------------
// --probe: check company entries against their live feeds
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const val = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!args.includes("--probe")) {
    console.log('usage: bun run dashboard/careers.ts --probe [--file companies.json] [--id a,b] [--query "network engineer"] [--days 30] [--fresh]');
    process.exit(1);
  }
  let companies = loadCompanies(val("--file") ?? COMPANIES_FILE);
  const ids = (val("--id") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length) companies = companies.filter((c) => ids.includes(c.id));
  let queries = val("--query") ? [String(val("--query"))] : [];
  if (!queries.length) {
    try {
      queries = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")).apiSources?.careers?.queries ?? [];
    } catch (e) {
      console.log(`config.json unreadable (${msg(e)}); probing with "network"`);
    }
  }
  if (!queries.length) queries = ["network"];
  const fresh = args.includes("--fresh");
  const res = await fetchCareers(companies.map((c) => ({ ...c, enabled: true })), queries, Number(val("--days") ?? 30), { useCache: !fresh });
  for (const r of res.report) {
    const counts = `${String(r.listed).padStart(5)} PL ${String(r.matched).padStart(4)} match`;
    console.log(`${r.error ? "FAIL" : "ok  "} ${r.id.padEnd(24)} ${counts}${r.cached ? " (cached)" : ""}${r.error ? `  ${r.error}` : ""}`);
  }
  for (const j of res.results.slice(0, 25)) console.log(`  ${j.company} | ${j.title} | ${j.location} | ${j.date?.slice(0, 10) ?? "-"} | ${j.url}`);
  console.log(`queries: ${queries.join(", ")}`);
  console.log(summarizeCareers(res.report));
  process.exit(res.report.some((r) => r.error) ? 2 : 0);
}
