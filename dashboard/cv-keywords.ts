/**
 * Derive job-search keywords from the CV stored by the dashboard.
 *
 * Dependency-free by necessity: this project has no package.json and no
 * node_modules, so the PDF is parsed here rather than with pdf-parse/unpdf.
 * Only text-based PDFs are supported — a scanned/image CV yields no text and
 * the caller degrades to an empty keyword list.
 *
 * Results are cached to data/cv-keywords.json keyed by the stored filename, so
 * a CV is parsed once per upload rather than on every scrape.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync, inflateRawSync } from "node:zlib";
import { join } from "node:path";
import { normalize, loadMap } from "./keyword-expand.ts";

const HERE = import.meta.dir;
const CVDIR = join(HERE, "data", "cv");
const CACHE = join(HERE, "data", "cv-keywords.json");

export interface CvKeyword {
  term: string;
  /** Higher is a better match for the CV. Drives ordering and the UI badge. */
  score: number;
  reason: string;
  source: "title" | "role+tech" | "family";
}

export interface CvKeywordResult {
  cvFile: string | null;
  extractedChars: number;
  keywords: CvKeyword[];
  /** True when the PDF yielded no usable text (scanned/image CV, or encrypted). */
  empty: boolean;
}

// ---------------------------------------------------------------------------
// Minimal PDF text extraction
// ---------------------------------------------------------------------------

/** Decode one PDF stream body, trying zlib then raw-deflate, else plain bytes. */
function decodeStream(body: Buffer): string {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      return fn(body).toString("latin1");
    } catch {
      /* not this encoding — fall through */
    }
  }
  return body.toString("latin1");
}

/** Unescape a PDF literal string: \( \) \\ \n and \ddd octal. */
function unescapePdf(s: string): string {
  return s
    .replace(/\\([nrtbf])/g, (_, c) =>
      ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c as string] ?? c,
    )
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, "$1");
}

/**
 * Parse every /ToUnicode CMap in the document into one code -> text map.
 *
 * Modern PDFs (this CV included) embed subset fonts with Identity-H encoding,
 * so a shown string is a run of 2-byte GLYPH IDS, not characters: "Curriculum"
 * appears as <00260058005500550...>. The CMap is the only thing that maps those
 * back to Unicode.
 *
 * Maps from all fonts are merged. A collision would need two subset fonts that
 * assign different characters to the same glyph id; for a CV (one family,
 * regular + bold) the orderings agree, and first-wins keeps it stable.
 */
function parseCMaps(streams: string[]): Map<number, string> {
  const cmap = new Map<number, string>();
  const hexToStr = (h: string) => {
    let s = "";
    for (let i = 0; i + 3 < h.length + 1; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (!Number.isNaN(code)) s += String.fromCharCode(code);
    }
    return s;
  };

  for (const content of streams) {
    if (!/beginbfchar|beginbfrange/.test(content)) continue;

    // <src> <dst>
    for (const block of content.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const src = parseInt(p[1], 16);
        if (!cmap.has(src)) cmap.set(src, hexToStr(p[2]));
      }
    }

    // <lo> <hi> <dstStart>   and   <lo> <hi> [<d1> <d2> ...]
    for (const block of content.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      const body = block[1];
      for (const p of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(p[1], 16);
        const hi = parseInt(p[2], 16);
        const dst = parseInt(p[3], 16);
        if (hi - lo > 0xffff) continue;
        for (let i = 0; lo + i <= hi; i++) {
          if (!cmap.has(lo + i)) cmap.set(lo + i, String.fromCharCode(dst + i));
        }
      }
      for (const p of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
        const lo = parseInt(p[1], 16);
        const items = Array.from(p[3].matchAll(/<([0-9A-Fa-f]+)>/g)).map((x) => hexToStr(x[1]));
        items.forEach((v, i) => {
          if (!cmap.has(lo + i)) cmap.set(lo + i, v);
        });
      }
    }
  }
  return cmap;
}

/**
 * One font resource as far as text extraction cares: how many bytes make a
 * character code, and the font's OWN ToUnicode map.
 */
