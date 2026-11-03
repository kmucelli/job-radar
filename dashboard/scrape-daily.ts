#!/usr/bin/env bun
/**
 * scrape-daily.ts — daily job scrape for the personal job dashboard.
 *
 * Runs every enabled portal CLI under .agents/skills/<portal>-search/, normalises
 * the results, scores them against the CV-derived keyword weights in config.json,
 * de-duplicates against data/seen.json, and writes:
 *
 *   data/jobs.json  — machine-readable snapshot (for tooling / jq)
 *   data/jobs.js    — same payload as `window.JOBS = {...}` so index.html works
 *                     from file:// without a web server (fetch() is blocked there)
 *   data/seen.json  — dedup ledger; anything unseen is flagged isNew
 *
 * Usage:  bun run dashboard/scrape-daily.ts [--jobage N] [--dry]
 *         bun run dashboard/scrape-daily.ts --rescore [--fetch-details] [--dry]
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jobIdentity } from "./job-identity.ts";
import { languageRequirements, LANGUAGE_FORMS, LANGUAGE_LABELS, type LanguageReq } from "./language-req.ts";
import { fetchBulldogjob, fetchDevitJobs, fetchEures, fetchJobicy, fetchWeWorkRemotely } from "./sources.ts";
import { fetchCareers, loadCompanies, summarizeCareers } from "./careers.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DATA = join(HERE, "data");
const SKILLS = join(REPO, ".agents", "skills");

type Cfg = ReturnType<typeof loadConfig>;

function loadConfig() {
  return JSON.parse(readFileSync(join(HERE, "config.json"), "utf8")) as {
    profile: Record<string, unknown>;
    jobageDays: number;
    portals: Record<
      string,
      {
        enabled: boolean;
        region: "PL" | "EU";
        /**
         * Which CLI under .agents/skills/<cli>-search to invoke. Defaults to the
         * config key. Only needed when one CLI is driven twice with different
         * settings — e.g. "linkedin" (Poland) and "linkedinEu" (EU-wide), which
         * must stay separate entries because they carry different regions and
         * therefore different eligibility gating.
         */
        cli?: string;
        /**
         * Which search scopes this source belongs to (e.g. ["PL"], ["DE","EU"]).
         * Omitted means "every scope". Filtered by the --scope flag.
         */
        scopes?: string[];
        /**
         * Treat this as a local-market source: skip the strict remote-from-PL
         * gate so on-site roles in that country still surface.
         */
        localMarket?: boolean;
        /**
         * Max queries this portal may run at once. Default 1 (strictly serial,
         * the historical behaviour). Raise it for portals that are slow because
         * they fetch many detail pages per query.
         */
        concurrency?: number;
        /** Pause after each call, per worker. Overrides the built-in default. */
        gapMs?: number;
        locations: string[];
        queries: string[];
        limit: number;
        extraArgs?: string[];
      }
    >;
    apiSources: Record<
      string,
      {
        enabled: boolean;
        region: "PL" | "EU";
        scopes?: string[];
        localMarket?: boolean;
        endpoint: string;
        queries?: string[];
        limit?: number;
        pages?: number;
        countries?: string[];
        appId?: string;
        appKey?: string;
        /**
         * Which fetcher implements this source. Defaults to the config key. Set
         * it to drive one fetcher twice, e.g. "germantechjobs" and "devitjobsNl"
         * both use "devitjobs" against different boards.
         */
        fetcher?: string;
        /** bulldogjob: search-URL filter segments, e.g. "role,administrator", "skills,Cisco". */
        filters?: string[];
        /** jobicy: regions passed as `geo`, e.g. "poland", "europe". */
        geos?: string[];
        /** weworkremotely: RSS feeds to read. Defaults to `endpoint`. */
        feeds?: string[];
        /** devitjobs: base URL of the job pages. Defaults to <endpoint origin>/jobs. */
        site?: string;
        /** careers: company list, relative to the dashboard folder. Default companies.json. */
        companies?: string;
        /** careers: career sites read at once. */
        concurrency?: number;
        /** careers: pause between two requests to the same company. */
        gapMs?: number;
      }
    >;
    euRemote: {
      allowPhrases: string[];
      denyPhrases: string[];
      requireGermanLanguage: string[];
    };
    scoring: {
      highFitThreshold: number;
      mediumFitThreshold: number;
      positive: Record<string, number>;
      negative: Record<string, number>;
      polishOnlySignals: string[];
      /** Title names another discipline — see titleGate(). Optional: absent disables the veto. */
      offDomainTitle?: string[];
      /** Role nouns of another discipline ("software engineer", "developer"): off even beside an onDomainTitle term. */
      hardOffDomainTitle?: string[];
      /** Strong networking signal in the title: relevant on its face, and wins over an offDomainTitle hit. */
      onDomainTitle?: string[];
      /** Generic infrastructure words: relevant only with domain evidence, and never rescue an offDomainTitle hit. */
      weakOnDomainTitle?: string[];
      /** Domain score a weakOnDomainTitle title needs. Default: mediumFitThreshold. */
      weakTitleMinDomainScore?: number;
      /** Domain score a title with no signal either way needs. Such a job rates at most medium. Default: highFitThreshold. */
      neutralTitleMinDomainScore?: number;
      /** Positive terms that raise the score but are no evidence of the domain on their own (python, terraform, ...). */
      supportingTerms?: string[];
      /** Ambiguous terms that only count beside one of their context terms ("nexus" is also Sonatype Nexus). */
      contextRequired?: Record<string, string[]>;
      /** Re-weights scoring by what the uploaded CV actually contains. See buildCvAlignment(). */
      cvAlignment?: {
        enabled: boolean;
        inCvMultiplier: number;
        notInCvMultiplier: number;
        extraSkillWeight: number;
        extraSkillCap: number;
        seniorityTitleBonus: number;
        seniorityTitleTerms: string[];
        /** Bonus for a posting whose title contains one of the CV's own role titles. */
        ownTitleBonus?: number;
        seniorCvSignals: string[];
        vocabulary: string[];
      };
    };
  };
}

interface Job {
  id: string;
  portal: string;
  region: "PL" | "EU";
  /**
   * Which search scope produced this job (PL/DE/NL/EU). Drives the per-country
   * tabs in the UI. `region` stays a coarse PL-vs-EU-remote flag because the
   * eligibility gate keys off it; `country` is the finer label.
   */
  country: string;
  title: string;
  company: string;
  location: string;
  url: string;
  salary: string | null;
  date: string | null;
  contractTypes?: string[];
  workModes?: string[];
  remote?: boolean;
  technologies?: string[];
  description?: string;
  /**
   * Every board this vacancy was found on. The card links to one of them; this
   * keeps the alternates, so collapsing cross-portal duplicates into a single
   * card never loses a way to apply.
   */
  sources?: { portal: string; url: string }[];
  /**
   * Portal-independent key (normalised company + title). The dashboard resolves
   * pipeline state by this as well as by URL, so a job stays deleted when the
   * posting resurfaces under a different board's URL. See job-identity.ts.
   */
  identity?: string;
  score: number;
  fit: "high" | "medium" | "low";
  matched: string[];
  polishGate: boolean;
  /** EU-region only: the phrase that proved this job is performable from Poland. */
  euEvidence?: string;
  /** EU-region only: true when the posting demands fluent German. */
  germanGate?: boolean;
  /** Non-English languages the posting requires (language-req.ts). */
  languages?: string[];
  /** Why each of those languages counts as required, with the sentence that says so. */
  languageReqs?: LanguageReq[];
  /** "full" once a real description was read, "title" while only the title was. */
  langChecked?: "title" | "full";
  /**
   * The language the board itself says the posting is written in (germantechjobs,
   * EURES). Kept on the job so a later title-only re-tag does not lose it.
   */
  postingLanguage?: string;
  isNew: boolean;
}

const args = process.argv.slice(2);
const argVal = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = args.includes("--dry");

/**
 * Search scope: which slice of the configured sources to run.
 *   PL  — Polish market only
 *   DE  — Germany
 *   EU  — EU-wide / remote-from-Poland
 *   ALL — everything that is enabled (the default, and what the daily job uses)
 * Sources declare membership via a "scopes" array in config.json; a source with
 * no "scopes" key belongs to every scope.
 */
/**
 * Canonical dedup key for a posting URL: query string and trailing slash
 * stripped, lowercased. Must stay identical to the key serve.ts uses for
 * job-states.json, or pipeline state would detach from its job.
 */
const canonKey = (u: string) => String(u).split("?")[0].replace(/\/+$/, "").toLowerCase();

const SCOPE = (argVal("--scope") ?? "ALL").toUpperCase();
const inScope = (scopes?: string[]) =>
  SCOPE === "ALL" || !scopes || scopes.length === 0 || scopes.includes(SCOPE);

/**
 * How many CV-derived keywords may join a run. Defaults to the same 12 the
 * dashboard lists under "From your CV", so every term shown there is searched.
 * Each one is an extra query against every enabled portal in every configured
 * location, so this multiplies runtime — lower it with --cv-keyword-limit N.
 */
const CV_KEYWORD_LIMIT = Number(argVal("--cv-keyword-limit") ?? 12);

/** Run one portal CLI and return its parsed `results` array. Never throws. */
async function runCli(
  portal: string,
  cliArgs: string[],
  timeoutMs = 180_000,
): Promise<{ results: any[]; error?: string }> {
  const { json, error } = await runCliJson(portal, cliArgs, timeoutMs);
  if (!json) return { results: [], error };
  return { results: Array.isArray(json.results) ? json.results : [] };
}

