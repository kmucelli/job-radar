#!/usr/bin/env bun
/**
 * serve.ts — local-only web server for the Job Radar dashboard.
 *
 * Exists because a file:// page cannot receive a file upload, write to disk, or
 * start the scrapers. Binds to 127.0.0.1 ONLY — never exposed to the network.
 *
 * Routes
 *   GET  /                 index.html
 *   GET  /data/*           generated data (jobs.js, jobs.json)
 *   GET  /api/cv           metadata for the CV on file + upload history
 *   GET  /api/cv/file      download the current CV
 *   POST /api/cv           multipart upload of a fresh CV (field name: "cv")
 *   GET  /api/job-states   per-job pipeline stage + notes, keyed by canonical URL
 *   POST /api/job-states   set/clear a stage and/or edit the note for one job
 *   POST /api/scrape       start a scrape in the background
 *   GET  /api/scrape       status of the running/last scrape (incl. % progress)
 *   POST /api/scrape/adhoc start a scrape against user-supplied keywords
 *   GET  /api/keywords/expand?q=[&scope=PL|DE|NL|EU|ALL]  preview the smart
 *                          expansion of one keyword (scope limits PL/DE/NL titles)
 *   GET  /api/cv/keywords  keywords derived from the stored CV
 *
 * Usage: bun run dashboard/serve.ts [--port 8899]
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adhocQueryList,
  expandQuery,
  expandQuerySmart,
  llmAvailable,
  MAX_ADHOC_QUERIES,
  MAX_EXPANSIONS,
} from "./keyword-expand.ts";
import { cvKeywordsCached, invalidateCvKeywords } from "./cv-keywords.ts";
import { jobIdentity } from "./job-identity.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DATA = join(HERE, "data");
const CVDIR = join(DATA, "cv");

const args = process.argv.slice(2);
const portIdx = args.indexOf("--port");
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 8899;

const MAX_CV_BYTES = 15 * 1024 * 1024; // 15 MB - generous for a PDF CV
const ALLOWED_CV_EXT = new Set([".pdf", ".doc", ".docx", ".txt", ".md", ".rtf", ".odt"]);

mkdirSync(CVDIR, { recursive: true });

// ---------------------------------------------------------------------------
// Scrape process management
// ---------------------------------------------------------------------------

let scrapeProc: ChildProcess | null = null;

/**
 * `progress` mirrors the @@PROGRESS markers scrape-daily.ts prints on stdout.
 * The scraper is the only component that knows how many portal/query pairs it
 * is about to walk, so it declares the denominator itself and we just relay it.
 * Markers are stripped from `log` so the dashboard's log pane stays readable.
 */
type ScrapeProgress = { done: number; total: number; percent: number; label: string };

let scrapeState: {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
  log: string;
  progress: ScrapeProgress | null;
  scope: string | null;
} = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  log: "",
  progress: null,
  scope: null,
};

const PROGRESS_RE = /^@@PROGRESS (.+)$/;

/** Search scopes the UI may request. Mirrors config.json's "scopes" values. */
const SCOPES = ["PL", "DE", "NL", "EU", "ALL"];

/**
 * Splits a raw stdout chunk into progress markers and ordinary log text.
 * Carries a partial trailing line between chunks — a marker split across two
 * reads would otherwise be silently dropped and the bar would stall.
 */
let progressCarry = "";
function consumeChunk(text: string): string {
  const lines = (progressCarry + text).split("\n");
  progressCarry = lines.pop() ?? "";
  const passthrough: string[] = [];

  for (const line of lines) {
    const m = PROGRESS_RE.exec(line.trim());
    if (!m) {
      passthrough.push(line);
      continue;
    }
    try {
      const p = JSON.parse(m[1]);
      scrapeState.progress = {
        done: Number(p.done) || 0,
        total: Number(p.total) || 0,
        percent: Math.max(0, Math.min(100, Number(p.percent) || 0)),
        label: String(p.label ?? ""),
      };
    } catch {
      // Malformed marker: ignore it rather than killing the log stream.
    }
  }

  return passthrough.length ? passthrough.join("\n") + "\n" : "";
}

