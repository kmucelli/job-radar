import {
  buildListingUrl,
  extractListingUrls,
  filterByAge,
  filterUrlsByCity,
  htmlFetch,
  openDetailCache,
  parseOfferPage,
  sleep,
  writeError,
  type JobCard,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location: string
  jobage: number
  page: number
  limit?: number
  format: "json" | "table" | "plain"
  /** Detail pages fetched in parallel. Default 1 = original serial behaviour. */
  detailConcurrency?: number
  /** Directory of the on-disk offer cache (see openDetailCache). Unset = no cache. */
  cacheDir?: string
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "No results."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 38).padEnd(38)
    const company = (c.company || "—").slice(0, 24).padEnd(24)
    const loc = (c.location || "—").slice(0, 20).padEnd(20)
    const salary = (c.salary || "—").slice(0, 26).padEnd(26)
    const date = (c.date || "—").slice(0, 10)
    return `${c.id.slice(0, 10).padEnd(10)} ${title} ${company} ${loc} ${salary} ${date}`
  })
  const header =
    "ID".padEnd(10) +
    " " +
    "TITLE".padEnd(38) +
    " " +
    "COMPANY".padEnd(24) +
    " " +
    "LOCATION".padEnd(20) +
    " " +
    "SALARY".padEnd(26) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const limit = opts.limit !== undefined && opts.limit >= 0 ? opts.limit : 20
    const listingUrl = buildListingUrl(opts.query, opts.location, opts.page)
    const html = await htmlFetch(listingUrl)
    if (!html) {
      writeError(`listing not found: ${listingUrl}`, "NOT_FOUND")
      return 1
    }

    // null = no CollectionPage list on the page (shape change, a real error);
    // [] = the search matched nothing, which is a valid empty result.
    const allUrls = extractListingUrls(html)
    if (allUrls === null) {
      writeError(
        `no CollectionPage listing found at ${listingUrl} - justjoin.it may have changed its page shape`,
        "NO_LISTING_URLS",
      )
      return 1
    }

    // The listing payload is keyword-filtered but not city-filtered, so drop
    // out-of-city offers before spending a request on each one.
    const urls = filterUrlsByCity(allUrls, opts.location)

    // We cannot fetch all offers on a large page by default: this flow is
    // listing -> N detail pages (robots-compliant alternative to /api/), so we
    // cap detail fetches and add a tiny pause per request to keep traffic low.
    const maxDetailFetches = Math.min(urls.length, Math.max(limit * 2, limit, 20))
    const cards: JobCard[] = []
    let fetched = 0

    // Detail pages are the entire cost of this flow (listing -> N detail
    // pages), and fetching them strictly one-at-a-time made a single query take
    // ~35s. They are independent GETs, so fetch a few at a time. Default stays 1
    // (original behaviour) — callers opt in via --detail-concurrency, and the
    // per-request pause is kept inside each worker so raising it to N only
    // multiplies the request rate by N rather than removing throttling.
    const detailConcurrency = Math.max(1, opts.detailConcurrency ?? 1)
    const targets = urls.slice(0, maxDetailFetches)
    // Preallocate so results keep listing order regardless of completion order,
    // which keeps output stable between runs.
    const slots: (JobCard | null)[] = new Array(targets.length).fill(null)
    const cache = openDetailCache(opts.cacheDir)
    let cursor = 0
    let cacheHits = 0
    let cacheWriteErrors = 0
    let failed = 0
    let lastError: unknown = null

    await Promise.all(
      Array.from({ length: Math.min(detailConcurrency, targets.length) }, async () => {
        while (true) {
          const i = cursor++
          if (i >= targets.length) return
          const hit = cache?.get(targets[i])
          if (hit) {
            // No request was made, so no politeness pause either.
            slots[i] = hit
            cacheHits++
            continue
          }
          // One offer that keeps failing (429 after every retry, a timeout)
          // must not throw away the offers already fetched for this query.
          let detailHtml = ""
          try {
            detailHtml = await htmlFetch(targets[i])
          } catch (e) {
            failed++
            lastError = e
          }
          if (detailHtml) {
            fetched++
            const card = parseOfferPage(targets[i], detailHtml)
            slots[i] = card
            if (card && cache && !cache.set(targets[i], card)) cacheWriteErrors++
          }
          await sleep(120)
        }
      }),
    )

    // Every offer failed and nothing came from the cache: that is a block, not
    // an empty result, so surface it as an error.
    if (failed > 0 && fetched === 0 && cacheHits === 0) throw lastError

    for (const card of slots) if (card) cards.push(card)

    let filtered = filterByAge(cards, opts.jobage)
    if (limit >= 0) filtered = filtered.slice(0, limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(filtered) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        filtered
          .map(
            (c) =>
              `${c.title}\n  ${c.company || "—"} · ${c.location || "—"} · ${c.date || "—"}\n` +
              `  salary: ${c.salary || "—"}\n` +
              `  modes: ${c.workModes.join(", ") || "—"}\n` +
              `  id: ${c.id}\n  ${c.url}`,
          )
          .join("\n\n") + "\n",
      )
    } else {
      process.stdout.write(
        JSON.stringify(
          {
            meta: {
              count: filtered.length,
              page: opts.page,
              totalOnPage: urls.length,
              fetchedDetails: fetched,
              cacheHits,
              failedDetails: failed,
              cacheWriteErrors,
            },
            results: filtered,
          },
          null,
          2,
        ) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "SEARCH_FAILED")
    return 1
  }
}