interface PdfFont {
  twoByte: boolean;
  cmap: Map<number, string>;
}

/** Decode a shown string's raw bytes (latin1 chars) through a specific font. */
function decodeWithFont(bytes: string, font: PdfFont): string {
  let s = "";
  if (font.twoByte) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      s += font.cmap.get(code) ?? "";
    }
    return s;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    s += font.cmap.get(code) ?? bytes[i];
  }
  return s;
}

function hexToBytes(hex: string): string {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2).padEnd(2, "0"), 16));
  return s;
}

/** Decode a hex-string operand through the CMap (2-byte codes). */
function decodeHex(hex: string, cmap: Map<number, string>): string {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  if (cmap.size) {
    for (let i = 0; i + 3 < h.length + 1; i += 4) {
      const code = parseInt(h.slice(i, i + 4), 16);
      if (Number.isNaN(code)) continue;
      s += cmap.get(code) ?? "";
    }
    if (s.trim()) return s;
  }
  // No CMap (or it produced nothing): treat as raw single bytes.
  for (let i = 0; i + 1 < h.length; i += 2) s += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return s;
}

/**
 * Pull visible text out of a PDF content stream, reconstructing LINES.
 *
 * Line reconstruction matters more than it looks: a PDF emits one TJ per styled
 * run, so "Senior Network Engineer" can arrive as three separate runs. Treating
 * each run as its own line destroys the word adjacency that title mining
 * depends on. Instead the text-positioning operators (Tm/Td/TD/T*) are tracked
 * and a newline is emitted only when the Y coordinate actually moves.
 */
function textFromContent(
  content: string,
  cmap: Map<number, string>,
  fonts?: Map<string, PdfFont>,
): string {
  const out: string[] = [];
  let line = "";
  let lastY: number | null = null;
  // Font currently selected by Tf. Without per-font data (fallback path) this
  // stays undefined and the merged CMap is used, as before.
  let font: PdfFont | undefined;

  // Literal strings arrive already unescaped to raw bytes; hex strings as hex.
  const showLiteral = (raw: string) =>
    font ? decodeWithFont(unescapePdf(raw), font) : unescapePdf(raw);
  const showHex = (hex: string) => (font ? decodeWithFont(hexToBytes(hex), font) : decodeHex(hex, cmap));

  const N = "-?[\\d.]+";
  const token = new RegExp(
    [
      `\\[((?:[^\\]\\\\]|\\\\.)*)\\]\\s*TJ`, // 1 array show
      `\\(((?:[^()\\\\]|\\\\.)*)\\)\\s*Tj`, // 2 literal show
      `<([0-9A-Fa-f\\s]+)>\\s*Tj`, // 3 hex show
      `${N}\\s+${N}\\s+${N}\\s+${N}\\s+(${N})\\s+(${N})\\s+Tm`, // 4,5 matrix
      `(${N})\\s+(${N})\\s+T[dD]`, // 6,7 offset
      `(T\\*)`, // 8 next line
      `\\/([^\\s/\\[\\]()<>]+)\\s+${N}\\s+Tf`, // 9 font select
    ].join("|"),
    "g",
  );

  const breakLine = () => {
    if (line.trim()) out.push(line.trim());
    line = "";
  };

  for (const m of content.matchAll(token)) {
    if (m[1] !== undefined) {
      for (const tok of m[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>|(-?[\d.]+)/g)) {
        if (tok[1] !== undefined) line += showLiteral(tok[1]);
        else if (tok[2] !== undefined) line += showHex(tok[2]);
        // A kern below -100 is a real word gap; smaller values are letter spacing.
        else if (tok[3] !== undefined && parseFloat(tok[3]) <= -100) line += " ";
      }
    } else if (m[2] !== undefined) {
      line += showLiteral(m[2]);
    } else if (m[3] !== undefined) {
      line += showHex(m[3]);
    } else if (m[9] !== undefined) {
      if (fonts) font = fonts.get(m[9]);
    } else if (m[5] !== undefined) {
      const y = parseFloat(m[5]);
      if (lastY !== null && Math.abs(y - lastY) > 1.5) breakLine();
      lastY = y;
    } else if (m[7] !== undefined) {
      const dy = parseFloat(m[7]);
      if (Math.abs(dy) > 1.5) breakLine();
    } else if (m[8] !== undefined) {
      breakLine();
    }
  }
  breakLine();

  return out.join("\n");
}

