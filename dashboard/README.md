# Job Radar

A local job-search dashboard. It scrapes job portals, scores every posting
against **your CV**, and tracks your applications through
`applied → interview → rejected`.

Everything runs on your own machine. The server binds to `127.0.0.1` only —
nothing is exposed to the network, and no job data leaves your laptop.

```
┌────────────┐   scrape    ┌────────────┐   score vs CV   ┌────────────┐
│ job portals│ ──────────► │ jobs.json  │ ──────────────► │  dashboard │
└────────────┘             └────────────┘                 └────────────┘
```

---

## Setup

Use the one-step setup in the [main README](../README.md): `setup.cmd` on
Windows, `bash setup.sh` on macOS and Linux. It installs
[Bun](https://bun.sh) ≥ 1.1 (the only requirement), starts the dashboard at
<http://127.0.0.1:8899> and, on Windows, registers the start-at-logon and
daily-search tasks.

There is **no `npm install` step** and no `node_modules`. The app has zero
runtime dependencies — the PDF parser, the HTML parser and the scorer are all
written by hand in this folder. Node.js is *not* required.

| Also useful | Why |
|---|---|
| A CV in **text-based PDF** (or `.txt` / `.md`) | Keyword extraction reads the PDF text layer. |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | Optional "Use AI suggestions" for extra keyword variants. Everything else works without it. |

**Starting it by hand**, from this folder: `bun run start` runs the server in
the foreground; `start-dashboard.cmd` / `start-dashboard.sh` run it with a
keep-alive loop. Use a different port with `PORT=9000 ./start-dashboard.sh`, or
`bun run serve.ts --port 9000`.

---

## First run

1. **Upload your CV** — drag a PDF onto the *CV* panel. The app extracts
   keywords from it and shows them as clickable chips in *Smart Search*.
2. **Scrape** — pick a scope (Poland / Germany / Netherlands / EU remote /
   Everywhere) and a max job age, then press *Scrape Now*.
3. **Review** — jobs are scored `high` / `medium` / `low` against your CV and
   sorted. Mark them applied, add notes, or dismiss them.

---

## Job sources

| Scope | Sources |
|---|---|
| Poland | justjoin.it, NoFluffJobs, pracuj.pl, LinkedIn, BulldogJob, 100 employers' own career sites |
| Germany | LinkedIn, freehire, Arbeitsagentur, Arbeitnow, Himalayas, GermanTechJobs |
| Netherlands | LinkedIn, freehire, Himalayas, DevITJobs.nl |
| EU remote | LinkedIn, freehire, Himalayas, Remotive, Arbeitnow, Jobicy, We Work Remotely |
| Off by default | RemoteOK (noisy), Adzuna (needs a free key), EURES (no IT network roles in testing) |

Portal CLIs live in `.agents/skills/<portal>-search/` and are configured under
`portals` in `config.json`. Boards with an open API or feed are configured
under `apiSources`; their fetchers are in `scrape-daily.ts` and `sources.ts`.
Every source only reads paths its `robots.txt` allows, and none needs a login.
Set `enabled: false` to switch one off; `fetcher` lets two entries share one
implementation (GermanTechJobs and DevITJobs.nl are the same platform).

### Employers' career sites
Many companies post openings only on their own career site, not on the job
boards. The `careers` source (`careers.ts`) reads the Polish postings of the
companies in `companies.json`: IT vendors, cloud and data-center operators, IT
services, software houses, banks, fintech, insurance and industrial companies
with big IT hubs in Poland, both Polish and foreign. A posting is kept when every
word of a query starts a word of its title, so "network engineer" finds "Senior
Network Engineer"; its full advert is then read and it is scored like any other
job. In the dashboard these jobs show the source `careers`.

- Each company runs an applicant-tracking system with a public feed: Workday,
  Oracle Recruiting Cloud, Greenhouse, Lever, Workable, Teamtailor, or Amazon's
  own site. `companies.json` holds the ATS and its parameters per company.
- The first run of the day lists every company (a few minutes); the lists are
  then reused for 6 hours, so Smart Search runs add little traffic.
- Not covered: companies on SmartRecruiters or eRecruiter (their `robots.txt`
  forbids automated reading), Google Careers (same), and companies whose sites
  run SAP SuccessFactors, Avature, Taleo, iCIMS or an in-house system with no
  public feed. That includes most large Polish banks, telecoms and IT firms;
  their jobs usually reach the radar through pracuj.pl and the other boards.

To add or check a company, edit `companies.json` and run the probe from the
`dashboard` folder; it prints the Polish postings and title matches per company:

```bash
bun run careers --id cisco,codilime --query "network engineer" --days 30
```

---

## Features

### Smart Search
Type any keyword and press *Add*. The term is expanded automatically —
"network architect" also searches "network administrator", "network engineer"
and friends. Deselect any expansion you do not want before running.

The expansion also:

- fixes typos and plurals — `netwrok engineers` searches `network engineer`;
- spells out abbreviations — `sr network eng` searches `senior network engineer`,
  `dc engineer` searches `data center engineer`;
- keeps your seniority — `senior network engineer` searches
  `senior network administrator`, not the bare title;
- turns a bare topic into a title — `kubernetes` searches `kubernetes engineer`
  and its role family; certifications (`ccie`) map to their family instead;
- reads Polish/German queries — `inżynier sieci`, `Netzwerkadministrator`;
- adds native titles for the market — chips labelled **PL** / **DE** / **NL**
  (`inzynier sieci`, `netzwerkadministrator`, `netwerkbeheerder`). They are only
  searched when *Search in* covers that market; outside it they are dimmed.

Every chip's tooltip says why it was added. Everything comes from
`keyword-map.json` — edit it to add titles, languages or abbreviations.

A search runs every selected term; the run button shows the count. One search
takes at most 100 terms (roughly half an hour on *Everywhere*, as each term is
a full sweep of every portal). Above that the button is disabled until you
switch off some related terms or remove a keyword.

CV-derived keywords appear as chips underneath; click one to add it.

### Search box
The box above the job list understands more than plain text:

| Type | Finds |
|---|---|
| `engineer network` | titles with both words, in any order |
| `wroclaw`, `kubernetes`, `cisco` | location, technologies and matched skills as well as title/company |
| `sr`, `dc`, `k8s`, `eng` | the spelled-out word too (and back: `senior` finds "Sr.") |
| `netwrok` | typos fixed against the words in your job list |
| `network administrator` | the other titles of that role family as well (network engineer, …) |
| `"network administrator"` | exactly that phrase |
| `-security` | excludes jobs with that word in title, company or location |

Accents never matter (`krakow` finds Kraków). The line above the jobs says how
the query was read, e.g. `sr = senior`, `netwrok → network`.

### Application tracking
Stage and notes are stored server-side in `data/job-states.json`, keyed on
company + title rather than URL — so a job you dismissed does not reappear
tomorrow just because a portal re-slugged its link.

### Which jobs are kept
Relevance is decided by the job **title** first, the description second
(`scoring` in `config.json`):

- a title naming networking (`onDomainTitle`: network, cisco, data center, …)
  or one of your CV's own role titles is kept and ranked by its score;
- a title naming another profession is dropped, whatever the description says.
  `offDomainTitle` (java, devops, …) yields to a networking word ("Network
  Automation Engineer (DevOps)" stays); `hardOffDomainTitle` (software
  engineer, developer, project manager, …) never does;
- any other title must show networking evidence in the posting itself. Generic
  skills (`supportingTerms`: python, terraform, ansible, git, ci/cd) rank a job
  but never qualify one, and ambiguous terms (`contextRequired`: Sonatype
  *Nexus*, AWS *VPC*) only count next to their networking context.

A profession named in one of your CV's own job titles is never treated as
off-domain. After editing these lists, `bun run rescore` re-applies them to the
current job list without scraping.

### Language requirements
Every job is tagged with the non-English languages it requires
(`language-req.ts`). A language counts when

- the title names it — "Network Engineer with German";
- a sentence names it next to a requirement or a CEFR level — "sehr gute
  Deutschkenntnisse", "fluent Polish (C1)", "znajomość języka niemieckiego" —
  unless a nice-to-have sits closer to it ("German is a plus", "mile widziana");
- or the description itself is written in German, Polish, Dutch or French.

English is never tagged. Cards show one chip per language ("German required",
"Written in Polish"); hover it to see the line that triggered it.

The **Language req.** menu above the job list hides jobs per language. Until
you change it, the languages your profile does not list at all
(`profile.languages` in `config.json`) are hidden — *Default* restores that,
*Show all* hides nothing. The line above the jobs says how many are hidden by
language.

LinkedIn and the Arbeitsagentur return only a title in their search results,
so the scraper reads the full advert of each job (cached for 72h under
`data/cache/`) to find a "requires fluent German" line. The markers, the
written-in detection and those sources live under `languageGate` in
`config.json`; `dropAtScrape: true` discards such jobs at scrape time instead
of tagging them. `bun run langs` re-tags the current job list without scraping.

---

## Daily automatic scrape

**Windows** — nothing to do: `setup.cmd` registers the task
**JobRadar Daily Scrape**, which runs `run-daily.cmd` every day at 09:00 (a
missed run starts when the PC is next on).

**macOS / Linux** — cron:

```bash
crontab -e
# then add, with your real path:
0 9 * * * cd /path/to/job-radar && ~/.bun/bin/bun run dashboard/scrape-daily.ts --jobage 1 >> dashboard/data/scrape.log 2>&1
```

---

## Commands

| Command | What it does |
|---|---|
| `bun run start` | Start the dashboard on port 8899 |
| `bun run dev` | Same, with auto-reload on file changes |
| `bun run scrape` | Scrape jobs posted in the last 1 day |
| `bun run scrape:week` | Scrape the last 7 days |
| `bun run rescore` | Re-apply the relevance rules in `config.json` to the current job list (no scraping) |
| `bun run langs` | Re-tag the current job list's language requirements, reading the missing LinkedIn / Arbeitsagentur adverts (no scraping) |
| `bun run keywords` | Print the keywords extracted from your CV |
| `bun run careers` | Check every company in `companies.json` against its live career feed (`--id a,b`, `--query`, `--days`, `--fresh`) |
| `bun test` | Run the relevance, identity, keyword-expansion, search-box, language and career-site test suites |

---

## HTTP API

All endpoints are local-only.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/scrape` | Status of the running/last scrape, incl. % progress and `maxAdhocQueries` |
| `POST` | `/api/scrape` | Start a scrape (`?jobage=1&scope=ALL`) |
| `POST` | `/api/scrape/cancel` | **Stop a stuck scrape** |
| `POST` | `/api/scrape/adhoc` | Scrape user-supplied keywords (at most 100 terms; a longer list is refused, not shortened) |
| `GET` | `/api/keywords/expand?q=` | Preview keyword expansion (`&scope=PL\|DE\|NL\|EU\|ALL` limits native-language titles) |
| `GET` | `/api/cv` · `POST /api/cv` | CV metadata / upload |
| `GET` | `/api/cv/keywords` | Keywords derived from the stored CV (`?force=1` to re-parse) |
| `GET` · `POST` | `/api/job-states` | Application stage and notes |

---

## Where your data lives

Everything is under `dashboard/data/`:

| File | Contents |
|---|---|
| `jobs.json` / `jobs.js` | The scraped job list rendered by the dashboard |
| `job-states.json` | Your application stages and notes |
| `cv/` | Uploaded CVs (kept, timestamped) |
| `cv-keywords.json` | Cached keywords extracted from the current CV |
| `seen.json` | First-seen timestamps, used for the "New" badge |
| `cache/` | Parsed justjoin / nofluffjobs offer pages, and the LinkedIn / Arbeitsagentur adverts read for language requirements, reused for 72h so a repeat offer costs no request; expired files are pruned each run |
| `server.log` · `scrape.log` | Logs |

This folder is personal data. Do not commit it — check that `data/` is in
`.gitignore` before pushing anywhere.

---

## Troubleshooting

**The Add button / keyword box is greyed out**
Older builds disabled the whole Smart Search panel while a scrape was running,
so a hung scrape locked it permanently. Fixed: only *Run* is gated now, and
there is a **Cancel** button plus a one-hour watchdog that force-resets a
stalled run. If you are on an old copy, `POST /api/scrape/cancel` or restart
the server.

**"Failed to start server. Is port 8899 in use?"**
Another copy is already running. Open <http://127.0.0.1:8899>, or start this
one on a different port with `PORT=9000`.

**"No keywords could be read from the stored CV"**
The PDF has no text layer — it is a scan or an export of an image. Re-export it
as a text-based PDF, or upload a `.txt` / `.md` version. `.docx` and `.odt` are
*not* parsed.

**A scrape finishes but no new jobs appear**
Portals rate-limit and change markup. Check `data/scrape.log`, and look at the
per-portal `health` array in `jobs.json` to see which source returned nothing.

**`bun: command not found` from a scheduled task**
Task Scheduler and cron do not load your interactive shell PATH. The launch
scripts fall back to the standard install locations; if you installed Bun
somewhere unusual, set an absolute path at the top of the script.

---

## License

MIT. See `LICENSE` in the repository root.