function startScrape(jobage: string, scope: string, extraArgs: string[] = []) {
  if (scrapeState.running) return false;

  progressCarry = "";
  scrapeState = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    log: "",
    progress: { done: 0, total: 0, percent: 0, label: "Starting…" },
    scope,
  };

  // The running bun binary, spawned without a shell: through cmd.exe the
  // arguments are not quoted, so `--queries "network architect,inzynier sieci"`
  // arrived as `--queries network` and an ad-hoc search ran one word.
  scrapeProc = spawn(
    process.execPath,
    [
      "run",
      join(HERE, "scrape-daily.ts"),
      "--jobage",
      jobage,
      "--scope",
      scope,
      ...extraArgs,
    ],
    { cwd: REPO },
  );

  const proc = scrapeProc;
  const append = (d: Buffer) => {
    if (scrapeProc !== proc) return; // a cancelled run must not write into the next one
    // Cap the buffer so a runaway process cannot exhaust memory.
    scrapeState.log = (scrapeState.log + consumeChunk(d.toString())).slice(-20_000);
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);
  proc.on("close", (code) => {
    // After a cancel, stopScrape() already owns the state; a late close from
    // this (now orphaned) process must not overwrite it or a newer run.
    if (scrapeProc !== proc) return;
    scrapeState.running = false;
    scrapeState.finishedAt = new Date().toISOString();
    scrapeState.exitCode = code;
    // A clean exit means every unit of work finished, even if the final marker
    // was lost in a truncated chunk — pin the bar to 100% so it never ends at 97%.
    if (code === 0 && scrapeState.progress) {
      scrapeState.progress = { ...scrapeState.progress, percent: 100, done: scrapeState.progress.total };
    }
    scrapeProc = null;
  });
  proc.on("error", (e) => {
    if (scrapeProc !== proc) return;
    scrapeState.running = false;
    scrapeState.finishedAt = new Date().toISOString();
    scrapeState.exitCode = -1;
    scrapeState.log += `\nspawn error: ${e}`;
    scrapeProc = null;
  });

  return true;
}

/**
 * Force a stuck scrape back to idle.
 *
 * `running` gates several controls in the UI, so a scraper that dies without
 * emitting "close" (killed externally, machine slept, server restarted while a
 * child was live) leaves the dashboard permanently disabled with no way back
 * except restarting the server. Both the explicit cancel endpoint and the
 * reaper below funnel through here.
 */
function stopScrape(reason: string): boolean {
  if (!scrapeState.running) return false;
  const pid = scrapeProc?.pid;
  try {
    if (process.platform === "win32" && pid) {
      // kill() would only end the scraper itself and leave every portal CLI it
      // spawned running (and still writing jobs.json). /T takes the tree down.
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      scrapeProc?.kill();
    }
  } catch {
    /* already gone */
  }
  scrapeProc = null;
  scrapeState.running = false;
  scrapeState.finishedAt = new Date().toISOString();
  scrapeState.exitCode = -1;
  scrapeState.log += `\n${reason}\n`;
  return true;
}

/**
 * Longest a single run may claim to be alive. A full ALL-scope sweep is minutes,
 * not hours, so anything past this is a corpse holding the UI hostage.
 */
const STALE_SCRAPE_MS = 60 * 60 * 1000;

/**
 * Called on every status poll. Catches the two ways `running` gets stranded:
 * a missing child process, and a run that has simply been "in progress" for
 * implausibly long.
 */
function reapStaleScrape() {
  if (!scrapeState.running) return;
  if (!scrapeProc) {
    stopScrape("scrape process vanished — state reset by watchdog");
    return;
  }
  const started = scrapeState.startedAt ? Date.parse(scrapeState.startedAt) : 0;
  if (started && Date.now() - started > STALE_SCRAPE_MS) {
    stopScrape("scrape exceeded the maximum run time — cancelled by watchdog");
  }
}

// ---------------------------------------------------------------------------
// CV storage and keyword derivation.
//
// The CV is stored here and ALSO mined for search keywords (cv-keywords.ts),
// which are appended to the queries of every scrape. The curated queries in
// config.json remain the baseline and are never overwritten — CV keywords are
// strictly additive, capped by --cv-keyword-limit, and can be turned off for a
// run with --no-cv-keywords.
// ---------------------------------------------------------------------------

function cvMeta() {
  const cur = join(CVDIR, "current.json");
  const current = existsSync(cur) ? JSON.parse(readFileSync(cur, "utf8")) : null;
  const history = readdirSync(CVDIR)
    .filter((f) => f !== "current.json")
    .map((f) => ({ file: f }))
    .reverse();
  return { current, history };
}

