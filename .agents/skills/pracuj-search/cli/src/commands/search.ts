import {
  buildSearchUrl,
  extractNextData,
  filterByAge,
  filterByRemote,
  findOfferContainer,
  htmlFetch,
  parseOffers,
  writeError,
  type JobCard,
} from "../helpers.js"

export interface SearchOpts {
  query?: string
  location?: string
  jobage: number
  remote?: string // "remote" | "hybrid" | "onsite"
  page: number
  limit?: number
  format: "json" | "table" | "plain"
}

function renderTable(cards: JobCard[]): string {
  if (cards.length === 0) return "No results."
  const rows = cards.map((c) => {
    const title = (c.title || "").slice(0, 40).padEnd(40)
    const company = (c.company || "—").slice(0, 24).padEnd(24)
    const loc = (c.location || "—").slice(0, 22).padEnd(22)
    const salary = (c.salary || "—").slice(0, 22).padEnd(22)
    const date = (c.date || "—").slice(0, 10)
    return `${c.id.padEnd(11)} ${title} ${company} ${loc} ${salary} ${date}`
  })
  const header =
    "ID".padEnd(11) +
    " " +
    "TITLE".padEnd(40) +
    " " +
    "COMPANY".padEnd(24) +
    " " +
    "LOCATION".padEnd(22) +
    " " +
    "SALARY".padEnd(22) +
    " DATE"
  return [header, "-".repeat(header.length), ...rows].join("\n")
}

export async function runSearch(opts: SearchOpts): Promise<number> {
  try {
    const url = buildSearchUrl(opts.query, opts.location, opts.page)
    const html = await htmlFetch(url)

    const data = extractNextData(html)
    if (data === null) {
      // No payload: an interstitial or a changed page shape. Report an empty
      // result set explicitly rather than pretending the portal had no jobs.
      writeError(
        `no __NEXT_DATA__ payload at ${url} - pracuj.pl may have changed its page shape`,
        "NO_PAYLOAD",
      )
      return 1
    }

    const container = findOfferContainer(data)
    if (container === null) {
      writeError(
        `no offer container in payload at ${url} - pracuj.pl may have changed its data shape`,
        "NO_OFFERS_FIELD",
      )
      return 1
    }

    let cards = parseOffers(container)
    const totalBeforeFilters = cards.length
    cards = filterByRemote(cards, opts.remote)
    cards = filterByAge(cards, opts.jobage)
    if (opts.limit !== undefined && opts.limit >= 0) cards = cards.slice(0, opts.limit)

    if (opts.format === "table") {
      process.stdout.write(renderTable(cards) + "\n")
    } else if (opts.format === "plain") {
      process.stdout.write(
        cards
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
              count: cards.length,
              page: opts.page,
              totalOnPage: totalBeforeFilters,
              totalMatches: container.offersTotalCount ?? null,
            },
            results: cards,
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