/** Extract all text from a PDF file. Returns "" if nothing is recoverable. */
export function pdfText(path: string): string {
  const buf = readFileSync(path);
  const latin = buf.toString("latin1");
  const tidy = (s: string) =>
    s
      .replace(/\u0000/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const perFont = pdfTextPerFont(buf, latin);
  if (perFont.trim()) return tidy(perFont);

  // Fallback for PDFs whose page/font dictionaries this reader cannot walk
  // (e.g. packed into compressed object streams): decode every stream and use
  // one merged CMap. Lossy when fonts disagree, but better than nothing.
  //
  // The lookbehind is essential: a plain /stream/ regex also matches inside
  // "endstream" and desynchronises the whole scan.
  const decoded: string[] = [];
  const re = /(?<![a-zA-Z])stream(\r\n|\r|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin))) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    decoded.push(decodeStream(buf.subarray(start, end)));
  }

  const cmap = parseCMaps(decoded);
  const chunks = decoded
    .filter((d) => /\bTJ\b|\bTj\b/.test(d))
    .map((d) => textFromContent(d, cmap));

  return tidy(chunks.join("\n"));
}

/**
 * Page-aware extraction: every text run is decoded through the font that was
 * actually selected (Tf) when it was drawn.
 *
 * This is not optional polish. Word-exported CVs embed several subset fonts
 * (regular, bold, italic, symbol) and each subset numbers its glyphs from
 * scratch, so glyph 0x2E is "K" in one font and "u" in another. Merging all
 * CMaps into one table turned "Nexus 3K-9K" into "3u-9u" and "WORK" into
 * "WORu", and the single-glyph WinAnsi space fonts Word emits between words
 * came out as a stray "Ù" glued to the next word — which silently broke title
 * mining ("Senior ÙNetwork ÙEngineer" is not "senior network engineer").
 */
function pdfTextPerFont(buf: Buffer, latin: string): string {
  // Index every indirect object: its dictionary text and, if any, its stream.
  const objs = new Map<number, { dict: string; stream?: string }>();
  for (const m of latin.matchAll(/(?<![\d])(\d+)\s+\d+\s+obj\b/g)) {
    const start = m.index! + m[0].length;
    const end = latin.indexOf("endobj", start);
    if (end < 0) continue;
    const kw = /(?<![a-zA-Z])stream(\r\n|\r|\n)/g;
    kw.lastIndex = start;
    const sm = kw.exec(latin);
    if (sm && sm.index < end) {
      const bodyStart = sm.index + sm[0].length;
      const bodyEnd = latin.indexOf("endstream", bodyStart);
      const dict = latin.slice(start, sm.index);
      const stream = bodyEnd > 0 ? decodeStream(buf.subarray(bodyStart, bodyEnd)) : undefined;
      objs.set(Number(m[1]), { dict, stream });
    } else {
      objs.set(Number(m[1]), { dict: latin.slice(start, end) });
    }
  }

  const refs = (s: string) => Array.from(s.matchAll(/(\d+)\s+\d+\s+R/g), (r) => Number(r[1]));

  const fontCache = new Map<number, PdfFont>();
  const loadFont = (num: number): PdfFont => {
    const hit = fontCache.get(num);
    if (hit) return hit;
    const dict = objs.get(num)?.dict ?? "";
    const tu = dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    const cmapStream = tu ? objs.get(Number(tu[1]))?.stream : undefined;
    const font: PdfFont = {
      twoByte: /\/Subtype\s*\/Type0/.test(dict),
      cmap: cmapStream ? parseCMaps([cmapStream]) : new Map(),
    };
    fontCache.set(num, font);
    return font;
  };

  /** Resolve a page's /Font resource dictionary to name -> font. */
  const pageFonts = (pageDict: string): Map<string, PdfFont> => {
    let res = pageDict;
    const resRef = pageDict.match(/\/Resources\s+(\d+)\s+\d+\s+R/);
    if (resRef) res = objs.get(Number(resRef[1]))?.dict ?? "";
    let fontDict = res.match(/\/Font\s*<<([^>]*)>>/)?.[1];
    const fontRef = res.match(/\/Font\s+(\d+)\s+\d+\s+R/);
    if (fontDict === undefined && fontRef) fontDict = objs.get(Number(fontRef[1]))?.dict;
    const out = new Map<string, PdfFont>();
    for (const f of (fontDict ?? "").matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      out.set(f[1], loadFont(Number(f[2])));
    }
    return out;
  };

  const pages = Array.from(objs.entries())
    .filter(([, o]) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.dict))
    .sort((a, b) => a[0] - b[0]);

  const empty = new Map<number, string>();
  const chunks: string[] = [];
  for (const [, page] of pages) {
    const fonts = pageFonts(page.dict);
    const contents = page.dict.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/)?.[1] ?? "";
    for (const num of refs(contents)) {
      const stream = objs.get(num)?.stream;
      if (stream && /\bTJ\b|\bTj\b/.test(stream)) chunks.push(textFromContent(stream, empty, fonts));
    }
  }
  return chunks.join("\n");
}

