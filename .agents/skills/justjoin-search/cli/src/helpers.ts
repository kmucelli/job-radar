// Data source: justjoin.it public listing and offer pages.
//
// robots.txt disallows /api/, so this skill never calls api.justjoin.it nor
// justjoin.it/api/*. We read only:
// - /job-offers/<city>?keyword=<kw> for listing URLs
// - /job-offer/<slug> for per-offer data
//
// Listing pages expose a CollectionPage ld+json listing the offer URLs but not
// full card fields. We enrich by fetching offer pages, where the relevant
// metadata is embedded in page state/markup.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const SITE_BASE = "https://justjoin.it"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; justjoin-search-cli/1.0)"

/** Fetch HTML with exponential backoff on 429/5xx. Returns "" on a 404. */
export async function htmlFetch(url: string): Promise<string> {
  const maxRetries = 6
  let delay = 500
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    })
    if (response.status === 429 || response.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`)
      }
      const jitter = Math.floor(Math.random() * 500)
      await new Promise((r) => setTimeout(r, delay + jitter))
      delay = Math.min(delay * 2, 8000)
      continue
    }
    if (response.status === 404) return ""
    if (!response.ok) {
      throw new Error(`Request failed: ${response.status} ${response.statusText}`)
    }
    return response.text()
  }
  throw new Error("Request failed after max retries")
}

export interface JobCard {
  id: string
  title: string
  company: string | null
  companyUrl: string | null
  location: string | null
  date: string | null
  url: string
  salary: string | null
  technologies: string[]
  workModes: string[]
  remote: boolean
}

export interface JobDetail extends JobCard {
  description: string | null
}

/**
 * Pull offer URLs from the listing page's CollectionPage ld+json.
 *
 * The list moved from `hasPart` to `mainEntity` (an ItemList of ListItems) in
 * October 2026. Reading only `hasPart` made every search fail with
 * NO_LISTING_URLS, so both shapes are accepted.
 *
 * Returns [] when the list is present but empty - a search with no matches,
 * which justjoin renders as `numberOfItems: 0` - and null when the page carries
 * no CollectionPage list at all, which means the page shape changed.
 */
export function extractListingUrls(html: string): string[] | null {
  const scripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? []
  for (const scriptTag of scripts) {
    const body = scriptTag
      .replace(/^<script type="application\/ld\+json">/, "")
      .replace(/<\/script>$/, "")
    try {
      const obj = JSON.parse(body) as {
        "@type"?: string
        hasPart?: Array<{ url?: string }>
        mainEntity?: { itemListElement?: Array<{ url?: string }> }
      }
      if (obj?.["@type"] !== "CollectionPage") continue
      const parts = obj.hasPart ?? obj.mainEntity?.itemListElement
      if (!Array.isArray(parts)) continue
      const urls = parts
        .map((p) => p?.url)
        .filter((u): u is string => typeof u === "string" && u.includes("/job-offer/"))
      return [...new Set(urls)]
    } catch {
      continue
    }
  }
  return null
}

export function buildListingUrl(query: string | undefined, city: string, page: number): string {
  const params = new URLSearchParams()
  if (query && query.trim()) params.set("keyword", query.trim())
  if (page > 1) params.set("page", String(page))
  const qs = params.toString()
  return `${SITE_BASE}/job-offers/${encodeURIComponent(city.trim().toLowerCase())}${qs ? `?${qs}` : ""}`
}

/** Fold Polish diacritics so "Kraków", "krakow" and "KRAKOW" all compare equal. */
export function foldCity(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0142/g, "l") // ł has no combining form, so NFD leaves it intact
    .toLowerCase()
    .trim()
}

/**
 * Keep only the offer URLs whose slug names the requested city.
 *
 * The CollectionPage ld+json on /job-offers/<city> is filtered by KEYWORD but
 * NOT by city: a search for "network" in Krakow returns Poznan, Rzeszow and
 * Warszawa offers in its hasPart array too. Filtering here rather than after
 * the detail fetches matters twice over - it makes --location mean something,
 * and it avoids fetching detail pages for offers we are about to discard,
 * which keeps request volume down on a listing->N-detail-pages flow.
 *
 * JustJoin slugs end with "<company>-<title>-<city>-<category>-<hash>", so the
 * city appears as a hyphen-delimited token. If no slug matches we return the
 * input untouched rather than an empty list: the slug convention is a
 * heuristic, and silently returning nothing would be worse than returning
 * unfiltered results the caller can still read.
 */
export function filterUrlsByCity(urls: string[], city: string | undefined): string[] {
  const target = foldCity(city ?? "")
  if (!target) return urls
  const matches = urls.filter((u) => {
    const slug = foldCity(u.split("/job-offer/")[1] ?? "")
    return slug.split("-").includes(target)
  })
  return matches.length > 0 ? matches : urls
}

function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * Decode HTML entities in short plain-text fields.
 *
 * JustJoin double-encodes titles inside its ld+json, so a role advertised as
 * "CDN & Cloud Network Engineer" arrives as "CDN&amp;Cloud Network Engineer".
 * stripHtml() handles this for the description, but titles and company names
 * never passed through it and were being emitted raw into results - which then
 * end up verbatim in a shortlist or a cover letter.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const cp = parseInt(d, 10)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ""
    })
    // &amp; last, so "&amp;lt;" does not collapse into a real "<".
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeMode(raw: string): string {
  const v = raw.trim().toLowerCase()
  if (!v) return "unknown"
  if (v.includes("remote") || v.includes("zdal")) return "remote"
  if (v.includes("hybrid") || v.includes("hybryd")) return "hybrid"
  if (v.includes("office") || v.includes("onsite") || v.includes("stacjon")) return "onsite"
  return v
}

/**
 * Format schema.org baseSalary into a display string.
 *
 * This is the authoritative source for pay on a JustJoin offer page and it is
 * plain JSON, unlike the hydrated RSC snippets the regex below scrapes. Those
 * snippets change shape whenever the front end is rebuilt, which is exactly
 * how salary silently became null on every result; ld+json is stable, so we
 * read it first and keep the regex only as a fallback.
 */
function formatLdSalary(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null
  const amount = raw as Record<string, unknown>
  const currency = typeof amount.currency === "string" ? amount.currency : ""
  const value = amount.value as Record<string, unknown> | undefined
  if (!value || typeof value !== "object") return null

  const min = typeof value.minValue === "number" ? value.minValue : null
  const max = typeof value.maxValue === "number" ? value.maxValue : null
  const single = typeof value.value === "number" ? value.value : null
  const unitRaw = typeof value.unitText === "string" ? value.unitText : ""
  // schema.org uses HOUR/DAY/WEEK/MONTH/YEAR; render them the way the site does.
  const unit =
    { HOUR: "Hour", DAY: "Day", WEEK: "Week", MONTH: "Month", YEAR: "Year" }[unitRaw] ??
    (unitRaw ? unitRaw.toLowerCase() : "")

  if (min === null && max === null && single === null) return null
  const range =
    min !== null && max !== null && min !== max
      ? `${min.toLocaleString("pl-PL")}–${max.toLocaleString("pl-PL")}`
      : String(((min ?? max ?? single) as number).toLocaleString("pl-PL"))

  return `${range} ${currency}${unit ? ` / ${unit}` : ""}`.trim()
}

/**
 * Parse one JustJoin offer page.
 *
 * The page carries a JobPosting ld+json block (title/company/location/date/
 * description/baseSalary) plus additional fields (skills/work mode) in hydrated
 * state snippets. We combine both, preferring the ld+json values when found.
 */
export function parseOfferPage(url: string, html: string): JobDetail | null {
  const id = url.includes("/job-offer/") ? url.split("/job-offer/")[1].split("?")[0] : url

  let title: string | null = null
  let company: string | null = null
  let location: string | null = null
  let date: string | null = null
  let description: string | null = null
  let ldSalary: string | null = null

  const ldScripts = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? []
  for (const scriptTag of ldScripts) {
    const body = scriptTag
      .replace(/^<script type="application\/ld\+json">/, "")
      .replace(/<\/script>$/, "")
    try {
      const obj = JSON.parse(body) as Record<string, unknown>
      if (obj["@type"] !== "JobPosting") continue
      title = typeof obj.title === "string" ? decodeEntities(obj.title) : null
      const org = obj.hiringOrganization as Record<string, unknown> | undefined
      company = org && typeof org.name === "string" ? decodeEntities(org.name) : null
      const jl = obj.jobLocation as Record<string, unknown> | undefined
      const addr = jl?.address as Record<string, unknown> | undefined
      location =
        (addr && typeof addr.addressLocality === "string" && decodeEntities(addr.addressLocality)) ||
        (addr && typeof addr.addressRegion === "string" && decodeEntities(addr.addressRegion)) ||
        null
      date = typeof obj.datePosted === "string" ? obj.datePosted : null
      description = typeof obj.description === "string" ? stripHtml(obj.description) : null
      ldSalary = formatLdSalary(obj.baseSalary)
      break
    } catch {
      continue
    }
  }

  // Salary appears in hydrated JSON-like snippets as from/to + currency + type.
  // We match those non-greedily so one malformed section does not consume the
  // whole page and hide subsequent fields.
  const salaryEntries: string[] = []
  const salRe = /\"currency\":\"([A-Z]{3})\"[^{}]{0,220}?\"from\":(null|\d+)[^{}]{0,220}?\"to\":(null|\d+)[^{}]{0,260}?\"type\":\"([^\"]+)\"[^{}]{0,120}?\"unit\":\"([^\"]+)\"/g
  let sm: RegExpExecArray | null
  while ((sm = salRe.exec(html)) !== null) {
    const currency = sm[1]
    const from = sm[2] === "null" ? null : Number(sm[2])
    const to = sm[3] === "null" ? null : Number(sm[3])
    const type = sm[4].toUpperCase()
    const unit = sm[5]
    if (from === null && to === null) continue
    const range = from !== null && to !== null ? `${from.toLocaleString("pl-PL")}–${to.toLocaleString("pl-PL")}` : String((from ?? to)?.toLocaleString("pl-PL"))
    salaryEntries.push(`${range} ${currency} / ${unit} (${type})`)
  }
  // ld+json is authoritative; fall back to the hydrated snippets only when the
  // structured block omitted pay (some offers publish no baseSalary at all).
  const salary = ldSalary ?? (salaryEntries.length > 0 ? [...new Set(salaryEntries)].join(" | ") : null)

  const techMatches = [...html.matchAll(/\"requiredSkills\":\[(.*?)\]/g)]
  const technologies: string[] = []
  for (const m of techMatches) {
    const names = [...(m[1] || "").matchAll(/\"name\":\"([^\"]+)\"/g)].map((x) => x[1].trim())
    technologies.push(...names)
  }
  const uniqueTech = [...new Set(technologies.filter(Boolean))]

  const modeMatches = [...html.matchAll(/\"workplaceType\":\{[^{}]*\"(label|value)\":\"([^\"]+)\"/g)]
  const modes = [...new Set(modeMatches.map((m) => normalizeMode(m[2])).filter(Boolean))]
  const remote = modes.includes("remote")

  if (!title) return null

  return {
    id,
    title,
    company,
    companyUrl: null,
    location,
    date,
    url,
    salary,
    technologies: uniqueTech,
    workModes: modes,
    remote,
    description,
  }
}

/**
 * Client-side recency filter.
 *
 * JustJoin listing pages do not expose a reliable public recency parameter for
 * this robots-compliant flow, so we apply --jobage on parsed publication dates.
 */
export function filterByAge(cards: JobCard[], days: number): JobCard[] {
  if (!days || days <= 0 || days >= 9999) return cards
  const cutoff = Date.now() - days * 86400_000
  return cards.filter((c) => {
    if (!c.date) return true
    const t = Date.parse(c.date)
    return isNaN(t) ? true : t >= cutoff
  })
}

export function normalizeDetailInput(idOrUrl: string): string {
  if (/^https?:\/\//i.test(idOrUrl)) return idOrUrl
  const slug = idOrUrl.replace(/^.*\/job-offer\//, "").replace(/^\/+/, "")
  return `${SITE_BASE}/job-offer/${slug}`
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** How long a cached offer page is trusted before it is fetched again. */
export const DETAIL_CACHE_TTL_MS = 72 * 3600_000

export interface DetailCache {
  /** The cached offer, or undefined when absent, unreadable or expired. */
  get(url: string): JobDetail | undefined
  /** Store an offer. Returns false when the write failed (best effort). */
  set(url: string, detail: JobDetail): boolean
}

/**
 * Parsed offer pages, cached on disk by URL (opt-in via --cache-dir).
 *
 * Offer pages are the whole cost of a search: one listing, then a GET per
 * offer. The same offer comes back for overlapping queries and on every daily
 * run while it stays listed, so without a cache it was refetched many times a
 * day. A cached offer also carries its posting date, so one too old for
 * --jobage is dropped without a request.
 *
 * One file per offer, written via rename, so CLI processes sharing the
 * directory never read a torn entry. Deleting old files is the caller's job.
 */
export function openDetailCache(dir: string | undefined): DetailCache | null {
  if (!dir) return null
  mkdirSync(dir, { recursive: true })
  const file = (url: string) => join(dir, `${createHash("sha1").update(url).digest("hex")}.json`)
  return {
    get(url) {
      try {
        const entry = JSON.parse(readFileSync(file(url), "utf8")) as { at: number; detail: JobDetail }
        return Date.now() - entry.at < DETAIL_CACHE_TTL_MS ? entry.detail : undefined
      } catch {
        return undefined // no entry yet, or a damaged one: treat as a miss
      }
    },
    set(url, detail) {
      const target = file(url)
      const tmp = `${target}.${process.pid}.tmp`
      try {
        writeFileSync(tmp, JSON.stringify({ at: Date.now(), url, detail }))
        renameSync(tmp, target)
        return true
      } catch {
        return false // a failed write only costs a refetch next time
      }
    },
  }
}
