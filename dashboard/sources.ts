/**
 * sources.ts — additional job boards for scrape-daily.ts.
 *
 * Every board here publishes its listings through an open feed — a JSON API,
 * an RSS feed, or the JSON a page embeds for its own rendering — so there is no
 * key, no login and no scraping of rendered HTML. Each path used was checked
 * against the board's robots.txt (2026-11-02):
 *
 *   bulldogjob      bulldogjob.pl/companies/jobs/s/<filter>       Polish IT board. robots.txt
 *                   disallows /feeds, /page, /index … but not the filter pages.
 *   eures           europa.eu/eures/api/jv-searchengine/…          The EU job-mobility portal:
 *                   the public employment services of every member state.
 *   devitjobs       germantechjobs.de/api/jobsLight,                Same platform; one request
 *                   devitjobs.nl/api/jobsLight                      returns the whole board.
 *   jobicy          jobicy.com/api/v2/remote-jobs                   Remote jobs. Asks for a credit
 *                   link, which the card link and portal badge provide.
 *   weworkremotely  weworkremotely.com/categories/<category>.rss   Remote jobs per category.
 *
 * Fetchers return `{ results, error }` like the ones in scrape-daily.ts and never
 * throw: a board that is down or has changed shape only shows up in Portal
 * Health. The parsing lives in pure functions so sources.test.ts can pin it
 * without the network.
 */

/** One posting, in the shape scrape-daily.ts's ingest() reads. */
export interface RawJob {
  id: string;
  title: string;
  company: string;
  url: string;
  location: string;
  salary: string | null;
  date: string | null;
  technologies: string[];
  description: string;
  remote: boolean;
  contractTypes?: string[];
  workModes?: string[];
  /** Language the board says the posting is written in (lower-case English name), when it says so. */
  postingLanguage?: string;
}

export interface SourceResult {
  results: RawJob[];
  error?: string;
}