/** Strip any path component and anything that is not a safe filename char. */
function safeName(name: string) {
  const base = name.replace(/^.*[\\/]/, "");
  return base.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120) || "cv";
}

// ---------------------------------------------------------------------------
// Per-job application pipeline: stage ("applied" -> "interview" -> "rejected",
// plus "deleted" to dismiss a card) and a free-text note.
//
// Persisted server-side rather than in the browser on purpose — the scraper
// re-discovers the same postings every morning, so a card dismissed in the UI
// would silently come back at the next 09:00 run if the state lived only in
// localStorage. The same reasoning applies doubly to notes, which are typed by
// hand and must survive a reload, a server restart, and a daily scrape.
//
// scrape-daily.ts never reads or writes this file — it only regenerates
// jobs.json / jobs.js / seen.json — so a scrape cannot clobber user state.
//
// Keyed by canonical URL (query string and trailing slash stripped), which is
// the same key scrape-daily.ts dedups on.
// ---------------------------------------------------------------------------

const STATES = join(DATA, "job-states.json");

const STAGES = ["applied", "interview", "rejected", "deleted"] as const;
type Stage = (typeof STAGES)[number];

const MAX_NOTE_CHARS = 4000;
const MAX_HISTORY = 20;

/**
 * `state` is optional: a job may carry a note before it carries any stage, and
 * clearing the stage must not throw the note away. An entry with neither a
 * stage nor a note is deleted outright rather than persisted as an empty shell.
 */
type JobState = {
  state?: Stage;
  at: string; // when the CURRENT stage was set — not bumped by note edits
  title?: string;
  company?: string;
  note?: string;
  noteAt?: string; // when the note was last edited
  history?: { state: Stage; at: string; auto?: boolean }[]; // transitions, oldest first
  /**
   * Set when the stale-application sweep moved this to "rejected" on its own,
   * rather than the user rejecting it. Drives the "IGNORED" badge, and is
   * cleared the moment the user sets a stage by hand.
   */
  autoRejected?: boolean;
  /** When the job was originally marked applied, preserved across the sweep. */
  appliedAt?: string;
  /**
   * Portal-independent key (normalised company + title) — see job-identity.ts.
   * The URL an entry is filed under is not stable: the same vacancy is listed
   * on several boards, and which one survives dedup changes between runs. The
   * dashboard matches on this as well as the URL, so a job the user deleted
   * stays deleted when it resurfaces under a different board's link.
   */
  identity?: string;
};

// ---------------------------------------------------------------------------
// Stale application sweep.
//
// An application that has heard nothing back for two weeks is, in practice, a
// rejection — it just never arrives. Rather than leaving those cluttering the
// Applied tab forever, move them to Rejected and tag them "Ignored" so they
// stay visually distinct from employers who actually said no.
//
// "Activity" is the later of the stage change and the last note edit, so
// touching a job (adding a note, moving it back to applied) resets the clock.
// This runs server-side, on a timer and on every read, so it still happens on
// days the dashboard is never opened.
// ---------------------------------------------------------------------------

const IGNORE_AFTER_DAYS = 14;
const IGNORE_AFTER_MS = IGNORE_AFTER_DAYS * 24 * 60 * 60 * 1000;

function lastActivity(e: JobState): number {
  const stamps = [e.at, e.noteAt].filter(Boolean).map((s) => new Date(s as string).getTime());
  const valid = stamps.filter((n) => Number.isFinite(n));
  return valid.length ? Math.max(...valid) : 0;
}

/**
 * Moves stale "applied" entries to "rejected" with autoRejected set.
 * Returns the number of entries changed; the caller persists if non-zero.
 */
function sweepStale(states: Record<string, JobState>, now = Date.now()): number {
  let changed = 0;
  for (const entry of Object.values(states)) {
    if (entry.state !== "applied") continue;
    const seen = lastActivity(entry);
    // A malformed/missing timestamp would otherwise read as 1970 and instantly
    // reject the job, so skip anything we cannot date.
    if (!seen) continue;
    if (now - seen < IGNORE_AFTER_MS) continue;

    const at = new Date(now).toISOString();
    entry.appliedAt = entry.appliedAt ?? entry.at;
    entry.state = "rejected";
    entry.autoRejected = true;
    entry.at = at;
    entry.history = [...(entry.history ?? []), { state: "rejected", at, auto: true }].slice(
      -MAX_HISTORY,
    );
    changed++;
  }
  return changed;
}