/** Run one portal CLI and return its parsed JSON output (a search, or a `detail` record). Never throws. */
function runCliJson(
  portal: string,
  cliArgs: string[],
  timeoutMs = 180_000,
): Promise<{ json?: any; error?: string }> {
  const cli = join(SKILLS, `${portal}-search`, "cli", "src", "cli.ts");
  if (!existsSync(cli)) return Promise.resolve({ error: "cli not found" });

  return new Promise((res) => {
    // Spawn the running bun binary directly, never through a shell. With
    // shell:true on Windows the arguments are joined into one cmd.exe line
    // WITHOUT quoting, so `-q "data center network engineer"` reached the CLI
    // as `-q data` — every multi-word query searched only its first word.
    // "nexus technical consulting engineer" became a search for "nexus", which
    // is how Sonatype-Nexus Java/DevOps postings got in. Locations were cut the
    // same way ("European Union" -> "European") and the console code page
    // mangled non-ASCII ("Kraków" -> "Krak�w").
    const child = spawn(process.execPath, ["run", cli, ...cliArgs], { cwd: REPO });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      res({ error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const start = out.indexOf("{");
        if (start < 0) return res({ error: err.trim() || "no json" });
        res({ json: JSON.parse(out.slice(start)) });
      } catch (e) {
        res({ error: err.trim() || String(e) });
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      res({ error: String(e) });
    });
  });
}

/**
 * Strict EU-remote eligibility gate.
 *
 * Roughly 70-80% of German/Dutch postings advertised as "remote" still require
 * tax residence in that country, because otherwise the employer must register
 * for Polish payroll/ZUS and accepts permanent-establishment exposure. A naive
 * `remote === true` check therefore produces mostly unactionable results.
 *
 * A job passes only if it carries an explicit signal that it is performable
 * from anywhere in the EU (or from Poland specifically, or on a B2B contract),
 * and carries no phrase that restricts it to a single country.
 */
function euEligible(
  raw: any,
  cfg: Cfg,
): { ok: boolean; evidence?: string; germanGate: boolean } {
  const hay = [
    raw.title ?? "",
    raw.location ?? "",
    raw.description ?? "",
    raw.candidate_required_location ?? "",
    (raw.regions ?? []).join(" "),
    (raw.tags ?? []).join(" "),
    raw.work_mode ?? "",
  ]
    .join(" ")
    .toLowerCase();

  for (const bad of cfg.euRemote.denyPhrases) {
    if (hay.includes(bad)) return { ok: false, germanGate: false };
  }

  const germanGate = cfg.euRemote.requireGermanLanguage.some((p) => hay.includes(p));

  for (const good of cfg.euRemote.allowPhrases) {
    if (hay.includes(good)) return { ok: true, evidence: good, germanGate };
  }
  return { ok: false, germanGate };
}

/* ---------------------------------------------------------------------------
 * Language requirements.
 *
 * Adverts routinely demand a language the candidate does not have — "sehr gute
 * Deutschkenntnisse", "biegła znajomość języka polskiego", "Network Engineer
 * with German". Every job is TAGGED with the non-English languages it requires
 * (job.languages, detected by language-req.ts) and the dashboard's "Language
 * req." menu decides what to hide, so a role is never lost to a misread line.
 * languageGate.dropAtScrape=true restores the old behaviour of discarding, at
 * scrape time, jobs that need a language below profile.minWorkingLevel.
 *
 * Several sources return only a title (LinkedIn) or occupation names
 * (Arbeitsagentur); their full advert is read once per job so a "requires
 * fluent German" line is seen, and cached under data/cache/ for 72h.
 * ------------------------------------------------------------------------- */

/** The language-tagging rules from config.json, or null when tagging is switched off. */
function languageRules(cfg: Cfg) {
  const g: any = (cfg as any).languageGate;
  if (!g || g.enabled === false) return null;
  return {
    optionalMarkers: g.optionalMarkers ?? [],
    requiredMarkers: g.requiredMarkers ?? [],
    postingLanguage: g.postingLanguage !== false,
  };
}

/** A description long enough to judge; search results of some sources carry only a title. */
const hasRealDescription = (d?: string) => String(d ?? "").split(/\s+/).filter(Boolean).length >= 40;

/** Tags `job` with the languages its text requires; "full" once a real description was read. */
function tagLanguages(
  job: Job,
  text: { title?: string; description?: string; tags?: string[]; postingLanguage?: string },
  cfg: Cfg,
) {
  const rules = languageRules(cfg);
  if (!rules) return;
  const reqs = languageRequirements(text, rules);
  // Some boards state the posting language outright while their search results
  // carry too little text for postingLanguage() to judge it.
  const declared = String(text.postingLanguage ?? job.postingLanguage ?? "").toLowerCase();
  if (rules.postingLanguage && Object.hasOwn(LANGUAGE_FORMS, declared) && !reqs.some((r) => r.lang === declared)) {
    reqs.push({
      lang: declared,
      how: "posting",
      evidence: `Written in ${LANGUAGE_LABELS[declared] ?? declared}, per the job board`,
    });
  }
  job.languageReqs = reqs;
  job.languages = reqs.map((r) => r.lang);
  job.langChecked = hasRealDescription(text.description) ? "full" : "title";
}

/** Languages the profile works in: profile.languages at or above profile.minWorkingLevel. */
function usableLanguages(cfg: Cfg): Set<string> {
  const g: any = (cfg as any).languageGate ?? {};
  const levels: Record<string, number> = g.levels ?? {};
  const spoken: Record<string, string> = (cfg as any).profile?.languages ?? {};
  const min = levels[String((cfg as any).profile?.minWorkingLevel ?? "b2").toLowerCase()] ?? 4;
  return new Set(
    Object.entries(spoken)
      .filter(([, lvl]) => (levels[String(lvl).toLowerCase()] ?? 0) >= min)
      .map(([name]) => name.toLowerCase()),
  );
}