/** Read whatever CV is on file, whatever its format. */
export function readCvText(): { file: string | null; text: string } {
  const cur = join(CVDIR, "current.json");
  if (!existsSync(cur)) return { file: null, text: "" };
  let stored = "";
  try {
    stored = JSON.parse(readFileSync(cur, "utf8"))?.storedAs ?? "";
  } catch {
    return { file: null, text: "" };
  }
  const path = join(CVDIR, stored);
  if (!stored || !existsSync(path)) return { file: null, text: "" };

  if (/\.pdf$/i.test(stored)) return { file: stored, text: pdfText(path) };
  if (/\.(txt|md|rtf)$/i.test(stored)) return { file: stored, text: readFileSync(path, "utf8") };
  // .doc/.docx/.odt are zip/binary containers; not worth a hand-rolled reader.
  return { file: stored, text: "" };
}

// ---------------------------------------------------------------------------
// Keyword mining
// ---------------------------------------------------------------------------

/** Role nouns that make a phrase a plausible job title. */
const ROLE_NOUNS = [
  "engineer", "architect", "consultant", "specialist", "administrator",
  "developer", "analyst", "manager", "lead", "technician",
];

/** Words that must never start a mined title (CV prose artefacts). */
const STOP_STARTS = new Set([
  "and", "the", "for", "with", "of", "in", "on", "at", "to", "a", "an",
  "senior", "junior", "lead", "principal", "as", "by", "from",
]);

/**
 * Phrases that look like titles but are credentials, employers or CV furniture.
 * "cisco certified specialist" ends in a role noun and repeats several times, so
 * without this it outranks real titles.
 */
const NOT_A_TITLE = [
  /\bcertified\b/,
  /\bcertificate?s?\b/,
  /\bccie\b|\bccnp\b|\bccna\b|\bccdev\b/,
  /\bdiploma\b|\bdegree\b|\bbachelor\b|\bmaster\b/,
  /\buniversity\b|\binstitute\b|\bhigh school\b/,
  /\blanguages?\b|\bnative\b|\bproficient\b/,
];

/**
 * Mine plausible job titles out of raw CV text: an N-gram ending in a role noun.
 * Exported for scrape-daily.ts, whose title gate reads the CV's own titles.
 */
