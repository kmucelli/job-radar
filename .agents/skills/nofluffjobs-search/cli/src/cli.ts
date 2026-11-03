#!/usr/bin/env bun
// Self-contained CLI for searching jobs on nofluffjobs.com (Polish IT board)
// using ONLY public listing and offer pages. We intentionally never call
// /api/ endpoints because robots.txt disallows them.
//
// Personal use only. Keep volume low and do not use commercially.

import { runSearch, type SearchOpts } from "./commands/search.js"
import { runDetail, type DetailOpts } from "./commands/detail.js"

interface Flags {
  _: string[]
  [k: string]: string | boolean | string[]
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] }
  const alias: Record<string, string> = { q: "query", l: "location", n: "limit" }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--") || a.startsWith("-")) {
      const key = alias[a.replace(/^-+/, "")] ?? a.replace(/^-+/, "")
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true
      } else {
        flags[key] = next
        i++
      }
    } else {
      ;(flags._ as string[]).push(a)
    }
  }
  return flags
}

const HELP = `nofluffjobs-cli — search jobs on nofluffjobs.com (Poland)

USAGE
  bun run src/cli.ts search --location "<city>" [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --location, -l <city>   City slug. REQUIRED. e.g. "krakow", "warszawa".
  --query, -q <text>      Keywords filter (client-side). Default: empty.
  --jobage <days>         Posted within N days. Applied client-side.
  --page <n>              1-indexed page. Default 1.
  --limit, -n <n>         Cap results emitted. Default 20.
  --format <fmt>          json (default) | table | plain.
  --detail-concurrency <n>  Detail pages to fetch in parallel. Default 1
                          (strictly serial). Raise carefully: this flow is
                          listing -> N detail pages, so it is the main cost.
  --cache-dir <dir>       Reuse offer pages parsed in the last 72h from <dir>,
                          and store newly fetched ones there. Default: off.

NOTES
  This CLI is robots-compliant: it only fetches
  https://nofluffjobs.com/pl/praca-it/<city>
  and https://nofluffjobs.com/pl/job/<slug>
  It never calls nofluffjobs.com/api/.

EXAMPLES
  bun run src/cli.ts search -q "network" -l "krakow" --format table
  bun run src/cli.ts search -q "network" -l "krakow" --jobage 14 --limit 10 --format json
  bun run src/cli.ts detail business-analyst-murex-vistulo-for-a-major-n-american-bank-krakow --format plain

Personal use only — reads nofluffjobs.com public pages; keep volume low.
`

// Long-form flag names each command accepts (parseFlags resolves the short
// aliases q/l/n to these before validation). "help"/"h" pass so `search --help`
// still prints usage.
const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "location", "jobage", "page", "limit", "format", "help", "h",
    "detail-concurrency", "cache-dir",
  ]),
  detail: new Set(["format", "help", "h"]),
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const flags = parseFlags(argv)
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  // Reject unknown flags instead of silently discarding them: a discarded
  // filter changes what the search returns with no error. add-portal.md's
  // contract requires a bogus flag to exit 1 with a JSON error on stderr.
  const knownFlags = KNOWN_FLAGS[cmd]
  if (knownFlags) {
    for (const key of Object.keys(flags)) {
      if (key === "_" || knownFlags.has(key)) continue
      process.stderr.write(
        JSON.stringify({
          error: `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
          code: "UNKNOWN_FLAG",
        }) + "\n",
      )
      return 1
    }
  }

  if (cmd === "search") {
    const location = typeof flags.location === "string" ? flags.location : undefined
    if (!location) {
      process.stderr.write(
        JSON.stringify({
          error: 'the --location/-l flag is required (e.g. -l "krakow")',
          code: "NO_LOCATION",
        }) + "\n",
      )
      return 1
    }

    const fmt = (flags.format as string) || "json"

    const parseIntFlag = (name: string, raw: string | boolean | string[]): number | null => {
      const val = parseInt(raw as string, 10)
      if (isNaN(val)) {
        process.stderr.write(JSON.stringify({ error: `--${name} must be a number, got "${raw}"`, code: "BAD_ARG" }) + "\n")
        return null
      }
      return val
    }

    if (flags.jobage !== undefined) {
      const v = parseIntFlag("jobage", flags.jobage)
      if (v === null) return 1
      flags.jobage = String(v)
    }
    if (flags.page !== undefined) {
      const v = parseIntFlag("page", flags.page)
      if (v === null) return 1
      flags.page = String(v)
    }
    if (flags.limit !== undefined) {
      const v = parseIntFlag("limit", flags.limit)
      if (v === null) return 1
      flags.limit = String(v)
    }

    const opts: SearchOpts = {
      query: typeof flags.query === "string" ? flags.query : undefined,
      location,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      limit: flags.limit ? parseInt(flags.limit as string, 10) : 20,
      detailConcurrency: flags["detail-concurrency"]
        ? Math.max(1, parseInt(flags["detail-concurrency"] as string, 10))
        : 1,
      cacheDir: typeof flags["cache-dir"] === "string" ? flags["cache-dir"] : undefined,
      format: (["json", "table", "plain"].includes(fmt) ? fmt : "json") as SearchOpts["format"],
    }
    return runSearch(opts)
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      process.stderr.write(JSON.stringify({ error: "detail requires an <id|url>", code: "NO_ID" }) + "\n")
      return 1
    }
    const fmt = (flags.format as string) || "json"
    const opts: DetailOpts = {
      id,
      format: (fmt === "plain" ? "plain" : "json") as DetailOpts["format"],
    }
    return runDetail(opts)
  }

  process.stderr.write(JSON.stringify({ error: `Unknown command "${cmd}"`, code: "BAD_CMD" }) + "\n")
  return 1
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(
      JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        code: "INTERNAL_ERROR",
      }) + "\n",
    )
    process.exit(1)
  })