/** dropAtScrape only: discard jobs that need a language the profile does not work in. */
function dropUnusableLanguages(list: Job[], cfg: Cfg): { kept: Job[]; dropped: number } {
  const g: any = (cfg as any).languageGate;
  if (!g || g.enabled === false || g.dropAtScrape !== true) return { kept: list, dropped: 0 };
  const usable = usableLanguages(cfg);
  const kept = list.filter((j) => !(j.languages ?? []).some((l) => !usable.has(l)));
  return { kept, dropped: list.length - kept.length };
}

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  const n = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const runners = Array.from({ length: n }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/**
 * Cache folders that may hold a job's advert, all keyed sha1(url).json:
 * justjoin/nofluffjobs are written by their CLIs, careers by careers.ts, the
 * other two by readDescriptions() below.
 */
const ADVERT_CACHES = ["justjoin", "nofluffjobs", "arbeitsagentur", "linkedin", "careers"];

/** A cached advert for any of the job's URLs, or "" when none is cached. */
function cachedDescription(job: Job): string {
  const urls = [job.url, ...(job.sources ?? []).map((s) => s.url)];
  for (const url of urls) {
    const name = `${sha1(url)}.json`;
    for (const dir of ADVERT_CACHES) {
      const file = join(DATA, "cache", dir, name);
      if (!existsSync(file)) continue;
      try {
        const d = JSON.parse(readFileSync(file, "utf8")).detail ?? {};
        if (hasRealDescription(d.description)) return String(d.description);
      } catch (e) {
        console.log(`[lang] unreadable cache entry ${file}: ${e}`);
      }
    }
  }
  return "";
}

function cacheDescription(dir: string, url: string, description: string) {
  if (DRY) return;
  mkdirSync(join(DATA, "cache", dir), { recursive: true });
  writeFileSync(
    join(DATA, "cache", dir, `${sha1(url)}.json`),
    JSON.stringify({ at: Date.now(), url, detail: { description } }),
  );
}

/** Full advert from the Arbeitsagentur jobdetails API (v4; the reference number base64-encoded). */
async function fetchArbeitsagenturAdvert(job: Job): Promise<string> {
  const ref = job.id || decodeURIComponent(job.url.split("/").pop() ?? "");
  const r = await fetch(
    `https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/${Buffer.from(ref).toString("base64")}`,
    {
      headers: { "X-API-Key": "jobboerse-jobsuche", "User-Agent": "job-radar/1.0 (personal use)" },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d: any = await r.json();
  return String(d.stellenangebotsBeschreibung ?? "").replace(/<[^>]+>/g, " ");
}

/** Full advert through the linkedin-search CLI's `detail` command (numeric job id, or the job URL). */
async function fetchLinkedinAdvert(job: Job): Promise<string> {
  const ref = /^\d+$/.test(job.id) ? job.id : job.url;
  const { json, error } = await runCliJson("linkedin", ["detail", ref, "--format", "json"], 60_000);
  if (!json) throw new Error(error ?? "no output");
  return String(json.description ?? "");
}

interface LanguageStats {
  /** Adverts found in a cache. */
  cached: number;
  /** Adverts fetched over the network. */
  fetched: number;
  failed: number;
  /** Jobs still judged on their title alone. */
  titleOnly: number;
  /** Jobs per required language. */
  byLang: Record<string, number>;
}

/**
 * Tags every job in `list` that has not been judged on a real description yet:
 * from a cached advert when there is one, otherwise by fetching it (when
 * `network`) for the sources in languageGate.fetchDescriptions, otherwise from
 * the title. Jobs carried over from payloads written before tagging existed
 * are covered too.
 */
async function readDescriptions(
  list: Job[],
  cfg: Cfg,
  network: boolean,
  report?: (label: string) => void,
): Promise<LanguageStats> {
  const stats: LanguageStats = { cached: 0, fetched: 0, failed: 0, titleOnly: 0, byLang: {} };
  if (!languageRules(cfg)) return stats;
  const fd: any = (cfg as any).languageGate?.fetchDescriptions ?? {};
  const fetchable = new Set<string>(
    fd.enabled === false ? [] : (fd.portals ?? ["arbeitsagentur", "linkedin", "linkedinDe", "linkedinNl", "linkedinEu"]),
  );
  const isLinkedin = (j: Job) => j.portal.startsWith("linkedin");
  const hasFetcher = (j: Job) => isLinkedin(j) || j.portal === "arbeitsagentur";

  const remote: Job[] = [];
  for (const j of list) {
    if (j.langChecked === "full") continue;
    const desc = cachedDescription(j);
    if (desc) {
      tagLanguages(j, { title: j.title, description: desc }, cfg);
      stats.cached++;
      continue;
    }
    if (!j.languages) tagLanguages(j, { title: j.title }, cfg);
    if (network && fetchable.has(j.portal) && hasFetcher(j)) remote.push(j);
  }

  let done = 0;
  const work = async (j: Job) => {
    try {
      const desc = isLinkedin(j) ? await fetchLinkedinAdvert(j) : await fetchArbeitsagenturAdvert(j);
      if (hasRealDescription(desc)) {
        cacheDescription(isLinkedin(j) ? "linkedin" : "arbeitsagentur", j.url, desc);
        tagLanguages(j, { title: j.title, description: desc }, cfg);
        stats.fetched++;
      } else {
        stats.failed++;
      }
    } catch (e) {
      stats.failed++;
      if (stats.failed <= 3) console.log(`[lang] could not read ${j.url}: ${e}`);
    }
    done++;
    report?.(`Reading adverts for language requirements (${done}/${remote.length})`);
  };
  const gap = fd.linkedinGapMs ?? 700;
  await Promise.all([
    pool(remote.filter(isLinkedin), fd.linkedinConcurrency ?? 2, async (j) => {
      await work(j);
      await new Promise((r) => setTimeout(r, gap));
    }),
    pool(remote.filter((j) => !isLinkedin(j)), fd.apiConcurrency ?? 4, work),
  ]);

  stats.titleOnly = list.filter((j) => j.langChecked !== "full").length;
  for (const j of list) for (const l of j.languages ?? []) stats.byLang[l] = (stats.byLang[l] ?? 0) + 1;
  return stats;
}

/** "german 41, polish 12" — for the run summary. */
const languageSummary = (byLang: Record<string, number>) =>
  Object.entries(byLang)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} ${n}`)
    .join(", ");

/** Remotive: remote-only board. `candidate_required_location` is the real gate. */

async function fetchRemotive(
  endpoint: string,
  queries: string[],
  limit: number,
): Promise<{ results: any[]; error?: string }> {
  const out: any[] = [];
  for (const q of queries) {
    try {
      const url = `${endpoint}?search=${encodeURIComponent(q)}&limit=${limit}`;
      const r = await fetch(url, { headers: { "User-Agent": "job-radar/1.0 (personal use)" } });
      if (!r.ok) return { results: out, error: `HTTP ${r.status}` };
      const j: any = await r.json();
      for (const x of j.jobs ?? []) {
        out.push({
          id: String(x.id),
          title: x.title,
          company: x.company_name,
          // Attribution: link back to Remotive's own URL, as their terms require.
          url: x.url,
          location: x.candidate_required_location || "Remote",
          candidate_required_location: x.candidate_required_location,
          salary: x.salary || null,
          date: x.publication_date ? new Date(x.publication_date).toISOString() : null,
          technologies: x.tags ?? [],
          description: String(x.description ?? "").replace(/<[^>]+>/g, " "),
          remote: true,
        });
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    } catch (e) {
      return { results: out, error: String(e) };
    }
  }
  return { results: out };
}

/** Arbeitnow: German market. Only `remote === true` entries are of interest. */
async function fetchArbeitnow(
  endpoint: string,
  pages: number,
): Promise<{ results: any[]; error?: string }> {
  const out: any[] = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const r = await fetch(`${endpoint}?page=${p}`, {
        headers: { "User-Agent": "job-radar/1.0 (personal use)" },
      });
      if (!r.ok) return { results: out, error: `HTTP ${r.status}` };
      const j: any = await r.json();
      for (const x of j.data ?? []) {
        if (!x.remote) continue;
        out.push({
          id: x.slug,
          title: x.title,
          company: x.company_name,
          url: x.url,
          location: x.location || "Remote (DE)",
          salary: null,
          date: x.created_at ? new Date(x.created_at * 1000).toISOString() : null,
          technologies: x.tags ?? [],
          description: String(x.description ?? "").replace(/<[^>]+>/g, " "),
          remote: true,
        });
      }
      await new Promise((r2) => setTimeout(r2, 1500));
    } catch (e) {
      return { results: out, error: String(e) };
    }
  }
  return { results: out };
}

/** RemoteOK: single feed of the ~100 newest remote jobs. */
async function fetchRemoteOk(endpoint: string): Promise<{ results: any[]; error?: string }> {
  try {
    const r = await fetch(endpoint, { headers: { "User-Agent": "job-radar/1.0 (personal use)" } });
    if (!r.ok) return { results: [], error: `HTTP ${r.status}` };
    const j: any = await r.json();
    // Element 0 is a legal notice, not a job.
    return {
      results: (Array.isArray(j) ? j.slice(1) : []).map((x: any) => ({
        id: String(x.id),
        title: x.position,
        company: x.company,
        url: x.url,
        location: x.location || "Remote",
        salary: x.salary_max ? `${x.salary_min}-${x.salary_max}` : null,
        date: x.date ?? null,
        technologies: x.tags ?? [],
        description: String(x.description ?? "").replace(/<[^>]+>/g, " "),
        remote: true,
      })),
    };
  } catch (e) {
    return { results: [], error: String(e) };
  }
}

/**
 * Himalayas — remote-first board with a genuinely open API (no key, no signup).
 * Supports an ISO-3166 alpha-2 `country` filter, so it can be pointed at DE for
 * the Germany scope and left unfiltered for EU-wide.
 *
 * Their terms ask that results link back to the Himalayas URL and name them as
 * the source; the dashboard does both via the card link and the portal badge.
 */
async function fetchHimalayas(
  endpoint: string,
  queries: string[],
  countries: string[],
): Promise<{ results: any[]; error?: string }> {
  const out: any[] = [];
  let error: string | undefined;
  // An empty country list means "no country filter" — one unrestricted pass.
  const targets = countries.length ? countries : [""];

  for (const country of targets) {
    for (const q of queries) {
      try {
        const u = new URL(endpoint);
        u.searchParams.set("q", q);
        if (country) u.searchParams.set("country", country);
        u.searchParams.set("sort", "recent");
        const r = await fetch(u, {
          headers: { "User-Agent": "job-radar/1.0 (personal use)" },
        });
        if (!r.ok) {
          error = `HTTP ${r.status}`;
          continue;
        }
        const j: any = await r.json();
        for (const x of j.jobs ?? []) {
          const locs: string[] = x.locationRestrictions ?? [];
          out.push({
            id: String(x.guid ?? x.applicationLink),
            title: x.title,
            company: x.companyName,
            url: x.applicationLink,
            // No restrictions listed means the role is open worldwide, which the
            // EU gate recognises via its "worldwide" allow phrase.
            location: locs.length ? locs.join(", ") : "Worldwide",
            salary:
              x.minSalary && x.maxSalary
                ? `${x.currency ?? ""} ${x.minSalary}-${x.maxSalary} ${x.salaryPeriod ?? ""}`.trim()
                : null,
            date: x.pubDate ?? null,
            technologies: x.categories ?? [],
            description: String(x.description ?? x.excerpt ?? "").replace(/<[^>]+>/g, " "),
            remote: true,
          });
        }
      } catch (e) {
        error = String(e);
      }
    }
  }
  return { results: out, error };
}

/**
 * Adzuna — the only realistic route to Indeed/StepStone inventory. Adzuna
 * aggregates those boards (and others) and re-publishes them under one API, so
 * we get that reach without scraping sites whose terms forbid it.
 *
 * Requires a free app_id/app_key from https://developer.adzuna.com/signup.
 * Left disabled in config.json until those are filled in — without them every
 * call would 401 and just pollute the health table.
 *
 * NOTE: Adzuna's terms require displaying "Jobs by Adzuna" with a link back
 * wherever their listings are shown.
 */
async function fetchAdzuna(
  endpoint: string,
  queries: string[],
  countries: string[],
  appId: string,
  appKey: string,
  jobageDays: number,
  perPage: number,
): Promise<{ results: any[]; error?: string }> {
  if (!appId || !appKey) {
    return { results: [], error: "missing appId/appKey — register at developer.adzuna.com" };
  }

  const out: any[] = [];
  let error: string | undefined;

  for (const country of countries) {
    for (const q of queries) {
      try {
        // endpoint is the base, e.g. https://api.adzuna.com/v1/api/jobs
        const u = new URL(`${endpoint.replace(/\/+$/, "")}/${country}/search/1`);
        u.searchParams.set("app_id", appId);
        u.searchParams.set("app_key", appKey);
        u.searchParams.set("what", q);
        u.searchParams.set("results_per_page", String(perPage));
        u.searchParams.set("max_days_old", String(jobageDays));
        u.searchParams.set("sort_by", "date");
        u.searchParams.set("content-type", "application/json");

        const r = await fetch(u, {
          headers: { "User-Agent": "job-radar/1.0 (personal use)" },
        });
        if (!r.ok) {
          error = `HTTP ${r.status}`;
          continue;
        }
        const j: any = await r.json();
        for (const x of j.results ?? []) {
          out.push({
            id: String(x.id),
            title: x.title,
            company: x.company?.display_name ?? "—",
            url: x.redirect_url,
            location: x.location?.display_name ?? country.toUpperCase(),
            salary:
              x.salary_min && x.salary_max
                ? `${Math.round(x.salary_min)}-${Math.round(x.salary_max)}`
                : null,
            date: x.created ?? null,
            technologies: [],
            description: String(x.description ?? "").replace(/<[^>]+>/g, " "),
            remote: /remote|home\s*office/i.test(
              `${x.title ?? ""} ${x.location?.display_name ?? ""} ${x.description ?? ""}`,
            ),
          });
        }
      } catch (e) {
        error = String(e);
      }
    }
  }
  return { results: out, error };
}

/**
 * Bundesagentur für Arbeit ("Jobbörse") — Germany's federal employment agency.
 * This is the largest German job database by a wide margin and it carries much
 * of the same inventory StepStone lists, but unlike StepStone it publishes a
 * genuinely open API: no signup, no key of your own, no scraping.
 *
 * The published key "jobboerse-jobsuche" is a fixed public token, not a secret.
 * NOTE: the version matters — v4/v5 now return 403; v6 is current.
 *
 * Postings are viewed at jobboerse.arbeitsagentur.de using the reference
 * number, which is what we build the URL from.
 */
async function fetchArbeitsagentur(
  endpoint: string,
  queries: string[],
  jobageDays: number,
  perQuery: number,
): Promise<{ results: any[]; error?: string }> {
  const out: any[] = [];
  let error: string | undefined;

  for (const q of queries) {
    try {
      const u = new URL(endpoint);
      u.searchParams.set("was", q);
      u.searchParams.set("size", String(perQuery));
      u.searchParams.set("page", "1");
      // API takes a bucketed recency value, not an arbitrary day count.
      u.searchParams.set("veroeffentlichtseit", String(Math.min(100, Math.max(0, jobageDays))));
      u.searchParams.set("angebotsart", "1"); // 1 = ARBEIT, excludes training/self-employment

      const r = await fetch(u, {
        headers: {
          "X-API-Key": "jobboerse-jobsuche",
          "User-Agent": "job-radar/1.0 (personal use)",
        },
      });
      if (!r.ok) {
        error = `HTTP ${r.status}`;
        continue;
      }
      const j: any = await r.json();
      for (const x of j.ergebnisliste ?? []) {
        const ref = String(x.referenznummer ?? "");
        if (!ref) continue;
        const addr = x.stellenlokationen?.[0]?.adresse;
        const city = [addr?.ort, addr?.land === "DEUTSCHLAND" ? "Germany" : addr?.land]
          .filter(Boolean)
          .join(", ");
        out.push({
          id: ref,
          title: x.stellenangebotsTitel ?? x.hauptberuf ?? "—",
          company: x.firma ?? "—",
          url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(ref)}`,
          location: city || "Germany",
          // Most listings only carry a pay *category*, but some expose a real
          // range — use it when present.
          salary:
            x.gehaltsspanneVon && x.gehaltsspanneBis
              ? `${Math.round(x.gehaltsspanneVon)}-${Math.round(x.gehaltsspanneBis)} EUR/yr`
              : null,
          date: x.datumErsteVeroeffentlichung ?? null,
          technologies: [],
          description: [x.hauptberuf, ...(x.alleBerufe ?? [])].filter(Boolean).join(" "),
          remote: x.homeofficemoeglich === true,
        });
      }
    } catch (e) {
      error = String(e);
    }
  }
  return { results: out, error };
}

