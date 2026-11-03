// Data source: pracuj.pl public search pages (https://www.pracuj.pl/praca/...).
// Pracuj is a Next.js app that ships its search results as JSON inside the
// __NEXT_DATA__ script tag, so we fetch the public HTML page and read the
// embedded JSON rather than scraping the rendered DOM. That JSON is richer
// than the markup: it carries salary text, work modes, seniority levels and
// contract types that never appear as parseable elements on the page.
//
// robots.txt: /praca/ is not disallowed for any user-agent (only asset and
// account paths are). Verified with tools/robots_check.py.

export const SEARCH_BASE = "https://www.pracuj.pl/praca"

export function writeError(error: string, code: string): void {
  process.stderr.write(JSON.stringify({ error, code }) + "\n")
}

const UA = "Mozilla/5.0 (compatible; pracuj-search-cli/1.0)"

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
      signal: AbortSignal.timeout(15000),
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
  workModes: string[]
  positionLevels: string[]
  contractTypes: string[]
  technologies: string[]
  remote: boolean
}

export interface JobDetail extends JobCard {
  description: string | null
  expirationDate: string | null
}

/**
 * Pull the __NEXT_DATA__ payload out of a Pracuj page.
 *
 * Returns null rather than throwing when the tag is absent: a 301 to a
 * consent/interstitial page answers 200 with no payload, and the caller
 * reports that as an empty result set instead of a crash.
 */
export function extractNextData(html: string): unknown | null {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  )
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}

interface OfferContainer {
  groupedOffers: RawOffer[]
  offersTotalCount?: number
  groupedOffersTotalCount?: number
}

interface RawOffer {
  jobTitle?: string
  companyName?: string
  companyId?: number
  companyProfileAbsoluteUri?: string
  lastPublicated?: string
  expirationDate?: string
  salaryDisplayText?: string
  workModes?: string[]
  positionLevels?: string[]
  typesOfContract?: string[]
  technologies?: string[]
  isRemoteWorkAllowed?: boolean
  groupId?: string
  jobDescription?: string
  offers?: {
    partitionId?: number
    offerAbsoluteUri?: string
    displayWorkplace?: string
    isWholePoland?: boolean
  }[]
}

/**
 * Walk the Next.js dehydrated-state tree to find the offer container.
 *
 * The path (props.pageProps.dehydratedState.queries[N].state.data) carries a
 * query index that shifts as Pracuj adds prefetched queries, so we search for
 * the shape rather than hard-coding the index.
 *
 * A page carries MORE THAN ONE object with a groupedOffers array: an empty
 * initial-state container is prefetched alongside the real results. Returning
 * the first match found reports "No results." on a page that plainly has jobs,
 * so we collect every candidate and keep the fullest one.
 */
export function findOfferContainer(root: unknown): OfferContainer | null {
  const candidates: OfferContainer[] = []
  const stack: unknown[] = [root]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== "object") continue
    if (seen.has(node)) continue
    seen.add(node)

    if (Array.isArray(node)) {
      for (const v of node) stack.push(v)
      continue
    }
    const obj = node as Record<string, unknown>
    if (Array.isArray(obj.groupedOffers)) {
      candidates.push(obj as unknown as OfferContainer)
    }
    for (const v of Object.values(obj)) stack.push(v)
  }

  if (candidates.length === 0) return null
  return candidates.reduce((best, c) =>
    (c.groupedOffers?.length ?? 0) > (best.groupedOffers?.length ?? 0) ? c : best,
  )
}

/** Pracuj marks fully-remote roles in workModes as "Praca zdalna". */
function isRemote(offer: RawOffer): boolean {
  if (offer.isRemoteWorkAllowed === true) return true
  return (offer.workModes ?? []).some((m) => /zdaln/i.test(m))
}

function isHybrid(offer: RawOffer): boolean {
  return (offer.workModes ?? []).some((m) => /hybryd/i.test(m))
}

/** Normalise the non-breaking spaces Pracuj uses inside salary strings. */
function cleanSalary(text: string | undefined): string | null {
  if (!text) return null
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() || null
}

