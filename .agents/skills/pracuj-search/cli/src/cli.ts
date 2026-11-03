#!/usr/bin/env bun
// Self-contained CLI for searching jobs on pracuj.pl, Poland's largest job
// board. No external CLI framework, so it runs anywhere `bun` is available
// with zero install beyond the repo clone.
//
// Data comes from the __NEXT_DATA__ JSON embedded in the public /praca/
// search pages. robots.txt does not disallow /praca/ for any user-agent
// (verified with tools/robots_check.py); only asset and account paths are
// disallowed, and this CLI never touches those.
//
// Personal use only. Keep volume low and do not use it commercially or for
// bulk data collection. Run it on your own responsibility.

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

const HELP = `pracuj-cli — search jobs on pracuj.pl (Poland)

USAGE
  bun run src/cli.ts search [--query "<terms>"] [--location "<city>"] [flags]
  bun run src/cli.ts detail <id|url> [--format json|plain]

SEARCH FLAGS
  --query, -q <text>      Keywords (job title, skill, or role). Polish or English.
  --location, -l <city>   City to search, e.g. "Krakow", "Warszawa", "Wroclaw".
                          Omit to search all of Poland.
  --jobage <days>         Posted within N days. Applied client-side (pracuj.pl
                          exposes no recency parameter). Default: all.
  --remote <mode>         remote | hybrid | onsite. Applied client-side from the
                          offer's work modes.
  --page <n>              1-indexed page (~50 results/page). Default 1.
  --limit, -n <n>         Cap results emitted (client-side).
  --format <fmt>          json (default) | table | plain.

At least one of --query or --location is required, so a bare call cannot pull
down the whole board.

NOTES
  Results include salary (salaryDisplayText), work modes, seniority levels,
  contract types and technologies — fields most boards do not expose.
  City names are lowercased into the URL: "Kraków" and "krakow" both work.

EXAMPLES
  bun run src/cli.ts search -q "network architect" -l "Krakow" --format table
  bun run src/cli.ts search -q "network engineer" -l "Krakow" --jobage 30 --format table
  bun run src/cli.ts search -q "devops" --remote remote --limit 20 --format table
  bun run src/cli.ts search -q "sieci" -l "Warszawa" --page 2 --format json
  bun run src/cli.ts detail 1005028758 --format plain

Personal use only — reads pracuj.pl's public search pages; keep volume low.
`

// Long-form flag names each command accepts (parseFlags resolves the short
// aliases q/l/n to these before validation). "help"/"h" pass so `search --help`
// still prints usage.
const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([
    "query", "location", "jobage", "remote", "page", "limit", "format", "help", "h",
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
    const query = typeof flags.query === "string" ? flags.query : undefined
    const location = typeof flags.location === "string" ? flags.location : undefined

    if (!query && !location) {
      process.stderr.write(
        JSON.stringify({
          error:
            'at least one of --query/-q or --location/-l is required (e.g. -q "network architect" -l "Krakow")',
          code: "NO_CRITERIA",
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

    if (flags.remote !== undefined) {
      const mode = String(flags.remote).toLowerCase()
      if (!["remote", "hybrid", "onsite", "on-site"].includes(mode)) {
        process.stderr.write(
          JSON.stringify({
            error: `--remote must be one of remote|hybrid|onsite, got "${flags.remote}"`,
            code: "BAD_ARG",
          }) + "\n",
        )
        return 1
      }
    }

    const opts: SearchOpts = {
      query,
      location,
      jobage: flags.jobage ? parseInt(flags.jobage as string, 10) : 9999,
      remote: typeof flags.remote === "string" ? flags.remote : undefined,
      page: flags.page ? Math.max(1, parseInt(flags.page as string, 10)) : 1,
      limit: flags.limit ? parseInt(flags.limit as string, 10) : undefined,
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