/**
 * Whole-term matcher.
 *
 * This used to be a plain `hay.includes(kw)`, on the theory that the keywords
 * are long enough to be unambiguous. They are not. `aci` is a substring of
 * "capacity", "facilities" and "efficacy", so it fired on 93 of 160 postings —
 * including every single off-domain one — and its +25 alone clears
 * mediumFitThreshold, which is how "Senior Full Stack Developer (JS, AWS)" and
 * "Scrum Master" ended up published as medium fit.
 *
 * `\b` is not usable here: it treats Polish and German letters as word
 * boundaries, so "sieciowy" would match `sieci` but "Netzwerkspezialist" would
 * falsely bound inside a compound. Explicit Unicode letter/digit lookarounds
 * behave correctly for both.
 *
 * Two deliberate concessions:
 *  - an optional plural suffix is allowed, so `data center` still matches
 *    "data centers" and `firewall` still matches "firewalls";
 *  - the boundary is only applied on a side where the term itself starts or
 *    ends with an alphanumeric, so `.net` and `c++` still match.
 */
const TERM_RE = new Map<string, RegExp>();
function termMatches(hay: string, term: string): boolean {
  let re = TERM_RE.get(term);
  if (!re) {
    const t = term.toLowerCase();
    const body = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const left = /^[\p{L}\p{N}]/u.test(t) ? "(?<![\\p{L}\\p{N}])" : "";
    const right = /[\p{L}\p{N}]$/u.test(t) ? "(?:e?s)?(?![\\p{L}\\p{N}])" : "";
    re = new RegExp(left + body + right, "u");
    TERM_RE.set(term, re);
  }
  return re.test(hay);
}

/**
 * termMatches plus the term's contextRequired guard: an ambiguous term only
 * counts when one of its context terms appears in the same text. "nexus" is
 * Cisco's switch line AND Sonatype's artifact repository; Java and DevOps
 * postings mention the latter constantly, and its +22 was carrying them.
 */
function termHits(hay: string, term: string, cfg: Cfg): boolean {
  if (!termMatches(hay, term)) return false;
  const context = cfg.scoring.contextRequired?.[term];
  return !context || context.some((c) => termMatches(hay, c));
}

type TitleVerdict = "on" | "weak" | "neutral" | "off";

/**
 * Title-first relevance: what kind of job does the TITLE say this is?
 *
 *   on      — names a strong networking signal (onDomainTitle). Relevant on
 *             its face, even next to an off-domain word: "Network Automation
 *             Engineer (Python)", "Pre-Sales Lead: Data Center Networking".
 *   off     — names a role of another discipline (hardOffDomainTitle), which
 *             decides the job even beside a networking word: "Software
 *             Engineer Rust & Network Security" is a software job. Or names
 *             another discipline (offDomainTitle) and no strong signal:
 *             "Senior Java Software Engineer", "DevOps Engineer". Rejected,
 *             however well the description scores.
 *   weak    — only a generic infrastructure word (weakOnDomainTitle:
 *             infrastructure, observability, telecom, validation, ...). Too
 *             generic to vouch for the job, and too weak to rescue an off
 *             title: "Python DevOps Engineer – Cloud Infrastructure" is off.
 *   neutral — neither ("Solution Architect", "Technical Lead").
 *
 * weak and neutral titles have to earn their place from the posting's domain
 * evidence — see assessJob(). The verdict used to be binary (vetoed or not),
 * so every title the off list did not anticipate was kept, and a description
 * listing python/terraform/git/ci-cd carried it to high fit.
 *
 * The off list is CV-aware: a discipline named in one of the CV's own job
 * titles is not off-domain for this candidate (see buildCvAlignment).
 * Without an onDomainTitle list the gate falls back to the plain veto.
 */
function titleGate(
  raw: any,
  cfg: Cfg,
  cv: CvAlignment | null = null,
): { verdict: TitleVerdict; term?: string } {
  const s = cfg.scoring;
  const title = String(raw.title ?? "").toLowerCase();
  const strongTerms = s.onDomainTitle ?? [];

  const hard = (cv?.hardOffDomainTitle ?? s.hardOffDomainTitle ?? []).find((t) => termMatches(title, t));
  if (hard) return { verdict: "off", term: hard };
  const own = cv?.roleTitles.find((t) => termMatches(title, t));
  if (own) return { verdict: "on", term: own };
  const strong = strongTerms.find((t) => termMatches(title, t));
  if (strong) return { verdict: "on", term: strong };
  const off = (cv?.offDomainTitle ?? s.offDomainTitle ?? []).find((t) => termMatches(title, t));
  if (off) return { verdict: "off", term: off };
  if (strongTerms.length === 0) return { verdict: "on" }; // no title vocabulary: veto only
  const weak = (s.weakOnDomainTitle ?? []).find((t) => termMatches(title, t));
  if (weak) return { verdict: "weak", term: weak };
  return { verdict: "neutral" };
}

/** The off-domain term that vetoes this title, or null. Kept for callers of the old veto. */
function offDomain(raw: any, cfg: Cfg, cv: CvAlignment | null = null): string | null {
  const gate = titleGate(raw, cfg, cv);
  return gate.verdict === "off" ? (gate.term ?? null) : null;
}

/**
 * What the uploaded CV says about the candidate, reduced to what scoring needs.
 *
 * `skills` holds every scoring term (config weights + cvAlignment.vocabulary)
 * that genuinely appears in the CV text, matched with the same whole-term rule
 * as job postings, so "aci" in the CV is not satisfied by "capacity".
 */
interface CvAlignment {
  skills: Set<string>;
  senior: boolean;
  /** offDomainTitle / hardOffDomainTitle minus the disciplines the CV's own job titles name. */
  offDomainTitle: string[];
  hardOffDomainTitle: string[];
  /** The CV's own searchable role titles ("technical consulting engineer"): on-domain by definition. */
  roleTitles: string[];
}

/**
 * `cvTitles` are the job titles mined from the CV (cv-keywords.ts mineTitles).
 * They make the title veto CV-aware: a candidate who has held a "Java
 * Developer" title keeps Java roles; this CV names no software title, so
 * "Senior Java Software Engineer" stays vetoed. Titles, not the whole CV text:
 * "validated platforms and software" in a bullet point is not a discipline.
 *
 * `roleTitles` are the CV's role titles worth searching for (the "title"
 * keywords of cv-keywords.ts). A posting carrying one is the candidate's own
 * kind of job, whatever else its title says.
 */
function buildCvAlignment(
  cvText: string,
  cfg: Cfg,
  cvTitles: string[] = [],
  roleTitles: string[] = [],
): CvAlignment | null {
  const ca = cfg.scoring.cvAlignment;
  const text = cvText.toLowerCase();
  if (!ca?.enabled || !text.trim()) return null;
  const vocab = new Set([...Object.keys(cfg.scoring.positive), ...ca.vocabulary.map((v) => v.toLowerCase())]);
  const skills = new Set(Array.from(vocab).filter((t) => termMatches(text, t)));
  const senior = ca.seniorCvSignals.some((s) => termMatches(text, s.toLowerCase()));
  const titles = cvTitles.map((t) => t.toLowerCase());
  const notHeld = (term: string) => !titles.some((t) => termMatches(t, term));
  return {
    skills,
    senior,
    offDomainTitle: (cfg.scoring.offDomainTitle ?? []).filter(notHeld),
    hardOffDomainTitle: (cfg.scoring.hardOffDomainTitle ?? []).filter(notHeld),
    roleTitles: roleTitles.map((t) => t.toLowerCase()),
  };
}

