---
name: pracuj-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search for jobs in Poland — in
  Krakow, Warsaw, Wroclaw, Gdansk, Poznan, Katowice, Lodz, or anywhere else in
  the country, including remote Polish roles. pracuj.pl is Poland's largest
  general job board and covers every sector (IT, engineering, finance, sales,
  logistics, marketing, legal, manufacturing). Trigger phrases: find a job in
  Poland, praca, oferty pracy, job search Krakow, jobs in Warsaw, Polish job
  board, "are there any X jobs in <Polish city>", look up this pracuj offer.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/pracuj-search/cli/src/cli.ts *)
---

# Pracuj.pl Search Skill

Search live job listings from **pracuj.pl**, Poland's largest job board. No
authentication, no API key, and **zero runtime dependencies** — it runs with
just `bun`.

## Why this portal

Pracuj returns noticeably richer data than most boards. Every result carries:

- **`salary`** — the advertised range, when the employer published one
- **`workModes`** — stacjonarna / hybrydowa / zdalna
- **`positionLevels`** — junior / mid / senior / manager
- **`contractTypes`** — umowa o pracę, B2B, zlecenie
- **`technologies`** — the tech stack, on IT postings

Salary in particular is worth having: it feeds the `/apply` salary-benchmarking
step directly, and most portals never expose it.

## ⚠️ Personal use only

This reads pracuj.pl's **public** search pages. `robots.txt` does not disallow
`/praca/` for any user-agent — only asset and account paths are disallowed, and
this CLI never touches those. Verify at any time with:

```bash
python3 tools/robots_check.py 'https://www.pracuj.pl/praca/network;kw'
```

Keep volume low. Do not use this commercially or for bulk data collection.

## How it works

Pracuj is a Next.js application that ships its search results as JSON inside the
`__NEXT_DATA__` script tag. The CLI fetches the public HTML page and reads that
embedded JSON rather than scraping the rendered DOM — the JSON is both more
stable and considerably richer than the markup.

## Usage

Run from the repository root:

```bash
bun run .agents/skills/pracuj-search/cli/src/cli.ts search -q "network architect" -l "Krakow" --format table
```

### Commands

| Command | Purpose |
|---------|---------|
| `search` | Search offers by keyword and/or city |
| `detail <id\|url>` | Fetch one offer including its full description |

### Search flags

| Flag | Meaning |
|------|---------|
| `--query`, `-q` | Keywords (Polish or English) |
| `--location`, `-l` | City, e.g. `Krakow`, `Warszawa`. Omit for all of Poland |
| `--jobage <days>` | Posted within N days (**client-side**, see below) |
| `--remote <mode>` | `remote` \| `hybrid` \| `onsite` (**client-side**, see below) |
| `--page <n>` | 1-indexed page, ~50 results per page. Default 1 |
| `--limit`, `-n` | Cap results emitted |
| `--format` | `json` (default) \| `table` \| `plain` |

At least one of `--query` or `--location` is required, so a bare call cannot
pull down the whole board.

### Client-side filters — why

Pracuj exposes **no query parameter for recency or work mode** that survives a
redirect (`?wm=`, `?its=` and `/home-office;wm` all answer 301). Rather than
invent a flag that would silently return unfiltered results, `--jobage` and
`--remote` filter the parsed payload using the `lastPublicated` and `workModes`
fields every offer already carries.

This matters for `/scrape`: its "scope to the last 14 days" rule is genuinely
honoured here, not quietly skipped. It also means `--limit` is applied *after*
filtering, so a small limit combined with a tight `--jobage` may return fewer
rows than the limit — that is correct behaviour, not a bug.

## Examples

```bash
# Network architect roles in Krakow
bun run .agents/skills/pracuj-search/cli/src/cli.ts search -q "network architect" -l "Krakow" --format table

# Anything network-related in Krakow posted in the last 30 days
bun run .agents/skills/pracuj-search/cli/src/cli.ts search -q "network" -l "Krakow" --jobage 30 --format table

# Fully-remote DevOps roles anywhere in Poland
bun run .agents/skills/pracuj-search/cli/src/cli.ts search -q "devops" --remote remote --limit 20 --format table

# Second page of results, as JSON
bun run .agents/skills/pracuj-search/cli/src/cli.ts search -q "sieci" -l "Warszawa" --page 2 --format json

# Full detail for one offer
bun run .agents/skills/pracuj-search/cli/src/cli.ts detail 1005028758 --format plain
```

## Output shape

`search` emits the repo's standard envelope:

```json
{
  "meta": { "count": 18, "page": 1, "totalOnPage": 18, "totalMatches": 31 },
  "results": [
    {
      "id": "1005028758",
      "title": "Inżynier Sieciowy (Network Engineer)",
      "company": "DCN EUROPE S.A.",
      "companyUrl": null,
      "location": "Kraków, Podgórze Duchackie",
      "date": "2026-08-24T13:43:44.27Z",
      "url": "https://www.pracuj.pl/praca/...,oferta,1005028758",
      "salary": "10 000–15 000 zł / mies. (zal. od umowy)",
      "workModes": ["Praca stacjonarna", "Praca hybrydowa"],
      "positionLevels": ["Specjalista / Specjalistka (mid / Regular)"],
      "contractTypes": ["Umowa o pracę", "Kontrakt B2B"],
      "technologies": [],
      "remote": false
    }
  ]
}
```

`meta.totalMatches` is Pracuj's own count of matching offers across all pages;
`meta.count` is what this call returned after filters and `--limit`.

## Notes for the job-scraper skill

- City names are lowercased into the URL, so `Kraków` and `krakow` both work.
- A grouped offer can span several cities; `location` joins them with `; `, and
  a nationwide posting reports `Cała Polska`.
- Polish-language titles are common even at international employers. Searching
  the English term alone will miss roles — pair `network` with `sieci`,
  `inżynier`, or `administrator` for good coverage.
- Unknown flags exit 1 with a JSON error on stderr; they are never ignored.