/** Read states, applying (and persisting) the stale sweep and identity backfill. */
function readStatesSwept(): Record<string, JobState> {
  const states = readStates();
  if (sweepStale(states) + backfillIdentity(states) > 0) writeStates(states);
  return states;
}

function canonUrl(u: string) {
  return String(u).split("?")[0].replace(/\/+$/, "").toLowerCase();
}

function readStates(): Record<string, JobState> {
  if (!existsSync(STATES)) return {};
  try {
    return JSON.parse(readFileSync(STATES, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Fill in `identity` on entries written before it existed. Every entry already
 * carries the title and company it was saved with, so this is derivable and
 * needs no guessing — without it, everything deleted before this change would
 * keep coming back under a new URL.
 *
 * Returns the number of entries touched; the caller persists if non-zero.
 */
function backfillIdentity(states: Record<string, JobState>): number {
  let changed = 0;
  for (const entry of Object.values(states)) {
    if (entry.identity) continue;
    const id = jobIdentity(entry.company, entry.title);
    if (!id) continue; // too little to identify it — leave it URL-keyed
    entry.identity = id;
    changed++;
  }
  return changed;
}

function writeStates(s: Record<string, JobState>) {
  // Write-then-rename: notes are hand-typed and unrecoverable, so a crash
  // mid-write must not be able to leave a truncated job-states.json behind.
  const tmp = STATES + ".tmp";
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATES);
}

/**
 * Accepts a partial update. `state` and `note` are handled independently so
 * that moving a job to "interview" never discards the note attached to it, and
 * editing a note never resets the stage or its timestamp.
 *
 *   { url, state: "interview" }   -> change stage, keep note
 *   { url, note: "call on Tue" }  -> change note, keep stage
 *   { url, state: null }          -> clear stage, keep note (this is "undo")
 *   { url, note: "" }             -> clear note, keep stage
 *
 * An entry left with neither a stage nor a note is removed entirely.
 */
async function handleJobState(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "expected JSON body" }, 400);
  }

  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!url) return json({ error: "missing 'url'" }, 400);

  const hasState = body !== null && typeof body === "object" && "state" in body;
  const hasNote = body !== null && typeof body === "object" && "note" in body;
  if (!hasState && !hasNote)
    return json({ error: "nothing to update: provide 'state', 'note', or both" }, 400);

  const states = readStates();
  backfillIdentity(states);
  const key = canonUrl(url);
  // Fall back to the vacancy's identity when this exact URL has not been seen
  // before: the posting may already carry a note and a history filed under the
  // link a previous scrape used. Starting fresh would silently drop them.
  const identity = jobIdentity(
    typeof body.company === "string" ? body.company : undefined,
    typeof body.title === "string" ? body.title : undefined,
  );
  const prev =
    states[key] ??
    (identity ? Object.values(states).find((e) => e.identity === identity) : undefined);
  const now = new Date().toISOString();

  // Start from the existing record so untouched fields survive the update.
  const next: JobState = prev ? { ...prev } : { at: now };

  if (hasState) {
    const state = body.state;
    if (state === null || state === "none") {
      delete next.state;
    } else if (!STAGES.includes(state)) {
      return json({ error: `state must be one of ${STAGES.join(", ")}, or null` }, 400);
    } else if (state !== prev?.state) {
      next.state = state;
      next.at = now;
      next.history = [...(prev?.history ?? []), { state, at: now }].slice(-MAX_HISTORY);
    }
    // Any hand-set stage means the user has taken this over: it is no longer an
    // auto-ignored entry, and re-applying restarts the two-week clock.
    delete next.autoRejected;
  }

  if (hasNote) {
    const note = typeof body.note === "string" ? body.note.trim().slice(0, MAX_NOTE_CHARS) : "";
    if (note) {
      next.note = note;
      next.noteAt = now;
    } else {
      delete next.note;
      delete next.noteAt;
    }
  }

  // Refresh the labels while we are here; the scraper can reword a title.
  if (typeof body.title === "string") next.title = body.title.slice(0, 200);
  if (typeof body.company === "string") next.company = body.company.slice(0, 120);

  // Key this entry by vacancy, not just by link, so the state survives the URL
  // changing under it on the next scrape.
  next.identity = jobIdentity(next.company, next.title) || undefined;

  if (!next.state && !next.note) {
    delete states[key];
    // Clearing is an undo: drop the stale sibling entries this vacancy has
    // accumulated under other boards' URLs too, or the next read would resurrect
    // the state we were just asked to remove.
    if (next.identity) {
      for (const [k, e] of Object.entries(states)) {
        if (k !== key && e.identity === next.identity && !e.note) delete states[k];
      }
    }
    writeStates(states);
    return json({ ok: true, url: key, entry: null });
  }

  states[key] = next;
  writeStates(states);
  return json({ ok: true, url: key, entry: next });
}

