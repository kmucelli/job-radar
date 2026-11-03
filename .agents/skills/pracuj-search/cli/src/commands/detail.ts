import {
  extractNextData,
  htmlFetch,
  offerUrlFromId,
  stripHtml,
  writeError,
  type JobDetail,
} from "../helpers.js"

export interface DetailOpts {
  id: string
  format: "json" | "plain"
}

/**
 * An offer page uses a DIFFERENT payload shape from the search page: there is
 * no groupedOffers array, but a single `attributes` object holding the full
 * posting. We locate it by shape (jobTitle + employment) rather than by the
 * queries[N] index, which shifts between page variants.
 */
interface OfferAttributes {
  jobTitle?: string
  displayEmployerName?: string
  offerAbsoluteUrl?: string
  description?: string
  isArchive?: boolean
  isWithdrawn?: boolean
  workplaces?: unknown[]
  employment?: {
    positionLevels?: NamedItem[]
    workModes?: NamedItem[]
    typesOfContracts?: ContractType[]
    workSchedules?: NamedItem[]
    entirelyRemoteWork?: boolean
  }
}

interface NamedItem {
  name?: string
  pracujPlName?: string
}

interface ContractType extends NamedItem {
  salary?: {
    from?: number
    to?: number
    currency?: { code?: string; symbol?: string }
    timeUnit?: { shortForm?: NamedItem }
    salaryKind?: { name?: string }
  }
}

function findAttributes(root: unknown): OfferAttributes | null {
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
    if (typeof obj.jobTitle === "string" && "employment" in obj) {
      return obj as OfferAttributes
    }
    for (const v of Object.values(obj)) stack.push(v)
  }
  return null
}

function label(item: NamedItem | undefined): string | null {
  if (!item) return null
  return item.name ?? item.pracujPlName ?? null
}

function names(items: NamedItem[] | undefined): string[] {
  return (items ?? []).map(label).filter((s): s is string => Boolean(s))
}

/**
 * Render every advertised contract's salary band.
 *
 * A posting often lists a different band per contract type (B2B vs employment
 * contract), so collapsing them to one number would misreport the offer.
 */
function formatSalary(contracts: ContractType[] | undefined): string | null {
  const parts: string[] = []
  for (const c of contracts ?? []) {
    const s = c.salary
    if (!s || (s.from === undefined && s.to === undefined)) continue
    const symbol = s.currency?.symbol ?? s.currency?.code ?? ""
    const unit = label(s.timeUnit?.shortForm)
    const kind = s.salaryKind?.name
    const range =
      s.from !== undefined && s.to !== undefined && s.from !== s.to
        ? `${s.from.toLocaleString("pl-PL")}–${s.to.toLocaleString("pl-PL")}`
        : String((s.from ?? s.to ?? 0).toLocaleString("pl-PL"))
    const ctx = [label(c), kind].filter(Boolean).join(", ")
    parts.push(
      `${range} ${symbol}${unit ? ` / ${unit}` : ""}${ctx ? ` (${ctx})` : ""}`.trim(),
    )
  }
  return parts.length > 0 ? parts.join(" | ") : null
}

/** Pull city names out of the nested workplaces structure. */
function formatWorkplaces(workplaces: unknown[] | undefined): string | null {
  const out: string[] = []
  for (const w of workplaces ?? []) {
    if (!w || typeof w !== "object") continue
    const obj = w as Record<string, unknown>
    const inland = obj.inlandLocation as Record<string, unknown> | undefined
    const loc = inland?.location as Record<string, unknown> | undefined
    const name = loc?.name
    if (typeof name === "string" && name.trim()) {
      out.push(name.trim())
      continue
    }
    const abroad = obj.abroadAddress
    if (typeof abroad === "string" && abroad.trim()) out.push(abroad.trim())
  }
  const unique = [...new Set(out)]
  return unique.length > 0 ? unique.join("; ") : null
}

export async function runDetail(opts: DetailOpts): Promise<number> {
  try {
    const url = offerUrlFromId(opts.id)
    const html = await htmlFetch(url)
    if (!html) {
      writeError(`offer not found: ${opts.id}`, "NOT_FOUND")
      return 1
    }

    const data = extractNextData(html)
    if (data === null) {
      writeError(`no __NEXT_DATA__ payload at ${url}`, "NO_PAYLOAD")
      return 1
    }

    const attr = findAttributes(data)
    if (attr === null) {
      writeError(
        `could not locate offer attributes for ${opts.id} at ${url} - the offer may have expired, or pracuj.pl changed its data shape`,
        "PARSE_FAILED",
      )
      return 1
    }

    const employment = attr.employment ?? {}
    const detail: JobDetail = {
      id: String(opts.id).replace(/^.*,oferta,/, ""),
      title: attr.jobTitle ?? "(untitled)",
      company: attr.displayEmployerName ?? null,
      companyUrl: null,
      location: formatWorkplaces(attr.workplaces),
      date: null,
      url: attr.offerAbsoluteUrl ?? url,
      salary: formatSalary(employment.typesOfContracts),
      workModes: names(employment.workModes),
      positionLevels: names(employment.positionLevels),
      contractTypes: names(employment.typesOfContracts),
      technologies: [],
      remote: employment.entirelyRemoteWork === true,
      description: attr.description ? stripHtml(attr.description) : null,
      expirationDate: null,
    }

    // An expired posting still renders, so surface it rather than letting a
    // dead job look live in a shortlist.
    const archived = attr.isArchive === true || attr.isWithdrawn === true

    if (opts.format === "plain") {
      process.stdout.write(
        [
          detail.title + (archived ? "  [EXPIRED/WITHDRAWN]" : ""),
          `${detail.company || "—"} · ${detail.location || "—"}`,
          `salary: ${detail.salary || "—"}`,
          `modes: ${detail.workModes.join(", ") || "—"}`,
          `levels: ${detail.positionLevels.join(", ") || "—"}`,
          `contracts: ${detail.contractTypes.join(", ") || "—"}`,
          detail.url,
          "",
          detail.description || "(no description)",
        ].join("\n") + "\n",
      )
    } else {
      process.stdout.write(
        JSON.stringify({ ...detail, archived }, null, 2) + "\n",
      )
    }
    return 0
  } catch (e) {
    writeError(e instanceof Error ? e.message : String(e), "DETAIL_FAILED")
    return 1
  }
}
