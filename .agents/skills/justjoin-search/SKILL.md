---
name: justjoin-search
version: 1.0.0
description: >
  Use this skill whenever the user wants to search for IT jobs in Poland on
  justjoin.it — in Krakow, Warsaw, Wroclaw, Gdansk, Poznan, Katowice, Lodz, or
  remotely. Trigger phrases: justjoin jobs, szukaj pracy IT, network jobs in
  Krakow, software jobs Poland, find this justjoin offer.
context: fork
enabled: true  # set to false to keep this portal installed but have /scrape skip it
allowed-tools: Bash(bun run .agents/skills/justjoin-search/cli/src/cli.ts *)
---

# JustJoin Search Skill

Search live IT job listings from **justjoin.it** (Poland). No authentication,
no API key, and **zero runtime dependencies** — it runs with just `bun`.

## ⚠️ Robots / compliance

This skill does **not** call JustJoin API endpoints. `robots.txt` disallows
`/api/`, so this CLI only reads public pages:

- listing: `https://justjoin.it/job-offers/<city>?keyword=<kw>`
- detail: `https://justjoin.it/job-offer/<slug>`

Validate any URL pattern with:

```bash
python tools/robots_check.py 'https://justjoin.it/job-offers/krakow?keyword=network'
python tools/robots_check.py 'https://justjoin.it/job-offer/example-slug'
```

## How it works

JustJoin listing pages expose only offer URLs in `CollectionPage.hasPart`
(`application/ld+json`), not full card data. To keep robots-compliant and still
return salary/company/location/date reliably, the CLI:

1. fetches the public listing page,
2. extracts offer URLs,
3. fetches a limited number of offer pages,
4. parses each offer page's embedded JSON/metadata.

Because this is multi-request, default `--limit` is **20** and the CLI adds a
small delay between detail requests to keep volume low.

`--jobage` is applied **client-side** from each offer's publication date.
JustJoin does not expose a stable server-side recency filter on this public
listing route that we can rely on without API calls.

## Usage

```bash
bun run .agents/skills/justjoin-search/cli/src/cli.ts search -q "network" -l "krakow" --format table
```

### Commands

| Command | Purpose |
|---------|---------|
| `search` | Search offers by city and keyword |
| `detail <id\|url>` | Fetch one offer including description |

### Search flags

| Flag | Meaning |
|------|---------|
| `--location`, `-l` | City, e.g. `krakow`, `warszawa` (**required**) |
| `--query`, `-q` | Keywords, e.g. `network`, `devops` |
| `--jobage <days>` | Posted within N days (**client-side**) |
| `--page <n>` | 1-indexed page. Default 1 |
| `--limit`, `-n` | Max emitted results. Default 20 |
| `--format` | `json` (default) \| `table` \| `plain` |

## Examples

```bash
# Network roles in Krakow
bun run .agents/skills/justjoin-search/cli/src/cli.ts search -q "network" -l "krakow" --format table

# Last 14 days only
bun run .agents/skills/justjoin-search/cli/src/cli.ts search -q "network" -l "krakow" --jobage 14 --format table

# Page 2, JSON output
bun run .agents/skills/justjoin-search/cli/src/cli.ts search -q "devops" -l "krakow" --page 2 --format json

# Detail by slug
bun run .agents/skills/justjoin-search/cli/src/cli.ts detail egnyte-poland-network-engineer-poznan-admin-8f313362 --format plain
```

## Output shape

`search` emits the repo-standard envelope:

```json
{
  "meta": { "count": 20, "page": 1, "totalOnPage": 140, "fetchedDetails": 31 },
  "results": [
    {
      "id": "egnyte-poland-network-engineer-poznan-admin-8f313362",
      "title": "Network Engineer",
      "company": "Egnyte Poland",
      "location": "Poznań",
      "date": "2026-08-24T12:00:46.2335988Z",
      "url": "https://justjoin.it/job-offer/egnyte-poland-network-engineer-poznan-admin-8f313362",
      "salary": "20 000–27 000 PLN / month (B2B)",
      "workModes": ["remote"],
      "technologies": ["Network Engineering", "Cloud-Native networking"]
    }
  ]
}
```

Unknown flags exit `1` and print a JSON error on stderr with code
`UNKNOWN_FLAG`; flags are never silently ignored.
