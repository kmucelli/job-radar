// Data source: nofluffjobs.com public listing and offer pages.
//
// robots.txt disallows /api/, so this skill never calls nofluffjobs.com/api/*.
// We read only:
// - /pl/praca-it/<city> listing pages to collect job links
// - /pl/job/<slug> offer pages for full posting data
//
// Listing pages do not include schema JobPosting cards, but the offer pages
// embed rich posting objects in a large application/json state blob.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const SITE_BASE = "https://nofluffjobs.com"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; nofluffjobs-search-cli/1.0)"

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

export function buildListingUrl(query: string | undefined, city: string, page: number): string {
  const params = new URLSearchParams()
  if (page > 1) params.set("page", String(page))
  // No Fluff Jobs takes its keyword through the `criteria` parameter as
  // "keyword=<term>", NOT through a bare ?q=. A ?q= is accepted and silently
  // ignored, so the listing comes back unfiltered - which meant the CLI pulled
  // the first 20 jobs of the entire city, filtered them client-side, and then
  // reported "No results." for a term that plainly has matches on the site.
  // URLSearchParams percent-encodes the inner "=" to %3D, which is the form
  // the site expects.
  if (query && query.trim()) params.set("criteria", `keyword=${query.trim()}`)
  const qs = params.toString()
  return `${SITE_BASE}/pl/praca-it/${encodeURIComponent(city.trim().toLowerCase())}${qs ? `?${qs}` : ""}`
}

/** Extract /pl/job/<slug> links from a listing page and absolutize them. */
export function extractListingUrls(html: string): string[] {
  const links = [...html.matchAll(/"(\/pl\/job\/[^"\s?#]+(?:-[^"\s?#]+)*)"/g)].map((m) => m[1])
  const abs = links.map((p) => `${SITE_BASE}${p}`)
  return [...new Set(abs)]
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

interface PostingPayload {
  id?: string
  title?: string
  company?: { name?: string; url?: string }
  details?: { description?: string }
  requirements?: {
    musts?: Array<{ value?: string }>
    nices?: Array<{ value?: string }>
  }
  location?: {
    remote?: boolean
    remoteFlexible?: boolean
    places?: Array<{ city?: string }>
  }
  essentials?: {
    originalSalary?: {
      currency?: string
      types?: Record<string, { period?: string; range?: number[] }>
    }
  }
  posted?: number
  postingUrl?: string
}

/**
 * Pull NoFluffJobs posting payload from the application/json state script.
 *
 * The script is a key-value map where the posting lives under a key that starts
 * with /posting/. We detect by key shape (stable across pages) rather than
 * relying on unrelated cache keys.
 */
function parsePostingPayload(html: string): PostingPayload | null {
  const m = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return null
  try {
    const root = JSON.parse(m[1]) as Record<string, unknown>
    const postingKey = Object.keys(root).find((k) => k.startsWith("/posting/"))
    if (!postingKey) return null
    const payload = root[postingKey]
    if (!payload || typeof payload !== "object") return null
    return payload as PostingPayload
  } catch {
    return null
  }
}

function parseSalary(payload: PostingPayload): string | null {
  const src = payload.essentials?.originalSalary
  if (!src?.types) return null
  const currency = src.currency ?? ""
  const parts: string[] = []
  for (const [type, entry] of Object.entries(src.types)) {
    const range = entry.range ?? []
    if (range.length === 0) continue
    const from = range[0]
    const to = range.length > 1 ? range[1] : range[0]
    const salaryRange = from !== to ? `${from.toLocaleString("pl-PL")}–${to.toLocaleString("pl-PL")}` : from.toLocaleString("pl-PL")
    const period = entry.period ?? "month"
    parts.push(`${salaryRange} ${currency} / ${period} (${type.toUpperCase()})`)
  }
  return parts.length > 0 ? parts.join(" | ") : null
}

function parseTechnologies(payload: PostingPayload): string[] {
  const musts = (payload.requirements?.musts ?? []).map((x) => x.value).filter((v): v is string => Boolean(v))
  const nices = (payload.requirements?.nices ?? []).map((x) => x.value).filter((v): v is string => Boolean(v))
  return [...new Set([...musts, ...nices])]
}

function parseWorkModes(payload: PostingPayload): string[] {
  const modes: string[] = []
  if (payload.location?.remote === true || payload.location?.remoteFlexible === true) {
    modes.push("remote")
  }
  const cities = (payload.location?.places ?? []).map((p) => p.city).filter((v): v is string => Boolean(v))
  if (cities.some((c) => c.toLowerCase() === "remote")) {
    modes.push("remote")
  }
  if (cities.some((c) => c.toLowerCase() !== "remote")) {
    modes.push("onsite")
  }
  return [...new Set(modes)]
}

function parseLocation(payload: PostingPayload): string | null {
  const cities = (payload.location?.places ?? []).map((p) => p.city?.trim()).filter((v): v is string => Boolean(v))
  const unique = [...new Set(cities)]
  return unique.length > 0 ? unique.join("; ") : null
}

export function parseOfferPage(url: string, html: string): JobDetail | null {
  const payload = parsePostingPayload(html)
  if (!payload || !payload.title) return null
  const id = payload.id ?? url.split("/pl/job/")[1]?.split("?")[0] ?? url
  const posted = typeof payload.posted === "number" ? new Date(payload.posted).toISOString() : null
  const description = payload.details?.description ? stripHtml(payload.details.description) : null
  const workModes = parseWorkModes(payload)

  return {
    id,
    title: payload.title,
    company: payload.company?.name ?? null,
    companyUrl: payload.company?.url ? `https://${payload.company.url}` : null,
    location: parseLocation(payload),
    date: posted,
    url: payload.postingUrl ? `${SITE_BASE}/pl/job/${payload.postingUrl}` : url,
    salary: parseSalary(payload),
    technologies: parseTechnologies(payload),
    workModes,
    remote: workModes.includes("remote"),
    description,
  }
}

/**
 * Client-side recency filter.
 *
 * NoFluffJobs listing route does not expose a stable, explicit public recency
 * parameter for this robots-compliant flow, so --jobage uses parsed posted time.
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
  const slug = idOrUrl.replace(/^.*\/pl\/job\//, "").replace(/^\/+/, "")
  return `${SITE_BASE}/pl/job/${slug}`
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
 * run while it stays listed, and that repeat volume is what drew the HTTP 429s
 * this board answers with. A cached offer also carries its posting date, so
 * one too old for --jobage is dropped without a request.
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
