/**
 * Which languages a job posting requires — besides English.
 *
 * Adverts routinely demand a language the candidate may not have: "sehr gute
 * Deutschkenntnisse", "biegła znajomość języka polskiego", "vloeiend
 * Nederlands", or a title such as "Network Engineer with German". Others never
 * say it but are written entirely in German. The scraper tags every job with
 * those languages and the dashboard's "Language req." menu hides the ones you
 * cannot work in.
 *
 * A language counts as required when
 *   - the TITLE names it ("Network Engineer with German"),
 *   - a sentence names it next to a requirement marker ("fluent", "erforderlich",
 *     "wymagana"…) or a CEFR level ("German C1") — unless a nice-to-have marker
 *     ("is a plus", "von Vorteil", "mile widziana") sits closer to it,
 *   - it is a knowledge compound such as "Deutschkenntnisse" that is not marked
 *     optional, or
 *   - the description itself is written in it (German, Polish, Dutch, French),
 *     unless the posting says that language is optional.
 *
 * English is never tagged: virtually every posting asks for it.
 */

/**
 * Surface forms per language: the English name, the endonym, and the forms job
 * ads actually use. Matched as whole words, so "german" does not fire on
 * "germany" and "deutsch" not on "Deutschland" or "Deutsche Telekom".
 */
export const LANGUAGE_FORMS: Record<string, string[]> = {
  german: ["german", "deutsch", "deutschkenntnisse", "deutschkenntnissen", "deutschsprachig",
           "deutschsprachige", "deutschsprachigen", "deutsche sprache", "deutschen sprache",
           "niemiecki", "niemieckiego", "niemieckim", "duits", "duitse", "allemand"],
  dutch: ["dutch", "nederlands", "nederlandstalig", "nederlandstalige", "niederländisch",
          "niederlandisch", "niederländischkenntnisse", "holenderski", "holenderskiego",
          "néerlandais", "nederlandse"],
  french: ["french", "français", "francais", "französisch", "franzosisch",
           "französischkenntnisse", "francuski", "francuskiego", "frans"],
  polish: ["polish", "polski", "polskiego", "polskim", "polsku", "polnisch",
           "polnischkenntnisse", "pools"],
  spanish: ["spanish", "español", "espanol", "spanisch", "hiszpański", "hiszpanskiego", "spaans"],
  italian: ["italian", "italiano", "italienisch", "włoski", "wloskiego", "italiaans"],
  swedish: ["swedish", "svenska", "schwedisch", "szwedzki", "zweeds"],
  norwegian: ["norwegian", "norsk", "norwegisch", "norweski", "noors"],
  danish: ["danish", "dansk", "dänisch", "danisch", "duński", "deens"],
  finnish: ["finnish", "suomi", "finnisch", "fiński", "fins"],
  czech: ["czech", "čeština", "cestina", "tschechisch", "czeski", "tsjechisch"],
  portuguese: ["portuguese", "português", "portugues", "portugiesisch", "portugalski", "portugees"],
  albanian: ["albanian", "shqip", "albanisch", "albański"],
};

export const LANGUAGE_LABELS: Record<string, string> = {
  german: "German", dutch: "Dutch", french: "French", polish: "Polish", spanish: "Spanish",
  italian: "Italian", swedish: "Swedish", norwegian: "Norwegian", danish: "Danish",
  finnish: "Finnish", czech: "Czech", portuguese: "Portuguese", albanian: "Albanian",
};

/** Forms that are a requirement on their own ("Deutschkenntnisse") unless marked optional. */
const IMPLICIT_REQUIRED = new Set([
  "deutschkenntnisse", "deutschkenntnissen", "deutschsprachig", "deutschsprachige",
  "deutschsprachigen", "polnischkenntnisse", "niederländischkenntnisse",
  "französischkenntnisse", "nederlandstalig", "nederlandstalige",
]);

/**
 * Knowledge nouns: "znajomość języka niemieckiego", "Kenntnisse der deutschen
 * Sprache", "knowledge of German". Listed under requirements they mean a
 * requirement, but they are not a requirement marker of their own: any
 * nice-to-have marker in the same clause ("mile widziana znajomość") wins.
 */
const IMPLICIT_MARKERS = ["znajomość", "znajomosc", "kenntnisse", "knowledge of", "kennis van", "beherrschung"];

/**
 * Nouns after which a language name is a nationality, not a language: "German
 * market experience required" is not a German requirement.
 */