function scoreJob(raw: any, cfg: Cfg, cv: CvAlignment | null = null) {
  const title = String(raw.title ?? "").toLowerCase();
  const hay = [
    raw.title ?? "",
    raw.description ?? "",
    (raw.technologies ?? []).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  /**
   * The part of the score that is evidence of the DOMAIN: positive terms other
   * than supportingTerms, CV vocabulary extras excluded. python, terraform,
   * git and ci/cd sit on every DevOps posting, so they rank a job that is
   * already relevant but must not make one relevant. assessJob() gates on this.
   */
  let domainScore = 0;
  const matched: string[] = [];
  /** Matched terms the CV also contains — the evidence behind the fit. */
  const cvMatched: string[] = [];
  const ca = cv ? cfg.scoring.cvAlignment : undefined;
  const supporting = new Set((cfg.scoring.supportingTerms ?? []).map((t) => t.toLowerCase()));

  for (const [kw, base] of Object.entries(cfg.scoring.positive)) {
    if (!termHits(hay, kw, cfg)) continue;
    // With a CV on file, a configured term the CV backs up is worth more than
    // one it does not: the config lists aspirational terms ("network
    // architect", "pyats", "sd-wan") next to proven ones ("aci", "ccie").
    const inCv = cv?.skills.has(kw) ?? false;
    const w = ca ? Math.round(base * (inCv ? ca.inCvMultiplier : ca.notInCvMultiplier)) : base;
    // A term in the title is evidence about the role; the same term buried in a
    // description is often just a listed nice-to-have. Weight it accordingly so
    // real network roles outrank postings that merely mention the stack.
    const points = w + (termMatches(title, kw) ? Math.round(w * 0.5) : 0);
    score += points;
    if (!supporting.has(kw)) domainScore += points;
    matched.push(kw);
    if (inCv) cvMatched.push(kw);
  }

  if (cv && ca) {
    // CV skills the config never weighted (NDO, MDS, Intersight, RoCE, ...).
    // Capped, so a long tech list in a description cannot carry a posting.
    let extra = 0;
    for (const kw of cv.skills) {
      if (kw in cfg.scoring.positive || !termHits(hay, kw, cfg)) continue;
      extra += ca.extraSkillWeight + (termMatches(title, kw) ? Math.round(ca.extraSkillWeight * 0.5) : 0);
      matched.push(kw);
      cvMatched.push(kw);
    }
    score += Math.min(extra, ca.extraSkillCap);

    if (cv.senior && ca.seniorityTitleTerms.some((t) => termMatches(title, t.toLowerCase()))) {
      score += ca.seniorityTitleBonus;
    }

    // The candidate's own role title in the posting's title. Titles already
    // weighted as positive terms ("network engineer") have been counted above.
    const own = cv.roleTitles.find((t) => !(t in cfg.scoring.positive) && termMatches(title, t));
    if (own) {
      score += ca.ownTitleBonus ?? 0;
      domainScore += ca.ownTitleBonus ?? 0;
    }
  }

  for (const [kw, w] of Object.entries(cfg.scoring.negative)) {
    if (!termMatches(hay, kw)) continue;
    score += w;
    if (termMatches(title, kw)) score += w; // doubled when it names the role
  }

  const polishGate = cfg.scoring.polishOnlySignals.some((s) => termMatches(hay, s.toLowerCase()));

  const fit: Job["fit"] =
    score >= cfg.scoring.highFitThreshold
      ? "high"
      : score >= cfg.scoring.mediumFitThreshold
        ? "medium"
        : "low";

  return { score, domainScore, matched, cvMatched, polishGate, fit };
}

/**
 * Should this posting be on the dashboard, and at what fit?
 *
 * An "on" title is judged by its score alone, as before. A weak or neutral
 * title must show domain evidence — domainScore, which supporting terms and
 * CV extras cannot inflate — of weakTitleMinDomainScore / neutralTitleMin-
 * DomainScore, and a neutral one rates at most medium: with nothing in the
 * title vouching for it, a description is not enough for "high".
 */
function assessJob(raw: any, cfg: Cfg, cv: CvAlignment | null = null) {
  const gate = titleGate(raw, cfg, cv);
  const scored = scoreJob(raw, cfg, cv);
  const s = cfg.scoring;
  let fit = scored.fit;
  let reject: "off-domain" | "no-evidence" | "low-fit" | null = null;

  if (gate.verdict === "off") {
    reject = "off-domain";
  } else if (gate.verdict === "weak" || gate.verdict === "neutral") {
    const floor =
      gate.verdict === "weak"
        ? (s.weakTitleMinDomainScore ?? s.mediumFitThreshold)
        : (s.neutralTitleMinDomainScore ?? s.highFitThreshold);
    if (scored.domainScore < floor) reject = "no-evidence";
    else if (gate.verdict === "neutral" && fit === "high") fit = "medium";
  }
  if (!reject && fit === "low") reject = "low-fit";

  return { ...scored, fit, verdict: gate.verdict, reject };
}

/**
 * assessJob for a job from an earlier payload. Stored jobs keep no
 * description, so the evidence is rebuilt from the terms that matched when it
 * was scraped. That is enough to re-apply the title gate and the evidence
 * floor; the stored score is kept, only the fit cap is re-applied.
 */
function assessStoredJob(job: Job, cfg: Cfg, cv: CvAlignment | null) {
  const a = assessJob(
    { title: job.title, description: (job.matched ?? []).join(" ; "), technologies: job.technologies ?? [] },
    cfg,
    cv,
  );
  const fit: Job["fit"] = a.verdict === "neutral" && job.fit === "high" ? "medium" : job.fit;
  return { keep: a.reject === null, reject: a.reject, fit };
}

/** Fold `dupe`'s application links into `card`, so collapsing two copies of a vacancy loses no link. */
function mergeSources(card: Job, dupe: Job) {
  const all = [
    ...(card.sources ?? [{ portal: card.portal, url: card.url }]),
    ...(dupe.sources ?? [{ portal: dupe.portal, url: dupe.url }]),
  ];
  const seen = new Set<string>();
  card.sources = all.filter((s) => {
    const k = canonKey(s.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The payload's summary fields, shared by a scrape and --rescore. */
function payloadCounts(all: Job[]) {
  return {
    counts: {
      total: all.length,
      new: all.filter((j) => j.isNew).length,
      high: all.filter((j) => j.fit === "high").length,
      medium: all.filter((j) => j.fit === "medium").length,
      pl: all.filter((j) => j.region === "PL").length,
      eu: all.filter((j) => j.region === "EU").length,
    },
    // Per-country tallies drive the dynamic tab bar.
    byCountry: all.reduce<Record<string, number>>((acc, j) => {
      const c = j.country || (j.region === "PL" ? "PL" : "EU");
      acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Metadata about the most recently uploaded CV, so the dashboard can show which
 * CV is currently on file. The CV itself is only stored, never parsed — search
 * queries live in config.json and stay under manual control.
 */
function readCvMeta() {
  const p = join(DATA, "cv", "current.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Rewrite the queries of every enabled source for this run.
 *
 * Applied once, centrally, immediately after loadConfig() — every downstream
 * consumer (step counting, the portal worker pool, the API sources) reads
 * `pc.queries` / `sc.queries`, so overriding here is sufficient and there is no
 * second place that can drift out of sync.
 *
 * Two independent inputs:
 *
 *   --queries "a,b,c"   Ad-hoc run. REPLACES the configured queries outright.
 *                       Used by the dashboard's on-demand search. Expansion has
 *                       already happened server-side, so the list arrives final.
 *
 *   --cv-keywords       Appends CV-derived keywords to the configured queries.
 *                       Additive on purpose: the curated config queries are the
 *                       baseline and must not be lost.
 *
 * config.json is never written to. An override lives for the duration of one
 * process, which is what keeps the 09:00 scheduled run reproducible.
 *
 * Two prunes keep the run from paying for queries that cannot add anything:
 *
 *   - A CV term is dropped for a source that already searches a query made of a
 *     subset of its words. These keyword searches only narrow as words are
 *     added, so "cisco network engineer" adds nothing where "network" or
 *     "network engineer" already runs, yet costs a sweep of every location.
 *   - Any query whose own text the title gate rejects ("devops engineer",
 *     "site reliability", "sales engineer" from a keyword expansion) is
 *     skipped: every posting it returns would be thrown away.
 *
 * Returns the queries skipped by the second prune, for the run log.
 */
function applyQueryOverrides(
  cfg: Cfg,
  override: string[] | null,
  extra: string[],
  cv: CvAlignment | null = null,
): string[] {
  const wordsOf = (q: string) => q.toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter(Boolean);
  const coveredBy = (q: string, others: string[]) => {
    const w = new Set(wordsOf(q));
    return others.some((o) => {
      const ow = wordsOf(o);
      return ow.length > 0 && ow.every((x) => w.has(x));
    });
  };
  // Broadest first, so a wider CV term is kept and covers its narrower siblings.
  const extras = [...extra].sort((a, b) => wordsOf(a).length - wordsOf(b).length);
  const skipped = new Set<string>();

  const merge = (existing: string[] | undefined): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (q: string, isExtra: boolean) => {
      const t = String(q).trim();
      const k = t.toLowerCase();
      if (!t || seen.has(k)) return;
      if (isExtra && coveredBy(t, out)) return;
      if (titleGate({ title: t }, cfg, cv).verdict === "off") {
        skipped.add(t);
        return;
      }
      seen.add(k);
      out.push(t);
    };
    for (const q of override ?? existing ?? []) add(q, false);
    for (const q of extras) add(q, true);
    return out;
  };

  for (const pc of Object.values(cfg.portals ?? {})) {
    if (!pc?.enabled) continue;
    pc.queries = merge(pc.queries);
  }
  for (const sc of Object.values(cfg.apiSources ?? {})) {
    if (!sc?.enabled) continue;
    sc.queries = merge(sc.queries);
  }
  return [...skipped];
}

/**
 * Delete offer-cache entries older than the portal CLIs' 72h TTL. justjoin and
 * nofluffjobs write one file per offer under data/cache/<portal>/ (--cache-dir
 * in config.json) and never delete, so without this the directory only grows.
 */
function pruneDetailCache(root: string, maxAgeMs = 72 * 3600_000): number {
  if (!existsSync(root)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const sub of readdirSync(root, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const dir = join(root, sub.name);
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file);
          removed++;
        }
      } catch (e) {
        console.log(`[cache] could not prune ${file}: ${e}`);
      }
    }
  }
  return removed;
}

/**
 * CV-aware scoring inputs, or null without a usable CV. Never throws: any
 * failure leaves config-only scoring, exactly as without a CV.
 */
async function loadCvAlignment(cfg: Cfg): Promise<CvAlignment | null> {
  try {
    const { readCvText, mineTitles, keywordsFromText } = await import("./cv-keywords.ts");
    const text = readCvText().text;
    const roleTitles = keywordsFromText(text)
      .filter((k) => k.source === "title")
      .map((k) => k.term);
    return buildCvAlignment(text, cfg, [...mineTitles(text).keys()], roleTitles);
  } catch (e) {
    console.log(`CV alignment skipped: ${e}`);
    return null;
  }
}

async function main() {
  const cfg = loadConfig();
  const jobage = argVal("--jobage") ?? String(cfg.jobageDays);

  // Ad-hoc override: a comma-separated list replaces the configured queries.
  const rawQueries = argVal("--queries");
  const queryOverride = rawQueries
    ? rawQueries.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  // CV-derived keywords are appended to every run unless --no-cv-keywords.
  // Failure here must never abort a scrape: a missing or unparsable CV simply
  // means the configured queries run on their own, exactly as before.
  let cvExtra: string[] = [];
  // Applies to ad-hoc --queries runs too: the dashboard's search box always
  // passes --queries, and skipping CV keywords there meant "From your CV" terms
  // were never searched when scraping from the UI.
  if (!args.includes("--no-cv-keywords")) {
    try {
      const { cvKeywordsCached } = await import("./cv-keywords.ts");
      const res = cvKeywordsCached({ limit: CV_KEYWORD_LIMIT });
      // Slice explicitly: the cache ignores `limit` and holds whatever list the
      // last caller wrote (the UI's 12), so the count was previously undefined.
      cvExtra = res.keywords.slice(0, CV_KEYWORD_LIMIT).map((k) => k.term);
      if (cvExtra.length) {
        console.log(`CV keywords (${res.cvFile ?? "none"}): ${cvExtra.join(", ")}`);
      }
    } catch (e) {
      console.log(`CV keyword extraction skipped: ${e}`);
    }
  }

  // CV-aware scoring. Independent of --no-cv-keywords (that flag is about which
  // queries run, not how results rank). Loaded before the queries are merged
  // because the title gate it carries also prunes queries.
  const cvAlign = await loadCvAlignment(cfg);
  if (cvAlign) {
    console.log(
      `CV alignment: ${cvAlign.skills.size} CV skills recognised${cvAlign.senior ? ", senior profile" : ""}`,
    );
  }

  const skippedQueries = applyQueryOverrides(cfg, queryOverride, cvExtra, cvAlign);
  if (queryOverride) console.log(`Ad-hoc queries: ${queryOverride.join(", ")}`);
  if (skippedQueries.length) {
    console.log(`Skipped queries the title gate would reject: ${skippedQueries.join(", ")}`);
  }

  mkdirSync(DATA, { recursive: true });
  const pruned = pruneDetailCache(join(DATA, "cache"));
  if (pruned) console.log(`[cache] pruned ${pruned} expired offer pages`);

  const seenPath = join(DATA, "seen.json");
  const seen: Record<string, string> = existsSync(seenPath)
    ? JSON.parse(readFileSync(seenPath, "utf8"))
    : {};

  // -------------------------------------------------------------------------
  // Progress reporting.
  //
  // The dashboard cannot infer completion from the log text, so the scraper
  // announces its own denominator up front and then ticks it. Emitted as a
  // single-line machine marker on stdout; serve.ts parses these out of the log
  // stream so they never reach the human-readable log pane.
  //
  // One unit of work = one CLI query (portal x location x query) or one API
  // source, plus a final unit for dedup + writing the payload out.
  // -------------------------------------------------------------------------
  let cliSteps = 0;
  for (const pc of Object.values(cfg.portals)) {
    if (!pc.enabled || !inScope(pc.scopes)) continue;
    // Exact product — this must match the nested loop below exactly, or the
    // bar can never reach 100%.
    cliSteps += pc.locations.length * pc.queries.length;
  }
  const apiSteps = Object.values(cfg.apiSources ?? {}).filter(
    (s) => s.enabled && inScope(s.scopes),
  ).length;
  const totalSteps = cliSteps + apiSteps + 1; // +1 = dedup & write
  let doneSteps = 0;

  const progress = (label: string, advance = true) => {
    if (advance) doneSteps = Math.min(doneSteps + 1, totalSteps);
    const percent = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;
    console.log(
      `@@PROGRESS ${JSON.stringify({ done: doneSteps, total: totalSteps, percent, label })}`,
    );
  };

  progress("Starting…", false);

  const jobs = new Map<string, Job>();
  const health: {
    portal: string;
    region: string;
    query: string;
    location: string;
    status: string;
    count: number;
  }[] = [];

  /** Shared ingestion path for both CLI portals and API sources. */
  /**
   * Best-effort country label for a posting. A source that serves exactly one
   * country (linkedinDe, freehireNl, pracuj) declares it via its single scope;
   * multi-country API sources (himalayas covers DE+NL+EU) have to be read off
   * the posting's own location text, falling back to EU for genuinely
   * pan-European remote roles.
   */
  const COUNTRY_HINTS: [RegExp, string][] = [
    [/poland|polska|krak[oó]w|warsaw|warszawa|wroc[lł]aw|gda[nń]sk|pozna[nń]|katowice/i, "PL"],
    [/germany|deutschland|berlin|munich|m[uü]nchen|hamburg|frankfurt|cologne|k[oö]ln/i, "DE"],
    [/netherlands|holland|amsterdam|rotterdam|utrecht|eindhoven|the hague|den haag/i, "NL"],
  ];

  const deriveCountry = (declared: string[] | undefined, region: string, location: string) => {
    // A source scoped to exactly one country is authoritative.
    const single = (declared ?? []).filter((x) => x !== "EU" && x !== "ALL");
    if (single.length === 1) return single[0];
    for (const [re, code] of COUNTRY_HINTS) if (re.test(location)) return code;
    return region === "PL" ? "PL" : "EU";
  };

  /** How many postings the title veto dropped this run — reported in the summary. */
  let rejectedOffDomain = 0;
  /** Weak/neutral titles whose posting showed too little domain evidence. */
  let rejectedNoEvidence = 0;
  /** Jobs discarded for their language requirements (languageGate.dropAtScrape only). */
  let rejectedLanguage = 0;

  const ingest = (
    portal: string,
    region: "PL" | "EU",
    results: any[],
    fallbackLocation = "",
    scopes?: string[],
    localMarket = false,
  ) => {
    let kept = 0;
    for (const r of results) {
      if (!r?.url) continue;
      // Dedup on the canonical URL, not on portal+id: justjoin returns the
      // same posting under different ids for different city queries, which
      // produced visible duplicate cards.
      const key = canonKey(r.url);
      if (jobs.has(key)) continue;

      // The title is judged before the score is trusted. A description can
      // out-score reality — a Java or DevOps posting that lists Python,
      // Terraform, Git and CI/CD scores like a network role — but a title that
      // names another discipline is not ambiguous, and one that names nothing
      // has to prove itself with real domain terms. See assessJob().
      const { score, matched, polishGate, fit, reject } = assessJob(r, cfg, cvAlign);
      if (reject === "off-domain") rejectedOffDomain++;
      if (reject === "no-evidence") rejectedNoEvidence++;
      if (reject) continue; // low-fit drops keep the payload small and useful

      // The strict gate answers "could I do this from Poland?", which is the
      // right question for the EU-Remote lane. It is the WRONG question for a
      // country lane: a Berlin or Amsterdam role is a legitimate result for
      // "search in Germany" even though it is on-site. Applying the gate there
      // is why the Germany tab sat at zero. Country-scoped sources therefore
      // opt out via localMarket, and only the EU lane stays strict.
      let euEvidence: string | undefined;
      let germanGate = false;
      if (region === "EU" && !localMarket) {
        const gate = euEligible(r, cfg);
        if (!gate.ok) continue; // strict: drop anything not provably EU-remote
        euEvidence = gate.evidence;
        germanGate = gate.germanGate;
      }

      const job: Job = {
        id: String(r.id ?? r.url),
        portal,
        region,
        title: r.title ?? "(untitled)",
        company: r.company ?? "—",
        location: r.location ?? fallbackLocation ?? "—",
        url: r.url,
        salary: r.salary ?? null,
        date: r.date ?? null,
        contractTypes: r.contractTypes ?? [],
        workModes: r.workModes ?? (r.work_mode ? [r.work_mode] : []),
        remote: Boolean(r.remote ?? r.work_mode === "remote"),
        technologies: r.technologies ?? r.skills ?? [],
        score,
        fit,
        matched,
        polishGate,
        euEvidence,
        germanGate,
        country: deriveCountry(scopes, region, String(r.location ?? fallbackLocation ?? "")),
        ...(r.postingLanguage ? { postingLanguage: String(r.postingLanguage).toLowerCase() } : {}),
        isNew: !(key in seen),
      };
      // Which non-English languages the posting requires. Nothing is dropped
      // here: the dashboard's "Language req." menu hides by these tags, and a
      // title-only result gets its advert read after ingest (readDescriptions).
      tagLanguages(job, r, cfg);
      jobs.set(key, job);
      kept++;
    }
    return kept;
  };

  // -------------------------------------------------------------------------
  // Execution plan.
  //
  // Previously every portal query ran strictly one after another, so the run
  // took the SUM of all portals. Measured: justjoin ~31s and nofluffjobs ~27s
  // per query, because those CLIs fetch the listing page and then up to 50
  // individual detail pages sequentially. With the expanded query set that put
  // a full run near an hour.
  //
  // Now: hosts run concurrently with each other, and the API sources alongside
  // them. Each host runs its queries through ONE small worker pool. Entries
  // that drive the same CLI share it, because they hit the same site:
  // linkedin, linkedinDe, linkedinNl and linkedinEu each used to get their own
  // 4-lane pool, which put 16 requests on LinkedIn at once and drew HTTP 429
  // on 70 of 104 calls. A shared pool runs at the lowest `concurrency` and the
  // longest gap among its members (default 1 lane, so a portal is opt-in to
  // parallelism and stays polite). Wall time is roughly the slowest host.
  //
  // Safety: JS is single-threaded and ingest()/health.push() are synchronous, so
  // there is no torn state — interleaving only ever happens at an await point.
  // The one visible effect is that when two sources carry the same posting, the
  // one kept is now whichever finished first. The final sort is deterministic.
  // -------------------------------------------------------------------------

  type PortalCfg = Cfg["portals"][string];
  type Call = { portal: string; pc: PortalCfg; location: string; query: string };
  const byCli = new Map<string, Call[]>();
  for (const [portal, pc] of Object.entries(cfg.portals)) {
    if (!pc.enabled || !inScope(pc.scopes)) {
      health.push({
        portal,
        region: pc.region,
        query: "*",
        location: "*",
        status: pc.enabled ? `skipped (scope ${SCOPE})` : "disabled",
        count: 0,
      });
      continue;
    }
    const calls = byCli.get(pc.cli ?? portal) ?? [];
    for (const location of pc.locations) {
      for (const query of pc.queries) calls.push({ portal, pc, location, query });
    }
    byCli.set(pc.cli ?? portal, calls);
  }

  // Pause each worker after a call. Explicit gapMs always wins so a
  // rate-limit-sensitive portal can run 2 lanes AND still space its requests
  // out — nofluffjobs returns HTTP 429 without this.
  const gapOf = (portal: string, pc: PortalCfg) =>
    pc.gapMs ?? ((pc.concurrency ?? 1) > 1 ? 0 : portal === "nofluffjobs" ? 4000 : 1200);

  const portalTasks = [...byCli.entries()].map(([cli, calls]) => {
    const members = [...new Map(calls.map((c) => [c.portal, c.pc])).entries()];
    const concurrency = Math.max(1, Math.min(...members.map(([, pc]) => pc.concurrency ?? 1)));
    const gap = Math.max(...members.map(([portal, pc]) => gapOf(portal, pc)));

    return pool(calls, concurrency, async ({ portal, pc, location, query }) => {
      const a = ["search"];
      if (query) a.push("-q", query);
      if (location) a.push("-l", location);
      a.push("--jobage", jobage, "-n", String(pc.limit), "--format", "json");
      if (pc.extraArgs?.length) a.push(...pc.extraArgs);

      const { results, error } = await runCli(cli, a);
      health.push({
        portal,
        region: pc.region,
        query: query || "*",
        location: location || "*",
        status: error ? `error: ${error.slice(0, 120)}` : "ok",
        count: results.length,
      });

      ingest(portal, pc.region, results, location, pc.scopes, pc.localMarket === true);
      progress(`${portal} — ${query || "*"}${location ? ` @ ${location}` : ""}`);

      if (gap) await new Promise((r) => setTimeout(r, gap));
    });
  });

  // API sources (no CLI): the fetchers above plus the boards in sources.ts.
  // Each carries its own region and scopes; EU-region ones that are not
  // localMarket go through the same strict euEligible() gate as the EU portals.
  // They are independent HTTP calls against hosts no portal uses, so they start
  // right away instead of queueing behind the slowest portal.
  const apiTasks = Object.entries(cfg.apiSources ?? {}).map(async ([name, sc]) => {
    if (!sc.enabled) {
      health.push({
        portal: name,
        region: sc.region,
        query: "*",
        location: "*",
        status: "disabled",
        count: 0,
      });
      return;
    }
    if (!inScope(sc.scopes)) {
      health.push({
        portal: name,
        region: sc.region,
        query: "*",
        location: "*",
        status: `skipped (scope ${SCOPE})`,
        count: 0,
      });
      return;
    }

    // `fetcher` lets two entries share one implementation (germantechjobs and
    // devitjobsNl are the same platform on different boards).
    const kind = sc.fetcher ?? name;
    let res: { results: any[]; error?: string };
    if (kind === "remotive") {
      res = await fetchRemotive(sc.endpoint, sc.queries ?? [], sc.limit ?? 40);
    } else if (kind === "arbeitnow") {
      res = await fetchArbeitnow(sc.endpoint, sc.pages ?? 2);
    } else if (kind === "remoteok") {
      res = await fetchRemoteOk(sc.endpoint);
    } else if (kind === "arbeitsagentur") {
      res = await fetchArbeitsagentur(
        sc.endpoint,
        sc.queries ?? [],
        Number(jobage),
        sc.limit ?? 25,
      );
    } else if (kind === "himalayas") {
      res = await fetchHimalayas(sc.endpoint, sc.queries ?? [], sc.countries ?? []);
    } else if (kind === "adzuna") {
      res = await fetchAdzuna(
        sc.endpoint,
        sc.queries ?? [],
        sc.countries ?? [],
        sc.appId ?? "",
        sc.appKey ?? "",
        Number(jobage),
        sc.limit ?? 20,
      );
    } else if (kind === "bulldogjob") {
      res = await fetchBulldogjob(sc.endpoint, sc.filters ?? []);
    } else if (kind === "eures") {
      res = await fetchEures(sc.endpoint, sc.queries ?? [], sc.countries ?? ["pl"], Number(jobage), sc.limit ?? 50);
    } else if (kind === "devitjobs") {
      res = await fetchDevitJobs(sc.endpoint, sc.site, sc.queries ?? [], Number(jobage));
    } else if (kind === "jobicy") {
      res = await fetchJobicy(sc.endpoint, sc.geos ?? ["europe"], sc.limit ?? 100, Number(jobage));
    } else if (kind === "weworkremotely") {
      res = await fetchWeWorkRemotely(sc.feeds ?? [sc.endpoint], Number(jobage));
    } else if (kind === "careers") {
      try {
        const companies = loadCompanies(join(HERE, sc.companies ?? "companies.json"));
        const careers = await fetchCareers(companies, sc.queries ?? [], Number(jobage), {
          concurrency: sc.concurrency,
          gapMs: sc.gapMs,
          writeCache: !DRY,
        });
        console.log(`careers: ${summarizeCareers(careers.report)}`);
        for (const r of careers.report) if (r.error) console.log(`  careers: ${r.name}: ${r.error}`);
        res = careers;
      } catch (e) {
        res = { results: [], error: `company list: ${e instanceof Error ? e.message : String(e)}` };
      }
    } else {
      res = { results: [], error: "no fetcher implemented" };
    }

    const kept = ingest(name, sc.region, res.results, "", sc.scopes, sc.localMarket === true);
    health.push({
      portal: name,
      region: sc.region,
      // What the source was actually asked for: its filters, regions or feeds
      // where it does not take keyword queries.
      query: (sc.filters ?? sc.geos ?? sc.feeds ?? sc.queries ?? ["*"]).join(", "),
      location: "EU-remote",
      status: res.error ? `error: ${res.error.slice(0, 120)}` : "ok",
      // Report both, so a source that fetches a lot but survives the gate rarely
      // is visibly distinguishable from a source that is simply down.
      count: kept,
    });
    progress(`${name} — API source`);
  });

  await Promise.all([...portalTasks, ...apiTasks]);

  // Second dedup pass — collapse one posting into one card.
  //
  // Two distinct duplications happen, and both used to reach the dashboard:
  //   1. within a portal: justjoin publishes a posting separately per city,
  //      with a different slug and id each time;
  //   2. across portals: the same vacancy is listed on justjoin AND pracuj AND
  //      linkedin AND an aggregator, each with its own URL. 15 of 287 postings
  //      in a recent run were the same job seen 2-3 times this way.
  //
  // Keying on portal+company+title only ever fixed (1). Dropping `portal` from
  // the key fixes both, so the dashboard shows one card per real vacancy. Every
  // source is preserved on `sources` so no application link is lost.
  const collapsed = new Map<string, Job>();
  progress("Deduplicating & writing results…", false);

  // Which portal's record to keep when the same vacancy is found twice. The PL
  // boards carry structured salary and technology data; the aggregators mostly
  // relay a title and link out, so they lose. An employer's own career site is
  // the original listing, so it outranks every relay. Anything unlisted sorts last.
  const PORTAL_RANK = [
    "justjoin", "nofluffjobs", "pracuj", "bulldogjob", "careers",
    "linkedin", "linkedinDe", "linkedinNl", "linkedinEu",
    "arbeitsagentur", "eures", "germantechjobs", "devitjobsNl", "arbeitnow", "adzuna",
    "freehire", "freehireDe", "freehireNl",
    "himalayas", "jobicy", "weworkremotely", "remotive", "remoteok",
  ];
  const rank = (p: string) => {
    const i = PORTAL_RANK.indexOf(p);
    return i === -1 ? PORTAL_RANK.length : i;
  };
  /** True when `j` is the better record to keep as the visible card. */
  const better = (j: Job, prev: Job) =>
    Number(Boolean(j.salary)) - Number(Boolean(prev.salary)) ||
    (j.technologies?.length ?? 0) - (prev.technologies?.length ?? 0) ||
    rank(prev.portal) - rank(j.portal) ||
    j.score - prev.score;

  for (const j of jobs.values()) {
    // jobIdentity() is "" without a company or title; keying on that merged
    // every such posting into one card, so those fall back to their own URL.
    const key = jobIdentity(j.company, j.title) || canonKey(j.url);
    const prev = collapsed.get(key);
    if (!prev) {
      j.sources = [{ portal: j.portal, url: j.url }];
      collapsed.set(key, j);
      continue;
    }

    const sources = [...(prev.sources ?? []), { portal: j.portal, url: j.url }];
    const locs = new Set(
      [...prev.location.split(" / "), j.location].map((s) => s.trim()).filter(Boolean),
    );
    const location = [...locs].join(" / ");
    // A vacancy is only "new" if no copy of it has been seen before — otherwise
    // yesterday's dismissed job returns to the top of the list wearing a
    // different portal's URL.
    const isNew = prev.isNew && j.isNew;

    const winner = better(j, prev) > 0 ? j : prev;
    const loser = winner === j ? prev : j;
    winner.sources = sources;
    winner.location = location;
    winner.isNew = isNew;
    winner.salary = winner.salary ?? loser.salary;
    if ((loser.technologies?.length ?? 0) > (winner.technologies?.length ?? 0)) {
      winner.technologies = loser.technologies;
    }
    collapsed.set(key, winner);
  }

  // Stamp the portal-independent key onto every card so the dashboard can match
  // saved pipeline state without depending on a URL that changes between runs.
  for (const j of collapsed.values()) j.identity = jobIdentity(j.company, j.title);

  let all = [...collapsed.values()].sort(
    (a, b) => Number(b.isNew) - Number(a.isNew) || b.score - a.score,
  );

  // ---------------------------------------------------------------------------
  // Scoped runs must not destroy the rest of the dashboard.
  //
  // A "Germany" scrape only queries the DE sources, so on its own it would
  // write a jobs.json containing nothing but German results — silently wiping
  // every Polish job the user was still working through. Carry forward the
  // previous run's jobs for every portal this run did NOT query, so choosing a
  // scope narrows what gets REFRESHED, not what you can see.
  //
  // A full run (--scope ALL) queries everything and so replaces everything,
  // which is what the daily 09:00 job wants.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Carry-forward.
  //
  // A portal "owns" its slice of the payload only if it actually managed to
  // fetch something this run. Two cases must not destroy existing data:
  //
  //   1. Scoped runs. A "Germany" scrape never queries the Polish portals, so
  //      on its own it would write a payload with no Polish jobs at all.
  //   2. Failed portals — including during a full ALL run. If every LinkedIn-DE
  //      call errors out on a network blip, Germany would silently drop to zero
  //      even though nothing changed on the job market.
  //
  // So: a portal that returned at least one successful call replaces its own
  // jobs; every other still-enabled portal keeps what it had. A portal that
  // succeeded but found nothing is genuinely empty and is NOT carried, and a
  // portal disabled in config is dropped on purpose.
  // ---------------------------------------------------------------------------
  let carriedOver = 0;
  let carriedDropped = 0;
  {
    const refreshed = new Set<string>();
    for (const h of health) if (h.status === "ok") refreshed.add(h.portal);

    const stillConfigured = new Set<string>([
      ...Object.entries(cfg.portals).filter(([, v]) => v.enabled).map(([k]) => k),
      ...Object.entries(cfg.apiSources ?? {}).filter(([, v]) => v.enabled).map(([k]) => k),
    ]);

    const failedButEnabled = [...stillConfigured].filter((p) => !refreshed.has(p));
    if (failedButEnabled.length) {
      console.log(
        `[carry] no successful call from: ${failedButEnabled.join(", ")} — ` +
          `keeping their previous results rather than dropping them`,
      );
    }

    const prevPath = join(DATA, "jobs.json");
    if (existsSync(prevPath)) {
      try {
        const prev = JSON.parse(readFileSync(prevPath, "utf8"));
        const seenUrls = new Set(all.map((j) => canonKey(j.url)));
        const byIdentity = new Map(all.filter((j) => j.identity).map((j) => [j.identity!, j]));
        const kept: Job[] = [];
        for (const j of prev.jobs ?? []) {
          if (refreshed.has(j.portal)) continue; // this run refreshed it
          if (!stillConfigured.has(j.portal)) continue; // deliberately disabled
          if (seenUrls.has(canonKey(j.url))) continue; // already present
          // Held to today's relevance rules, not the ones it was scraped under:
          // otherwise a posting the title gate now rejects lives on for as long
          // as its portal keeps failing.
          const verdict = assessStoredJob(j, cfg, cvAlign);
          if (!verdict.keep) {
            carriedDropped++;
            continue;
          }
          // The same vacancy is already on a card (found fresh on another board,
          // or carried from one): add this link to that card instead of showing
          // the vacancy twice. URL-only dedup let 23 such twins through.
          const identity = j.identity || jobIdentity(j.company, j.title);
          const twin = identity ? byIdentity.get(identity) : undefined;
          if (twin) {
            mergeSources(twin, j);
            continue;
          }
          // Backfill country on payloads written before country tagging existed,
          // so carried-over jobs still land in the right per-country tab.
          const carried: Job = {
            ...j,
            identity: identity || undefined,
            fit: verdict.fit,
            country: j.country || deriveCountry(undefined, j.region, String(j.location ?? "")),
            isNew: false, // carried forward, not newly found
          };
          kept.push(carried);
          if (identity) byIdentity.set(identity, carried);
        }
        carriedOver = kept.length;
        all = [...all, ...kept].sort(
          (a, b) => Number(b.isNew) - Number(a.isNew) || b.score - a.score,
        );
      } catch (e) {
        console.log(`[carry] previous payload unreadable, writing this run's results only: ${e}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Language requirements. Every job was tagged from its own text at ingest;
  // sources that return only a title (Arbeitsagentur, LinkedIn) now get their
  // advert read (cached 72h), so a "requires fluent German" line is not missed.
  // Carried-over jobs from payloads older than tagging are covered as well.
  // ---------------------------------------------------------------------------
  progress("Reading adverts for language requirements…", false);
  const langStats = await readDescriptions(all, cfg, true, (label) => progress(label, false));
  const langDrop = dropUnusableLanguages(all, cfg);
  all = langDrop.kept;
  rejectedLanguage += langDrop.dropped;

  const payload = {
    generatedAt: new Date().toISOString(),
    jobageDays: Number(jobage),
    profile: cfg.profile,
    // counts + byCountry. byCountry drives the dynamic tab bar; lastScope tells
    // the UI which tab to lead with and open after a run.
    ...payloadCounts(all),
    lastScope: SCOPE,
    cv: readCvMeta(),
    health,
    jobs: all,
  };

  if (DRY) {
    console.log(
      JSON.stringify(
        {
          ...payload.counts,
          rejectedOffDomain,
          rejectedNoEvidence,
          rejectedLanguage,
          carriedDropped,
          languages: langStats.byLang,
          adverts: { cached: langStats.cached, fetched: langStats.fetched, failed: langStats.failed, titleOnly: langStats.titleOnly },
        },
        null,
        2,
      ),
    );
    console.table(health);
    return;
  }

  writeFileSync(join(DATA, "jobs.json"), JSON.stringify(payload, null, 2));
  // file:// -safe variant — index.html loads this via <script>, not fetch().
  writeFileSync(join(DATA, "jobs.js"), `window.JOBS = ${JSON.stringify(payload)};\n`);

  const stamp = new Date().toISOString();
  for (const [key] of jobs) seen[key] = seen[key] ?? stamp;
  writeFileSync(seenPath, JSON.stringify(seen, null, 2));

  console.log(
    `[${stamp}] scope=${SCOPE} ${payload.counts.total} jobs (${payload.counts.new} new, ` +
      `${payload.counts.high} high fit` +
      (carriedOver ? `, ${carriedOver} carried over from other scopes` : "") +
      (carriedDropped ? `, ${carriedDropped} carried jobs failed today's rules` : "") +
      (rejectedOffDomain ? `, ${rejectedOffDomain} rejected off-domain` : "") +
      (rejectedNoEvidence ? `, ${rejectedNoEvidence} rejected without domain evidence` : "") +
      (rejectedLanguage ? `, ${rejectedLanguage} rejected on language` : "") +
      (Object.keys(langStats.byLang).length ? `, language tags: ${languageSummary(langStats.byLang)}` : "") +
      (langStats.fetched || langStats.failed
        ? `, ${langStats.fetched} adverts read${langStats.failed ? ` (${langStats.failed} failed)` : ""}`
        : "") +
      `) -> dashboard/data/jobs.json`,
  );

  progress(`Done — ${payload.counts.total} jobs`);
}

/**
 * --rescore: re-apply the current relevance rules to the existing jobs.json,
 * with no network calls. Use it after editing the title lists or thresholds in
 * config.json, instead of waiting for (or forcing) a full scrape. Jobs that now
 * fail the gate are dropped, two cards for one vacancy are merged, and the
 * neutral-title fit cap is applied; scores are otherwise left as scraped.
 * Language tags are filled in from cached adverts and titles; with
 * --fetch-details the adverts of title-only sources (Arbeitsagentur, LinkedIn)
 * are read over the network as well (cached 72h).
 */
async function rescore() {
  const cfg = loadConfig();
  const cvAlign = await loadCvAlignment(cfg);
  const path = join(DATA, "jobs.json");
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const before: Job[] = payload.jobs ?? [];

  const kept: Job[] = [];
  const byIdentity = new Map<string, Job>();
  const dropped: Record<string, string[]> = {};
  let merged = 0;
  for (const j of before) {
    const verdict = assessStoredJob(j, cfg, cvAlign);
    if (!verdict.keep) {
      (dropped[verdict.reject!] ??= []).push(`${j.title} (${j.portal})`);
      continue;
    }
    const identity = j.identity || jobIdentity(j.company, j.title);
    const twin = identity ? byIdentity.get(identity) : undefined;
    if (twin) {
      mergeSources(twin, j);
      merged++;
      continue;
    }
    const job: Job = { ...j, identity: identity || undefined, fit: verdict.fit };
    kept.push(job);
    if (identity) byIdentity.set(identity, job);
  }

  let progressed = 0;
  const langStats = await readDescriptions(kept, cfg, args.includes("--fetch-details"), (label) => {
    if (++progressed % 25 === 0) console.log(`  ${label}`);
  });
  const { kept: final, dropped: langDropped } = dropUnusableLanguages(kept, cfg);

  Object.assign(payload, payloadCounts(final), { jobs: final });
  if (!DRY) {
    writeFileSync(path, JSON.stringify(payload, null, 2));
    writeFileSync(join(DATA, "jobs.js"), `window.JOBS = ${JSON.stringify(payload)};\n`);
  }

  console.log(
    `rescore: ${before.length} -> ${final.length} jobs (${merged} duplicate cards merged` +
      (langDropped ? `, ${langDropped} dropped on language` : "") +
      `)` +
      (DRY ? " [dry run, nothing written]" : " -> dashboard/data/jobs.json"),
  );
  console.log(
    `  language tags: ${languageSummary(langStats.byLang) || "none"} ` +
      `(adverts: ${langStats.cached} cached, ${langStats.fetched} fetched, ${langStats.failed} failed; ` +
      `${langStats.titleOnly} judged on the title only)`,
  );
  for (const [reason, titles] of Object.entries(dropped)) {
    console.log(`  dropped ${titles.length} ${reason}:`);
    for (const t of titles) console.log(`    - ${t}`);
  }
}

// Guarded so the relevance helpers below can be imported by tests without
// kicking off a live scrape. Running the file directly is unchanged.
if (import.meta.main) {
  (args.includes("--rescore") ? rescore() : main()).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export {
  termMatches,
  titleGate,
  offDomain,
  scoreJob,
  assessJob,
  assessStoredJob,
  applyQueryOverrides,
  loadConfig,
  buildCvAlignment,
};