async function handleCvUpload(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "could not read upload (expected multipart/form-data)" }, 400);
  }

  const file = form.get("cv");
  if (!(file instanceof File)) return json({ error: "no file in field 'cv'" }, 400);
  if (file.size === 0) return json({ error: "file is empty" }, 400);
  if (file.size > MAX_CV_BYTES)
    return json({ error: `file too large (${file.size} bytes, max ${MAX_CV_BYTES})` }, 413);

  const clean = safeName(file.name);
  const ext = extname(clean).toLowerCase();
  if (!ALLOWED_CV_EXT.has(ext))
    return json({ error: `unsupported file type '${ext}'` }, 415);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stored = `${stamp}__${clean}`;
  writeFileSync(join(CVDIR, stored), Buffer.from(await file.arrayBuffer()));

  const meta = {
    originalName: clean,
    storedAs: stored,
    sizeBytes: file.size,
    uploadedAt: new Date().toISOString(),
  };
  writeFileSync(join(CVDIR, "current.json"), JSON.stringify(meta, null, 2));

  // The derived-keyword cache is keyed by stored filename; a new CV must not
  // keep serving the previous CV's keywords.
  invalidateCvKeywords();

  return json({ ok: true, cv: meta });
}

// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveFile(absPath: string): Response {
  if (!existsSync(absPath)) return new Response("not found", { status: 404 });
  return new Response(Bun.file(absPath), {
    headers: {
      "content-type": MIME[extname(absPath).toLowerCase()] ?? "application/octet-stream",
      // The dashboard must never show yesterday's cached data after a scrape.
      "cache-control": "no-store",
    },
  });
}


Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // local only, deliberately not 0.0.0.0
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/cv" && req.method === "POST") return handleCvUpload(req);
    if (p === "/api/cv" && req.method === "GET") return json(cvMeta());

    if (p === "/api/job-states" && req.method === "GET") return json(readStatesSwept());
    if (p === "/api/job-states" && req.method === "POST") return handleJobState(req);

    if (p === "/api/cv/file" && req.method === "GET") {
      const { current } = cvMeta();
      if (!current) return json({ error: "no CV on file" }, 404);
      return serveFile(join(CVDIR, current.storedAs));
    }

    if (p === "/api/scrape" && req.method === "POST") {
      const jobage = url.searchParams.get("jobage") ?? "1";
      if (!/^\d{1,2}$/.test(jobage)) return json({ error: "bad jobage" }, 400);
      // Whitelisted rather than passed through: this value becomes a CLI
      // argument to a spawned process.
      const scope = (url.searchParams.get("scope") ?? "ALL").toUpperCase();
      if (!SCOPES.includes(scope)) return json({ error: `bad scope '${scope}'` }, 400);
      const started = startScrape(jobage, scope);
      return json({ started, state: scrapeState }, started ? 202 : 409);
    }
    if (p === "/api/scrape" && req.method === "GET") {
      reapStaleScrape();
      // The term limit rides along so Smart Search can disable its run button
      // before sending a list the ad-hoc route would refuse.
      return json({ ...scrapeState, maxAdhocQueries: MAX_ADHOC_QUERIES });
    }

    // Explicit escape hatch for a run that is wedged. Without this the only
    // recovery from a hung scraper is restarting the server process.
    if (p === "/api/scrape/cancel" && req.method === "POST") {
      const stopped = stopScrape("scrape cancelled by user");
      return json({ stopped, state: scrapeState }, stopped ? 200 : 409);
    }

    // --- Smart keyword expansion -------------------------------------------
    // Preview only: returns what an ad-hoc run WOULD search, so the UI can show
    // the expansion and let the user drop terms before spending the requests.
    if (p === "/api/keywords/expand" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return json({ error: "missing q" }, 400);
      const useLlm = url.searchParams.get("llm") === "1";
      const max = Math.min(Number(url.searchParams.get("max")) || MAX_EXPANSIONS, 30);
      // Optional: limits native-language titles to the scope's market. Without
      // it every language is returned and the dashboard filters at run time.
      const rawScope = url.searchParams.get("scope");
      const scope = rawScope === null ? undefined : rawScope.toUpperCase();
      if (scope !== undefined && !SCOPES.includes(scope)) return json({ error: `bad scope '${rawScope}'` }, 400);
      try {
        const r = useLlm
          ? await expandQuerySmart(q, { max, useLlm: true, scope })
          : expandQuery(q, { max, scope });
        return json({ ...r, llmAvailable: llmAvailable() });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // --- CV-derived keywords ------------------------------------------------
    if (p === "/api/cv/keywords" && req.method === "GET") {
      const force = url.searchParams.get("force") === "1";
      try {
        return json(cvKeywordsCached({ limit: 12, force }));
      } catch (e) {
        return json({ error: String(e), keywords: [], empty: true }, 500);
      }
    }

    // --- Ad-hoc scrape ------------------------------------------------------
    // Runs the configured portals against USER-SUPPLIED queries instead of the
    // config.json ones. config.json is never modified; the override lives only
    // for the spawned process, so the 09:00 scheduled run is unaffected.
    if (p === "/api/scrape/adhoc" && req.method === "POST") {
      const jobage = url.searchParams.get("jobage") ?? "7";
      if (!/^\d{1,2}$/.test(jobage)) return json({ error: "bad jobage" }, 400);
      const scope = (url.searchParams.get("scope") ?? "ALL").toUpperCase();
      if (!SCOPES.includes(scope)) return json({ error: `bad scope '${scope}'` }, 400);

      let body: any = {};
      try {
        body = await req.json();
      } catch {
        return json({ error: "expected JSON body" }, 400);
      }

      const expand = body?.expand !== false; // default on
      const useLlm = body?.llm === true;

      // Sanitise hard: these strings become CLI arguments to the scraper and,
      // from there, to every portal CLI, so anything outside a job-title
      // charset is dropped rather than escaped (sanitizeQuery). A list over
      // MAX_ADHOC_QUERIES is refused with a message, never quietly shortened.
      const list = adhocQueryList(body?.queries);
      if (list.error) return json({ error: list.error }, 400);
      const clean = list.queries;

      let finalQueries = clean;
      let dropped: string[] = [];
      if (expand) {
        const out: string[] = [];
        const seen = new Set<string>();
        for (const q of clean) {
          const r = useLlm
            ? await expandQuerySmart(q, { useLlm: true, scope })
            : expandQuery(q, { scope });
          for (const t of r.all) {
            if (seen.has(t)) continue;
            seen.add(t);
            out.push(t);
          }
        }
        // Same limit as a caller-supplied list: every term is a full sweep of
        // every enabled portal in every configured location. The server chose
        // these expansions, so it cannot ask which to leave out; the overflow
        // is returned as `dropped` instead of disappearing.
        finalQueries = out.slice(0, MAX_ADHOC_QUERIES);
        dropped = out.slice(MAX_ADHOC_QUERIES);
      }

      const started = startScrape(jobage, scope, [
        "--queries",
        finalQueries.join(","),
      ]);
      return json(
        { started, queries: finalQueries, dropped, state: scrapeState },
        started ? 202 : 409,
      );
    }

    if (p === "/" || p === "/index.html") return serveFile(join(HERE, "index.html"));

    // Static files, confined to the dashboard directory.
    const target = resolve(HERE, "." + p);
    if (!target.startsWith(HERE)) return new Response("forbidden", { status: 403 });
    return serveFile(target);
  },
});

{
  // Apply once at boot, then hourly, so an application goes stale on schedule
  // even if the dashboard is never opened that day.
  const states = readStates();
  const n = sweepStale(states);
  if (n > 0) {
    writeStates(states);
    console.log(`Auto-ignored ${n} application(s) with no update in ${IGNORE_AFTER_DAYS} days`);
  }
  setInterval(() => {
    const s2 = readStates();
    if (sweepStale(s2) > 0) writeStates(s2);
  }, 60 * 60 * 1000).unref?.();
}

console.log(`Job Radar → http://127.0.0.1:${PORT}  (local only)`);
