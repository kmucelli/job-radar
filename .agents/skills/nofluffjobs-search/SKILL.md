---
name: nofluffjobs-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search IT jobs in Poland on
  nofluffjobs.com — especially Krakow/Warsaw/Wroclaw network, DevOps, backend,
  cloud and security roles. Trigger phrases: nofluffjobs, no fluff jobs,
  praca IT krakow, network jobs poland, find this nofluff offer.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/nofluffjobs-search/cli/src/cli.ts *)
---

# NoFluffJobs Search Skill

Search live IT job listings from **nofluffjobs.com** (Poland). No
authentication, no API key, and **zero runtime dependencies** — it runs with
just `bun`.

## ⚠️ Robots / compliance

This skill does **not** call NoFluffJobs API endpoints. `robots.txt` disallows
`/api/`, so this CLI only reads public pages:

- listing: `https://nofluffjobs.com/pl/praca-it/<city>`
- detail: `https://nofluffjobs.com/pl/job/<slug>`

Validate with:

```bash
python tools/robots_check.py 'https://nofluffjobs.com/pl/praca-it/krakow'
python tools/robots_check.py 'https://nofluffjobs.com/pl/job/example-slug'
```

## How it works

Listing pages do not expose full job cards in schema.org, but they do expose
offer links. The CLI extracts those links from the public listing HTML, then
fetches each offer page and parses embedded posting data from page state.

Because this is a multi-request flow, default `--limit` is **20** and requests
are mildly throttled.

`--jobage` is applied **client-side** from each posting's publish timestamp,
because this robots-compliant route does not provide a stable, explicit server
recency filter we can rely on without API calls.

## Usage

```bash
bun run .agents/skills/nofluffjobs-search/cli/src/cli.ts search -q "network" -l "krakow" --format table
```

### Commands

| Command | Purpose |
|---------|---------|
| `search` | Search offers by city and keyword |
| `detail <id\|url>` | Fetch one offer including description |

### Search flags

| Flag | Meaning |
|------|---------|
| `--location`, `-l` | City, e.g. `krakow` (**required**) |
| `--query`, `-q` | Keywords (optional) |
| `--jobage <days>` | Posted within N days (**client-side**) |
| `--page <n>` | 1-indexed page. Default 1 |
| `--limit`, `-n` | Max emitted results. Default 20 |
| `--format` | `json` (default) \| `table` \| `plain` |

## Examples

```bash
# Network roles in Krakow
bun run .agents/skills/nofluffjobs-search/cli/src/cli.ts search -q "network" -l "krakow" --format table

# Last 14 days only
bun run .agents/skills/nofluffjobs-search/cli/src/cli.ts search -q "network" -l "krakow" --jobage 14 --format table

# Detail by slug
bun run .agents/skills/nofluffjobs-search/cli/src/cli.ts detail business-analyst-murex-vistulo-for-a-major-n-american-bank-krakow --format plain
```

## Output shape

`search` emits the repo-standard envelope:

```json
{
  "meta": { "count": 7, "page": 1, "totalOnPage": 20, "fetchedDetails": 20 },
  "results": [
    {
      "id": "business-analyst-murex-vistulo-for-a-major-n-american-bank-krakow",
      "title": "Business Analyst - Murex",
      "company": "Vistulo (for a major N. American bank)",
      "location": "Kraków; Remote; Wrocław; Poznań",
      "date": "2026-07-31T15:58:04.407Z",
      "url": "https://nofluffjobs.com/pl/job/business-analyst-murex-vistulo-for-a-major-n-american-bank-krakow",
      "salary": "200–240 PLN / Hour (B2B)",
      "workModes": ["remote"],
      "technologies": ["Murex", "FX Trading systems"]
    }
  ]
}
```

Unknown flags exit `1` and print a JSON error on stderr with code
`UNKNOWN_FLAG`; flags are never silently ignored.