const UA = "job-radar/1.0 (personal use)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** GET/POST with a timeout and a short backoff on 429/5xx. Network errors propagate. */
export async function request(url: string, init: RequestInit = {}, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, {
      ...init,
      headers: {
        "User-Agent": UA,
        Accept: "application/json, application/rss+xml, text/html;q=0.9, */*;q=0.8",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < tries) {
      await sleep(2000 * attempt);
      continue;
    }
    return { ok: r.ok, status: r.status, text };
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/** Decodes the entities job feeds actually emit: the basic named ones and numeric ones. */
export function decodeEntities(s: string): string {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tags stripped, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return decodeEntities(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Lower-case with accents folded, so "Kraków" and "krakow" compare equal. */
export function fold(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[łŁ]/g, "l")
    .toLowerCase();
}

/** ISO timestamp, or null for a missing or unparsable date. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const t = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** True when `date` lies within the last `days` days. Undated postings are kept: there is nothing to judge by. */
export function withinDays(date: string | null | undefined, days: number, now = Date.now()): boolean {
  if (!date || !(days > 0)) return true;
  const t = Date.parse(date);
  return Number.isNaN(t) || t >= now - days * 86_400_000;
}

/** Appends every job not already in `out`, keyed on id. */
function addUnique(out: RawJob[], seen: Set<string>, jobs: RawJob[]) {
  for (const j of jobs) {
    if (seen.has(j.id)) continue;
    seen.add(j.id);
    out.push(j);
  }
}

// ---------------------------------------------------------------------------
// bulldogjob.pl
// ---------------------------------------------------------------------------

/** Polish places as they appear (accent-folded) in bulldogjob's `city` field. */
const PL_PLACE =
  /\b(poland|polska|krakow|warsaw|warszawa|wroclaw|gdansk|gdynia|sopot|poznan|katowice|gliwice|lodz|szczecin|lublin|bydgoszcz|rzeszow|bialystok|kielce|opole|torun|olsztyn|bielsko)\b/;

/**
 * Jobs from a bulldogjob search page. The page embeds its results in
 * __NEXT_DATA__ (props.pageProps.jobs), which is what it renders from.
 *
 * bulldogjob also lists roles based only in Riga, Bucharest or Berlin. Those
 * are dropped: this is a Polish-market source with no remote gate behind it.
 * A remote role tied to no city stays.
 */
export function parseBulldogjobPage(html: string): RawJob[] {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("no __NEXT_DATA__ payload - bulldogjob may have changed its page shape");
  const jobs = JSON.parse(m[1])?.props?.pageProps?.jobs;
  if (!Array.isArray(jobs)) throw new Error("no jobs list in __NEXT_DATA__ - bulldogjob may have changed its page shape");

  const out: RawJob[] = [];
  for (const j of jobs) {
    if (!j?.id || !j?.position) continue;
    const city = String(j.city ?? "").trim();
    const remote = j.remote === true;
    if (!PL_PLACE.test(fold(city)) && !(remote && !city)) continue;

    const salary = j.showSalary === false ? null : j.denominatedSalaryLong;
    const money = salary?.money;
    out.push({
      id: String(j.id),
      title: decodeEntities(String(j.position)).trim(),
      company: String(j.company?.name ?? "").trim() || "—",
      url: `https://bulldogjob.pl/companies/jobs/${j.id}`,
      location: city || "Remote",
      salary:
        typeof money === "string" || typeof money === "number"
          ? `${money} ${salary?.currency ?? ""}`.trim()
          : null,
      date: null, // search pages carry no publication date
      technologies: Array.isArray(j.technologyTags) ? j.technologyTags.map(String) : [],
      description: "",
      remote,
      contractTypes: [
        j.contractEmployment && "employment",
        j.contractB2b && "b2b",
        j.contractOther && "other",
      ].filter((x): x is string => typeof x === "string"),
      workModes: remote ? ["remote"] : [],
    });
  }
  return out;
}

/**
 * bulldogjob has no free-text search in its URLs (a `q,` segment is ignored),
 * so it is queried by its own filter segments instead — "role,administrator",
 * "skills,Cisco" — and the title gate decides relevance as for every source.
 */
export async function fetchBulldogjob(endpoint: string, filters: string[], gapMs = 1000): Promise<SourceResult> {
  const base = endpoint.replace(/\/+$/, "");
  const out: RawJob[] = [];
  const seen = new Set<string>();
  let error: string | undefined;

  for (const filter of filters) {
    // "skills,Palo Alto/city,Kraków" → keys kept as-is, values percent-encoded.
    const path = filter
      .split("/")
      .map((seg) => {
        const [key, ...values] = seg.split(",");
        return [key.trim(), ...values.map((v) => encodeURIComponent(v.trim()))].join(",");
      })
      .join("/");
    try {
      const r = await request(`${base}/${path}`, { headers: { Accept: "text/html" } });
      if (r.ok) addUnique(out, seen, parseBulldogjobPage(r.text));
      else error = `HTTP ${r.status} on ${filter}`;
    } catch (e) {
      error = `${filter}: ${msg(e)}`;
    }
    await sleep(gapMs);
  }
  return { results: out, error };
}

// ---------------------------------------------------------------------------
// EURES (europa.eu)
// ---------------------------------------------------------------------------

/** Polish NUTS regions EURES tags offers with, named with their main city so a "krakow" search finds them. */
const PL_NUTS: Record<string, string> = {
  PL21: "Małopolskie (Kraków)", PL22: "Śląskie (Katowice)", PL41: "Wielkopolskie (Poznań)",
  PL42: "Zachodniopomorskie (Szczecin)", PL43: "Lubuskie (Zielona Góra)", PL51: "Dolnośląskie (Wrocław)",
  PL52: "Opolskie (Opole)", PL61: "Kujawsko-Pomorskie (Bydgoszcz)", PL62: "Warmińsko-Mazurskie (Olsztyn)",
  PL63: "Pomorskie (Gdańsk)", PL71: "Łódzkie (Łódź)", PL72: "Świętokrzyskie (Kielce)",
  PL81: "Lubelskie (Lublin)", PL82: "Podkarpackie (Rzeszów)", PL84: "Podlaskie (Białystok)",
  PL91: "Warszawski stołeczny (Warszawa)", PL92: "Mazowieckie", PL9: "Mazowieckie (Warszawa)",
};

const COUNTRY_NAMES: Record<string, string> = {
  PL: "Poland", DE: "Germany", NL: "Netherlands", AT: "Austria", BE: "Belgium", CZ: "Czechia",
  DK: "Denmark", ES: "Spain", FR: "France", IE: "Ireland", IT: "Italy", LU: "Luxembourg",
  PT: "Portugal", SE: "Sweden", SK: "Slovakia", FI: "Finland", HU: "Hungary", RO: "Romania",
};

/** EURES language codes → the language names language-req.ts uses. */
const ISO_LANGUAGE: Record<string, string> = {
  pl: "polish", de: "german", nl: "dutch", fr: "french", es: "spanish", it: "italian",
  cs: "czech", sv: "swedish", da: "danish", fi: "finnish", pt: "portuguese",
};

/**
 * "sieci" is Polish for networks of every kind, so the public-employment offers
 * EURES relays include water, gas, power-grid and heating network jobs whose
 * titles would clear the networking title gate. None of them is an IT role.
 */
const UTILITY_NETWORK = /wodoci|kanaliz|wod-?kan|gazow|cieplow|cieplnej|cieplnych|energetycz|elektroenerg|oswietl|trakcyj|hydraul/;

export function mapEures(json: any): RawJob[] {
  const out: RawJob[] = [];
  for (const v of json?.jvs ?? []) {
    if (!v?.id || !v?.title) continue;
    const title = String(v.title).replace(/\s+/g, " ").trim();
    if (UTILITY_NETWORK.test(fold(title))) continue;

    const places = Object.entries(v.locationMap ?? {}).flatMap(([cc, regions]) => {
      const country = COUNTRY_NAMES[cc] ?? cc;
      const named = (Array.isArray(regions) ? regions : [])
        .map((r) => (cc === "PL" ? PL_NUTS[String(r)] : undefined))
        .filter((r): r is string => Boolean(r));
      return named.length ? named.map((r) => `${r}, ${country}`) : [country];
    });
    const languages: unknown[] = Array.isArray(v.availableLanguages) ? v.availableLanguages : [];

    out.push({
      id: String(v.id),
      title,
      company: String(v.employer?.name ?? "").trim() || "—",
      url: `https://europa.eu/eures/portal/jv-se/jv-details/${encodeURIComponent(String(v.id))}?lang=en`,
      location: [...new Set(places)].join(" / ") || "—",
      salary: null,
      date: toIso(v.creationDate),
      technologies: [],
      description: htmlToText(String(v.description ?? "")),
      remote: false, // EURES does not flag remote work
      contractTypes: v.positionOfferingCode ? [String(v.positionOfferingCode)] : [],
      postingLanguage: languages.length === 1 ? ISO_LANGUAGE[String(languages[0]).toLowerCase()] : undefined,
    });
  }
  return out;
}

/** EURES filters on a bucketed publication period, not a day count. */
export function euresPeriod(days: number): string {
  if (days <= 1) return "LAST_DAY";
  if (days <= 3) return "LAST_THREE_DAYS";
  if (days <= 7) return "LAST_WEEK";
  return "LAST_MONTH";
}

/**
 * EURES keyword search, one call per query, matched against job titles only.
 * Matching is loose even so — any query word can match, so "administrator
 * sieci" also returns property administrators — and searching the whole
 * posting instead returned ~250 hits a week for "network engineer", nearly all
 * warehouse and pipe-fitting jobs. Only the best matches are taken; the title
 * gate does the rest.
 */
export async function fetchEures(
  endpoint: string,
  queries: string[],
  countries: string[],
  jobageDays: number,
  perQuery: number,
  gapMs = 800,
): Promise<SourceResult> {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  let error: string | undefined;

  for (const q of queries) {
    const body = {
      resultsPerPage: Math.min(Math.max(perQuery, 1), 50),
      page: 1,
      sortSearch: "BEST_MATCH",
      keywords: [{ keyword: q, specificSearchCode: "TITLE" }],
      publicationPeriod: euresPeriod(jobageDays),
      locationCodes: countries.map((c) => c.toLowerCase()),
      occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [],
      sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [],
      euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [],
      minNumberPost: null,
      sessionId: "job-radar",
    };
    try {
      const r = await request(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", Accept: "application/json" },
      });
      if (r.ok) addUnique(out, seen, mapEures(JSON.parse(r.text)));
      else error = `HTTP ${r.status} on "${q}"`;
    } catch (e) {
      error = `"${q}": ${msg(e)}`;
    }
    await sleep(gapMs);
  }
  return { results: out, error };
}

// ---------------------------------------------------------------------------
// GermanTechJobs.de / DevITJobs.nl
// ---------------------------------------------------------------------------

/**
 * The whole board arrives in one response, so the query match happens here:
 * a posting is kept when the board files it under its own "Network" category,
 * or when every word of one query appears in its title or technology list.
 */
export function mapDevitJobs(
  list: any[],
  site: string,
  queries: string[],
  jobageDays: number,
  now = Date.now(),
): RawJob[] {
  const base = site.replace(/\/+$/, "");
  const wanted = queries
    .map((q) => fold(q).split(/[^\p{L}\p{N}+#.]+/u).filter(Boolean))
    .filter((words) => words.length > 0);

  const out: RawJob[] = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!x?.jobUrl || !x?.name || x.isPaused === true) continue;
    if (!withinDays(x.activeFrom, jobageDays, now)) continue;

    const technologies: string[] = Array.isArray(x.technologies) ? x.technologies.map(String) : [];
    const hay = fold(`${x.name} ${technologies.join(" ")}`);
    const hit = x.techCategory === "Network" || wanted.some((words) => words.every((w) => hay.includes(w)));
    if (!hit) continue;

    const city = String(x.actualCity || x.cityCategory || "").trim();
    const workplace = String(x.workplace ?? "").toLowerCase(); // office | hybrid | remote
    out.push({
      id: String(x._id ?? x.jobUrl),
      title: String(x.name).trim(),
      company: String(x.company ?? "").trim() || "—",
      url: `${base}/${x.jobUrl}`,
      location: [city, workplace === "remote" ? "Remote" : ""].filter(Boolean).join(", ") || "—",
      salary:
        x.annualSalaryFrom && x.annualSalaryTo ? `${x.annualSalaryFrom}-${x.annualSalaryTo} EUR/yr` : null,
      date: toIso(x.activeFrom),
      technologies,
      description: [x.techCategory, x.expLevel, x.jobType].filter(Boolean).join(" · "),
      remote: workplace === "remote",
      workModes: workplace ? [workplace] : [],
      postingLanguage: x.language ? String(x.language).toLowerCase() : undefined,
    });
  }
  return out;
}

export async function fetchDevitJobs(
  endpoint: string,
  site: string | undefined,
  queries: string[],
  jobageDays: number,
): Promise<SourceResult> {
  try {
    const r = await request(endpoint);
    if (!r.ok) return { results: [], error: `HTTP ${r.status}` };
    const list = JSON.parse(r.text);
    if (!Array.isArray(list)) return { results: [], error: "unexpected payload - not a job list" };
    const jobsBase = site || `${new URL(endpoint).origin}/jobs`;
    return { results: mapDevitJobs(list, jobsBase, queries, jobageDays) };
  } catch (e) {
    return { results: [], error: msg(e) };
  }
}

// ---------------------------------------------------------------------------
// Jobicy
// ---------------------------------------------------------------------------

export function mapJobicy(json: any): RawJob[] {
  const out: RawJob[] = [];
  for (const x of json?.jobs ?? []) {
    if (!x?.url || !x?.jobTitle) continue;
    out.push({
      id: String(x.id ?? x.url),
      title: decodeEntities(String(x.jobTitle)).trim(),
      company: decodeEntities(String(x.companyName ?? "")).trim() || "—",
      url: String(x.url),
      // jobGeo lists where the role is open ("Poland", "Europe", "Canada, Poland, UK"),
      // which is exactly what the EU-remote gate reads.
      location: decodeEntities(String(x.jobGeo ?? "")).trim() || "Remote",
      salary:
        x.salaryMin && x.salaryMax
          ? `${x.salaryCurrency ?? ""} ${x.salaryMin}-${x.salaryMax} ${x.salaryPeriod ?? ""}`.replace(/\s+/g, " ").trim()
          : null,
      date: toIso(x.pubDate),
      technologies: [],
      description: htmlToText(String(x.jobDescription ?? x.jobExcerpt ?? "")),
      remote: true,
      contractTypes: Array.isArray(x.jobType) ? x.jobType.map(String) : [],
    });
  }
  return out;
}

/**
 * Jobicy's `tag` search finds nothing for multi-word titles, so it is read by
 * region instead (`geo=poland` = roles open to candidates in Poland) and the
 * title gate picks the relevant ones — one or two calls a run, well inside
 * what the API asks of its users.
 */
export async function fetchJobicy(
  endpoint: string,
  geos: string[],
  count: number,
  jobageDays: number,
  gapMs = 1000,
): Promise<SourceResult> {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  let error: string | undefined;

  for (const geo of geos.length ? geos : [""]) {
    try {
      const u = new URL(endpoint);
      u.searchParams.set("count", String(Math.min(Math.max(count, 1), 100)));
      if (geo) u.searchParams.set("geo", geo);
      const r = await request(u.toString());
      if (r.ok) addUnique(out, seen, mapJobicy(JSON.parse(r.text)).filter((j) => withinDays(j.date, jobageDays)));
      else error = `HTTP ${r.status} on geo=${geo}`;
    } catch (e) {
      error = `geo=${geo}: ${msg(e)}`;
    }
    await sleep(gapMs);
  }
  return { results: out, error };
}

// ---------------------------------------------------------------------------
// We Work Remotely
// ---------------------------------------------------------------------------

function rssField(item: string, name: string): string {
  const m = item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1").trim() : "";
}

/** Items of a WWR category feed. Titles read "Company: Job title". */
export function parseWwrRss(xml: string): RawJob[] {
  const out: RawJob[] = [];
  for (const chunk of xml.split("<item>").slice(1)) {
    const item = chunk.split("</item>")[0];
    const raw = decodeEntities(rssField(item, "title"));
    const link = rssField(item, "link") || rssField(item, "guid");
    if (!raw || !link) continue;

    const sep = raw.indexOf(": ");
    const region = decodeEntities(rssField(item, "region"));
    out.push({
      id: link,
      title: (sep > 0 ? raw.slice(sep + 2) : raw).trim(),
      company: sep > 0 ? raw.slice(0, sep).trim() : "—",
      url: link,
      // WWR writes "Anywhere in the World"; the EU-remote gate's phrase for that is "worldwide".
      location: /anywhere in the world/i.test(region) ? `${region} (worldwide)` : region || "Remote",
      salary: null,
      date: toIso(rssField(item, "pubDate")),
      technologies: decodeEntities(rssField(item, "skills"))
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // The description is entity-escaped HTML: decode once to get the markup, then strip it.
      description: htmlToText(decodeEntities(rssField(item, "description"))),
      remote: true,
      contractTypes: [decodeEntities(rssField(item, "type"))].filter(Boolean),
    });
  }
  return out;
}

export async function fetchWeWorkRemotely(feeds: string[], jobageDays: number, gapMs = 1000): Promise<SourceResult> {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  let error: string | undefined;

  for (const feed of feeds) {
    try {
      const r = await request(feed, { headers: { Accept: "application/rss+xml, application/xml" } });
      if (r.ok) addUnique(out, seen, parseWwrRss(r.text).filter((j) => withinDays(j.date, jobageDays)));
      else error = `HTTP ${r.status} on ${feed}`;
    } catch (e) {
      error = `${feed}: ${msg(e)}`;
    }
    await sleep(gapMs);
  }
  return { results: out, error };
}
