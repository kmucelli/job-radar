import { htmlFetch, normalizeDetailInput, parseOfferPage, writeError } from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  try {
    const url = normalizeDetailInput(opts.id)
    const html = await htmlFetch(url)
    if (!html) {
      writeError(`offer not found: ${opts.id}`, "NOT_FOUND")
      return 1
    }

    const detail = parseOfferPage(url, html)
    if (!detail) {
      writeError(
        `could not parse offer at ${url} - nofluffjobs.com may have changed its page shape`,
        "PARSE_FAILED",
      )
      return 1
    }

    if (opts.format === "plain") {
      process.stdout.write(
        [
          detail.title,
          `${detail.company || "—"} · ${detail.location || "—"}`,
          `salary: ${detail.salary || "—"}`,
          `modes: ${detail.workModes.join(", ") || "—"}`,
          `technologies: ${detail.technologies.join(", ") || "—"}`,
          detail.url,
          "",
          detail.description || "(no description)",
        ].join("\n") + "\n",
      )
    } else {
      process.stdout.write(JSON.stringify(detail, null, 2) + "\n")
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