const NOT_A_LANGUAGE_AFTER = new Set([
  "market", "markets", "customer", "customers", "client", "clients", "company", "companies",
  "law", "laws", "office", "offices", "entity", "entities", "subsidiary", "headquarters",
  "government", "authorities", "citizen", "citizens", "citizenship", "residence", "residency",
  "branch", "operations", "rynek", "rynku", "rynkiem", "oddział", "oddziale", "klient",
  "klienta", "klienci", "klientów", "firma", "firmy", "firmie",
]);

/**
 * Function words that identify the language a description is written in.
 * Words two of these languages share ("in", "is", "de", "du") are left out.
 */
const STOPWORDS: Record<string, Set<string>> = {
  english: new Set(["the", "and", "with", "for", "you", "we", "are", "our", "to", "of", "will",
    "your", "be", "this", "that", "on", "as", "or", "have", "an", "by", "from"]),
  german: new Set(["und", "der", "die", "das", "mit", "für", "wir", "sie", "ihre", "ist", "sind",
    "auf", "bei", "von", "zu", "den", "dem", "des", "ein", "eine", "einen", "oder", "sowie",
    "nicht", "auch", "im", "zur", "zum", "über", "unser", "unsere", "werden", "haben", "dich",
    "dein", "deine", "ihr", "ihnen", "aufgaben"]),
  polish: new Set(["oraz", "się", "jest", "dla", "nie", "że", "przez", "jako", "lub", "są",
    "będzie", "twoje", "zadania", "wymagania", "oferujemy", "w", "z", "na", "i", "od", "po",
    "ze", "doświadczenie", "pracy"]),
  dutch: new Set(["het", "een", "en", "van", "voor", "met", "op", "je", "wij", "zijn", "niet",
    "ook", "bij", "naar", "jouw", "onze", "wordt", "heb", "hebt", "jij", "ons", "deze"]),
  french: new Set(["le", "la", "les", "des", "et", "pour", "avec", "une", "est", "sont", "vous",
    "nous", "dans", "sur", "au", "aux", "votre", "vos"]),
};

const CEFR_RE = /(?<![\p{L}\d])[abc][12](?![\p{L}\d])/iu;
/**
 * Clause boundaries. Commas count: in "bardzo dobra znajomość języka
 * niemieckiego, mile widziany angielski" the nice-to-have is about English.
 */
const SENTENCE_END = /[.;!?\n•|,]/;

export type LanguageHow = "title" | "required" | "level" | "posting";

export interface LanguageReq {
  /** Key of LANGUAGE_FORMS, e.g. "german". */
  lang: string;
  /** Why it counts as required. */
  how: LanguageHow;
  /** The title or sentence that says so (max 160 chars). */
  evidence: string;
}

export interface LanguageRules {
  /** Nice-to-have markers ("is a plus", "von vorteil"). Lower-case. */
  optionalMarkers?: string[];
  /** Requirement markers ("fluent", "erforderlich", "wymagana"). Lower-case. */
  requiredMarkers?: string[];
  /** Tag the language the description is written in. Default true. */
  postingLanguage?: boolean;
}

const formRes = new Map<string, RegExp>();
/** Global whole-word regex for a form; "word" means letters, so accents never split a word. */
function formRe(form: string): RegExp {
  let re = formRes.get(form);
  if (!re) {
    const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`(?<![\\p{L}])${esc}(?![\\p{L}])`, "giu");
    formRes.set(form, re);
  }
  re.lastIndex = 0;
  return re;
}

function mentions(text: string, form: string): boolean {
  const re = formRe(form);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!NOT_A_LANGUAGE_AFTER.has(nextWord(text, m.index + m[0].length))) return true;
  }
  return false;
}

/** The sentence (or bullet) around text[idx, idx+len), and where the term starts in it. */
function sentenceAround(text: string, idx: number, len: number) {
  // 120 characters either side: scraped descriptions often lose their line
  // breaks, and a requirement list then reads as one endless "sentence".
  const before = text.slice(Math.max(0, idx - 120), idx);
  const after = text.slice(idx + len, Math.min(text.length, idx + len + 120));
  let cut = -1;
  for (let i = before.length - 1; i >= 0; i--) {
    if (SENTENCE_END.test(before[i])) {
      cut = i;
      break;
    }
  }
  const end = after.search(SENTENCE_END);
  const head = before.slice(cut + 1);
  return {
    win: head + text.slice(idx, idx + len) + (end >= 0 ? after.slice(0, end) : after),
    termAt: head.length,
  };
}

/** Occurrences of `marker` in `win` as [start, end) spans. */
function spans(win: string, marker: string): [number, number][] {
  const out: [number, number][] = [];
  for (let at = win.indexOf(marker); at >= 0; at = win.indexOf(marker, at + 1)) {
    out.push([at, at + marker.length]);
  }
  return out;
}