export function mineTitles(text: string): Map<string, number> {
  const found = new Map<string, number>();
  const lines = text.split(/[\n•\u2022|;]+/);

  for (const raw of lines) {
    // Trailing abbreviation dots ("Infra.") would otherwise survive into the
    // query string and match nothing.
    const line = normalize(raw).replace(/\.(?=\s|$)/g, "");
    if (!line || line.length > 120) continue;
    const words = line.split(" ").filter(Boolean);

    for (let i = 0; i < words.length; i++) {
      if (!ROLE_NOUNS.includes(words[i])) continue;
      // Take up to 4 words of context before the role noun. Real CV titles run
      // long ("solution validation services consulting engineer"), and stopping
      // at 3 clipped them into generic stubs.
      for (let n = 1; n <= 4; n++) {
        const start = i - n;
        if (start < 0) break;
        if (STOP_STARTS.has(words[start])) continue;
        const phrase = words.slice(start, i + 1).join(" ");
        if (phrase.length < 6 || /\d/.test(phrase)) continue;
        if (NOT_A_TITLE.some((re) => re.test(phrase))) continue;
        found.set(phrase, (found.get(phrase) ?? 0) + 1);
      }
    }
  }

  // Collapse truncations. Mining every 1..4-word window before a role noun
  // emits the same title several times at different lengths — "solution
  // validation services consulting engineer" also yields "validation services
  // consulting engineer" and "services consulting engineer". They are the same
  // vacancy phrased shorter, and because they share a score band they crowd the
  // genuinely different candidates out of the final list.
  //
  // A phrase is dropped when a LONGER mined phrase ends with it and was seen the
  // same number of times, i.e. every occurrence of the short form was really an
  // occurrence of the long one. Differing counts mean the short form also stands
  // on its own somewhere in the CV, so it is kept.
  for (const [phrase, count] of Array.from(found)) {
    for (const [other, otherCount] of found) {
      if (other === phrase) continue;
      if (otherCount !== count) continue;
      if (other.endsWith(" " + phrase)) {
        found.delete(phrase);
        break;
      }
    }
  }

  return found;
}

/**
 * Technology tokens that employers actually put in a job TITLE, best first.
 * "cisco network engineer" is a real posting; "vxlan network engineer" is not —
 * VXLAN belongs in the description, so pairing on it wastes a query.
 */
const TECH_PRIORITY = [
  "cisco", "aci", "data center", "nexus", "ucs", "python",
  "ansible", "terraform", "nx-os", "firepower", "bgp",
];

/** Technology tokens from the curated map that actually appear in the CV. */
function mineTech(text: string): string[] {
  const map = loadMap();
  const hay = normalize(text);
  const hits: string[] = [];
  for (const token of Object.keys(map._vendorHints ?? {})) {
    if (hay.includes(normalize(token))) hits.push(token);
  }
  const rank = (t: string) => {
    const i = TECH_PRIORITY.indexOf(t);
    return i < 0 ? TECH_PRIORITY.length : i;
  };
  return hits.sort((a, b) => rank(a) - rank(b));
}

/**
 * Produce ranked search keywords for the CV on file.
 *
 * Scoring favours phrases that are both (a) frequent in the CV and (b) a known
 * role family, so "network engineer" outranks a one-off phrase like
 * "onsite assessment engineer".
 */
export function cvKeywords(opts: { limit?: number } = {}): CvKeywordResult {
  const { file, text } = readCvText();
  if (!text.trim()) {
    return { cvFile: file, extractedChars: 0, keywords: [], empty: true };
  }
  const keywords = keywordsFromText(text, opts.limit ?? 12);
  return { cvFile: file, extractedChars: text.length, keywords, empty: keywords.length === 0 };
}

/**
 * The selection behind cvKeywords(), on raw CV text.
 *
 * Every keyword returned is appended to EVERY scrape and costs one call per
 * portal per location (about 20 per keyword), so the list is kept to queries
 * that can find something the others do not. `limit` is a ceiling, not a
 * target: padding it with near-duplicates was the bulk of a run's requests.
 */