export function parseOffers(container: OfferContainer): JobCard[] {
  const results: JobCard[] = []

  for (const offer of container.groupedOffers ?? []) {
    const title = (offer.jobTitle ?? "").trim()
    if (!title) continue

    // A "grouped" offer can span several cities; the first sub-offer carries
    // the canonical URL and the numeric id we expose as the card id.
    const sub = (offer.offers ?? [])[0]
    const id = sub?.partitionId !== undefined ? String(sub.partitionId) : offer.groupId ?? ""
    if (!id) continue

    // Multi-city postings list every workplace; join them so the location
    // column reflects reality instead of silently dropping the others.
    const workplaces = (offer.offers ?? [])
      .map((o) => o.displayWorkplace)
      .filter((w): w is string => Boolean(w))
    const wholePoland = (offer.offers ?? []).some((o) => o.isWholePoland)
    const location = wholePoland
      ? "Cała Polska"
      : workplaces.length > 0
        ? [...new Set(workplaces)].join("; ")
        : null

    results.push({
      id,
      title,
      company: offer.companyName ?? null,
      companyUrl: offer.companyProfileAbsoluteUri ?? null,
      location,
      date: offer.lastPublicated ?? null,
      url: sub?.offerAbsoluteUri ?? `${SEARCH_BASE}/,oferta,${id}`,
      salary: cleanSalary(offer.salaryDisplayText),
      workModes: offer.workModes ?? [],
      positionLevels: offer.positionLevels ?? [],
      contractTypes: offer.typesOfContract ?? [],
      technologies: offer.technologies ?? [],
      remote: isRemote(offer),
    })
  }

  return results
}

/**
 * Client-side workplace filter.
 *
 * Pracuj has no query parameter for work mode that survives a redirect (the
 * ?wm= and /home-office;wm forms both 301 away), so we filter on the
 * workModes the payload already gives us rather than inventing a flag that
 * would silently return unfiltered results.
 */
export function filterByRemote(cards: JobCard[], mode: string | undefined): JobCard[] {
  const m = (mode || "").toLowerCase()
  if (!m) return cards
  if (m === "remote") return cards.filter((c) => c.remote)
  if (m === "hybrid") {
    return cards.filter((c) => c.workModes.some((w) => /hybryd/i.test(w)))
  }
  if (m === "onsite" || m === "on-site") {
    return cards.filter(
      (c) => !c.remote && c.workModes.some((w) => /stacjonarn/i.test(w)),
    )
  }
  return cards
}

/**
 * Client-side recency filter.
 *
 * Pracuj exposes no recency query parameter, but every offer carries
 * lastPublicated, so the job-scraper skill's "scope to the last N days"
 * requirement is honoured here instead of being quietly skipped.
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

/** Build a Pracuj search URL from keyword / city / page. */
export function buildSearchUrl(
  query: string | undefined,
  city: string | undefined,
  page: number,
): string {
  // Pracuj encodes filters as semicolon-suffixed path segments: <term>;kw for
  // the keyword and <city>;wp for the workplace.
  const segments: string[] = []
  if (query && query.trim()) segments.push(`${encodeURIComponent(query.trim())};kw`)
  if (city && city.trim()) {
    segments.push(`${encodeURIComponent(city.trim().toLowerCase())};wp`)
  }
  const path = segments.length > 0 ? `${SEARCH_BASE}/${segments.join("/")}` : `${SEARCH_BASE}/`
  return page > 1 ? `${path}?pn=${page}` : path
}

/**
 * Build the canonical offer URL for a bare numeric offer id.
 *
 * The id must sit in the ",oferta,<id>" suffix of a slugged path. Dropping the
 * leading comma (".../praca/oferta,<id>") still answers 200 — but it resolves
 * to an entirely DIFFERENT posting, so the omission is silent and produces a
 * detail record for the wrong job. The slug itself is ignored by Pracuj, so an
 * empty one is fine.
 */
export function offerUrlFromId(idOrUrl: string): string {
  if (/^https?:\/\//i.test(idOrUrl)) return idOrUrl
  return `${SEARCH_BASE}/,oferta,${idOrUrl}`
}

/** Strip HTML tags out of Pracuj's rich-text description blocks. */
export function stripHtml(html: string): string {
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