/**
 * Distance from the language term to the closest optional and the closest
 * required marker in its sentence. A required marker inside an optional one
 * ("muss" in "kein muss", "required" in "not required") does not count.
 */
function markerDistances(win: string, termAt: number, optional: string[], required: string[]) {
  const opt = optional.flatMap((m) => spans(win, m));
  const dist = ([s]: [number, number]) => Math.abs(s - termAt);
  const optDist = Math.min(Infinity, ...opt.map(dist));
  const req = required
    .flatMap((m) => spans(win, m))
    .filter(([s, e]) => !opt.some(([os, oe]) => s >= os && e <= oe));
  const reqDist = Math.min(Infinity, ...req.map(dist));
  return { optDist, reqDist };
}

/** The word right after position `end` in `text`. */
function nextWord(text: string, end: number): string {
  const m = /^[^\p{L}]{0,3}(\p{L}+)/u.exec(text.slice(end, end + 40));
  return m ? m[1] : "";
}

/** The language a description is written in, or null when English or too short to tell. */
export function postingLanguage(description: string): string | null {
  const words = description.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < 40) return null;
  const count: Record<string, number> = {};
  for (const lang of Object.keys(STOPWORDS)) count[lang] = 0;
  for (const w of words) {
    for (const [lang, set] of Object.entries(STOPWORDS)) if (set.has(w)) count[lang]++;
  }
  let best = "";
  for (const lang of Object.keys(STOPWORDS)) {
    if (lang !== "english" && (!best || count[lang] > count[best])) best = lang;
  }
  const enough = count[best] >= Math.max(8, 0.08 * words.length);
  return enough && count[best] > 1.2 * count.english ? best : null;
}

/** First 160 characters of a title, trimmed. */
const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 160);

/** Up to 160 characters of a sentence, centred on the language term so the evidence always shows it. */
const around = (win: string, termAt: number) => {
  const start = Math.max(0, termAt - 70);
  return (start > 0 ? "…" : "") + clip(win.slice(start, start + 160)) + (start + 160 < win.length ? "…" : "");
};

/**
 * The non-English languages a posting requires, one entry per language,
 * strongest reason first: title, explicit level, explicit requirement, then
 * the language the description is written in.
 */
export function languageRequirements(
  input: { title?: string; description?: string; tags?: string[] },
  rules: LanguageRules = {},
): LanguageReq[] {
  const titleRaw = input.title ?? "";
  const title = titleRaw.toLowerCase();
  const descRaw = [input.description ?? "", (input.tags ?? []).join(" ")].join(" ");
  const body = descRaw.toLowerCase();
  const optional = (rules.optionalMarkers ?? []).map((m) => m.toLowerCase());
  const required = (rules.requiredMarkers ?? []).map((m) => m.toLowerCase());

  const found = new Map<string, LanguageReq>();
  const optionalFor = new Set<string>();

  for (const [lang, forms] of Object.entries(LANGUAGE_FORMS)) {
    // "polish" is also a verb ("polish the UI"); only the capitalised word names the language.
    const usable = forms.filter((f) => f !== "polish" || /(?<![\p{L}])Polish(?![\p{L}])/u.test(titleRaw + " " + descRaw));

    if (usable.some((f) => mentions(title, f))) {
      found.set(lang, { lang, how: "title", evidence: clip(titleRaw) });
      continue;
    }

    scan: for (const form of usable) {
      const re = formRe(form);
      for (let m = re.exec(body); m; m = re.exec(body)) {
        const end = m.index + m[0].length;
        if (NOT_A_LANGUAGE_AFTER.has(nextWord(body, end))) continue;
        const { win, termAt } = sentenceAround(body, m.index, m[0].length);
        const { optDist, reqDist } = markerDistances(win, termAt, optional, required);
        if (optDist < reqDist) {
          optionalFor.add(lang);
          continue;
        }
        if (CEFR_RE.test(win)) {
          found.set(lang, { lang, how: "level", evidence: around(win, termAt) });
          break scan;
        }
        if (reqDist < Infinity || IMPLICIT_REQUIRED.has(form) || IMPLICIT_MARKERS.some((k) => win.includes(k))) {
          found.set(lang, { lang, how: "required", evidence: around(win, termAt) });
          break scan;
        }
      }
    }
  }

  if (rules.postingLanguage !== false) {
    const lang = postingLanguage(input.description ?? "");
    if (lang && !found.has(lang) && !optionalFor.has(lang)) {
      found.set(lang, { lang, how: "posting", evidence: `The posting is written in ${LANGUAGE_LABELS[lang]}.` });
    }
  }

  const order: LanguageHow[] = ["title", "level", "required", "posting"];
  return [...found.values()].sort((a, b) => order.indexOf(a.how) - order.indexOf(b.how));
}