export function keywordsFromText(text: string, limit = 12): CvKeyword[] {
  const map = loadMap();
  const knownTerms = new Set(map.synonyms.flatMap((g) => g.terms.map(normalize)));

  const titles = mineTitles(text);
  const tech = mineTech(text);
  const scored = new Map<string, CvKeyword>();

  const put = (term: string, score: number, reason: string, source: CvKeyword["source"]) => {
    const t = normalize(term);
    if (!t) return;
    const prev = scored.get(t);
    if (!prev || prev.score < score) scored.set(t, { term: t, score, reason, source });
  };

  // A known role family is the searchable form of a role. A mined phrase that
  // is only a fragment of one ("consulting engineer" of "technical consulting
  // engineer") or an over-specific extension of one ("dc aci technical
  // consulting engineer") searches the same postings worse; a one-off phrase
  // that names no family ("it specialist", from an old junior role) mostly
  // finds noise. Neither earns a sweep of every portal.
  const families = [...titles.keys()].filter((p) => knownTerms.has(p));
  for (const [phrase, count] of titles) {
    // Known role families are far more likely to be real, searchable titles
    // than an arbitrary phrase that happens to end in "engineer".
    const known = knownTerms.has(phrase);
    if (!known) {
      if (count < 2) continue;
      if (families.some((f) => f.endsWith(` ${phrase}`) || phrase.endsWith(` ${f}`))) continue;
    }
    const words = phrase.split(" ").length;
    const score = count * 10 + (known ? 40 : 0) + (words >= 2 ? 10 : 0);
    put(phrase, score, known ? `in CV ${count}x, known role family` : `in CV ${count}x`, "title");
  }

  // Pair the strongest BROAD role families (two words) with the CV's
  // technologies: "cisco network engineer" narrows hundreds of "network
  // engineer" postings to the relevant ones. A longer family title is already
  // specific, and prefixing it ("aci technical consulting engineer") only
  // produced near-duplicate sweeps that found nothing new.
  const topFamilies = Array.from(scored.values())
    .filter((k) => knownTerms.has(k.term) && k.term.split(" ").length <= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  for (const fam of topFamilies) {
    tech.slice(0, 6).forEach((t, i) => {
      if (fam.term.includes(normalize(t))) return;
      // Decay by the technology's own priority so "cisco network engineer"
      // outranks "ansible network engineer" instead of the two tying and being
      // separated alphabetically.
      put(`${t} ${fam.term}`, fam.score - 5 - i, `CV skill "${t}" + ${fam.term}`, "role+tech");
    });
  }

  // Diversify before truncating: cap each base title so the list spans
  // different role families instead of one title plus its tech-prefixed clones
  // (base + its single best pairing).
  const MAX_PER_BASE = 2;
  const perBase = new Map<string, number>();
  const baseOf = (k: CvKeyword) =>
    k.source === "role+tech" ? k.term.split(" ").slice(1).join(" ") : k.term;

  const ranked = Array.from(scored.values()).sort(
    (a, b) => b.score - a.score || a.term.localeCompare(b.term),
  );

  const keywords: CvKeyword[] = [];
  for (const k of ranked) {
    const b = baseOf(k);
    const n = perBase.get(b) ?? 0;
    if (n >= MAX_PER_BASE) continue;
    perBase.set(b, n + 1);
    keywords.push(k);
    if (keywords.length >= limit) break;
  }
  return keywords;
}

// ---------------------------------------------------------------------------
// Cache, so the CV is parsed once per upload rather than on every scrape.
// ---------------------------------------------------------------------------

/**
 * Version of the selection logic. A cache written by another version is
 * recomputed, so a change here reaches the next scrape without a re-upload.
 */
const CV_KEYWORDS_ENGINE = 2;

export function cvKeywordsCached(opts: { limit?: number; force?: boolean } = {}): CvKeywordResult {
  const { file } = readCvText();
  if (!opts.force && existsSync(CACHE)) {
    try {
      const c = JSON.parse(readFileSync(CACHE, "utf8"));
      if (c?.cvFile && c.cvFile === file && c.engine === CV_KEYWORDS_ENGINE) return c as CvKeywordResult;
    } catch {
      /* corrupt cache — recompute */
    }
  }
  const res = cvKeywords(opts);
  try {
    writeFileSync(CACHE, JSON.stringify({ ...res, engine: CV_KEYWORDS_ENGINE }, null, 2));
  } catch {
    /* cache is an optimisation only */
  }
  return res;
}

/** Invalidate the cache — call after a new CV upload. */
export function invalidateCvKeywords() {
  try {
    if (existsSync(CACHE)) writeFileSync(CACHE, "{}");
  } catch {
    /* non-fatal */
  }
}
