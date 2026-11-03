/**
 * Tests for Smart Search keyword expansion (keyword-expand.ts).
 *
 * The behaviours these lock down:
 *  - accented queries were mangled ("inżynier sieci" -> "in ynier sieci"),
 *  - typos and plurals got no expansion at all ("netwrok engineer"),
 *  - a recognised title dragged in every family that merely contained it
 *    ("senior network engineer" pulled in the architect family),
 *  - single topics and certifications got nothing ("kubernetes", "ccie"),
 *  - spelling variants could crowd real titles out of the 12-term cap,
 *  - an ad-hoc search silently ran only its first 25 terms, so with expansions
 *    on, every keyword after the second was never searched.
 *
 *   bun test dashboard/keyword-expand.test.ts
 */
import { expect, test, describe } from "bun:test";
import {
  adhocQueryList,
  expandQuery,
  normalize,
  foldDiacritics,
  sanitizeQuery,
  scopeLanguages,
  MAX_ADHOC_QUERIES,
  MAX_EXPANSIONS,
  MAX_TRANSLATIONS_PER_LANG,
  EXPAND_ENGINE,
} from "./keyword-expand.ts";
import SmartFilter from "./smart-filter.js";

const terms = (q: string, opts = {}) => expandQuery(q, opts).terms;
const words = (q: string, opts = {}) => expandQuery(q, opts).all;
const english = (q: string, opts = {}) => terms(q, opts).filter((t) => t.source !== "translation");

describe("normalisation", () => {
  test("folds accents instead of dropping letters", () => {
    expect(normalize("Inżynier Sieci")).toBe("inzynier sieci");
    expect(normalize("GEBHARDT Fördertechnik / Wrocław")).toBe("gebhardt fordertechnik wroclaw");
    expect(foldDiacritics("Łódź Straße Æble")).toBe("Lodz Strasse AEble");
  });

  test("the job-list search box folds exactly the same way", () => {
    for (const s of ["Inżynier sieci", "Kraków", "Netzwerkadministrator (m/w/d)", "Łódź", "Fördertechnik"]) {
      expect(SmartFilter.fold(s)).toBe(foldDiacritics(s).toLowerCase());
    }
  });

  test("sanitizeQuery keeps accented letters and strips shell metacharacters", () => {
    expect(sanitizeQuery("Inżynier sieci")).toBe("Inzynier sieci");
    expect(sanitizeQuery('a & b | c; d, "e" %f% ^g <h>')).toBe("a b c d e f g h");
    expect(sanitizeQuery("c++ / c# .net sd-wan")).toBe("c++ / c# .net sd-wan");
  });
});

describe("typos and plurals", () => {
  test("a misspelled title is corrected and expanded", () => {
    const t = terms("netwrok engineer");
    expect(t[0]).toMatchObject({ term: "netwrok engineer", source: "original" });
    expect(t[1]).toMatchObject({ term: "network engineer", source: "correction" });
    expect(words("netwrok engineer")).toContain("network administrator");
  });

  test("a plural is read as the singular title", () => {
    const t = terms("network engineers");
    expect(t[1]).toMatchObject({ term: "network engineer", source: "correction" });
    expect(t[1].reason).toContain('singular of "engineers"');
  });

  test("words that are already known are never 'corrected'", () => {
    expect(terms("devops").some((t) => t.source === "correction")).toBe(false);
    expect(terms("kubernetes").some((t) => t.source === "correction")).toBe(false);
    expect(terms("systems engineer").some((t) => t.source === "correction")).toBe(false);
  });
});

describe("role families", () => {
  test("a recognised title does not drag in families that merely contain it", () => {
    const all = words("senior network engineer");
    expect(all.some((t) => t.includes("architect"))).toBe(false);
    expect(all.some((t) => t.includes("design engineer"))).toBe(false);
  });

  test("the user's seniority is kept on the family titles", () => {
    const all = words("senior network engineer");
    expect(all[0]).toBe("senior network engineer");
    expect(all).toContain("network engineer"); // the broad catch-all stays
    expect(all).toContain("senior network administrator");
    expect(all).not.toContain("network administrator");
    // A modifier that was a suffix stays a suffix.
    expect(words("network engineer ii")).toContain("network administrator ii");
  });

  test("abbreviations give the query the user meant", () => {
    const all = words("sr network eng");
    expect(all[1]).toBe("senior network engineer");
    expect(words("dc engineer")[1]).toBe("data center engineer");
    expect(words("sre")).toContain("site reliability engineer");
  });

  test("spelling variants map to the canonical title and never outrank real titles", () => {
    expect(words("data centre engineer")[1]).toBe("data center engineer");
    const presales = english("presales");
    const firstSpelling = presales.findIndex((t) => t.source === "spelling");
    const lastSynonym = presales.map((t) => t.source).lastIndexOf("synonym");
    expect(firstSpelling).toBeGreaterThan(lastSynonym);
    expect(presales.map((t) => t.term)).toContain("solutions engineer");
  });

  test("a bare topic becomes a title; certifications do not", () => {
    expect(words("kubernetes")).toContain("kubernetes engineer");
    expect(words("kubernetes")).toContain("platform engineer");
    expect(words("presales")).toContain("presales engineer");
    expect(words("ccie")).not.toContain("ccie engineer");
    expect(words("ccie")).toContain("network engineer");
  });

  test("a role noun alone does not expand into every family", () => {
    expect(words("engineer")).toEqual(["engineer"]);
  });

  test("tech acronyms rank their family above their spelled-out form", () => {
    const all = words("cisco aci");
    expect(all.indexOf("data center engineer")).toBeGreaterThan(0);
    expect(all.indexOf("data center engineer")).toBeLessThan(all.length);
    expect(all.some((t) => t.startsWith("data centre infrastructure"))).toBe(false);
  });
});

describe("native-language titles", () => {
  test("Polish and German queries are recognised", () => {
    const pl = words("inżynier sieci");
    expect(pl[0]).toBe("inzynier sieci");
    expect(pl).toContain("network engineer");
    expect(words("Netzwerkadministrator")).toContain("network administrator");
  });

  test("they follow the scope and do not count against the cap", () => {
    expect(scopeLanguages("PL")).toEqual(["pl"]);
    expect(scopeLanguages("EU")).toEqual([]);
    expect(scopeLanguages("ALL")).toEqual(["pl", "de", "nl"]);

    const de = terms("network engineer", { scope: "DE" }).filter((t) => t.source === "translation");
    expect(de.map((t) => t.lang)).toEqual(["de", "de"]);
    expect(de.map((t) => t.term)).toContain("netzwerkadministrator");
    expect(terms("network engineer", { scope: "EU" }).some((t) => t.source === "translation")).toBe(false);

    const preview = terms("network engineer");
    for (const lang of ["pl", "de", "nl"]) {
      const n = preview.filter((t) => t.lang === lang).length;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(MAX_TRANSLATIONS_PER_LANG);
    }
    expect(english("network engineer").length).toBeLessThanOrEqual(MAX_EXPANSIONS);
  });

  test("translations are ASCII, so they survive the scraper's argument filter", () => {
    for (const t of terms("security engineer")) {
      expect(sanitizeQuery(t.term)).toBe(t.term);
    }
  });
});

describe("result contract", () => {
  test("original first, no duplicates, normalised terms, engine version", () => {
    for (const q of ["Network Architect", "cisco aci", "kubernetes", "inżynier sieci", "sr network eng", "netwrok"]) {
      const r = expandQuery(q);
      expect(r.terms[0].source).toBe("original");
      expect(new Set(r.all).size).toBe(r.all.length);
      for (const t of r.all) expect(t).toBe(normalize(t));
      expect(r.engine).toBe(EXPAND_ENGINE);
      expect(r.all).toEqual(r.terms.map((t) => t.term));
    }
  });

  test("max is honoured for English terms", () => {
    expect(english("network engineer", { max: 5 }).length).toBe(5);
  });

  test("empty input stays empty", () => {
    expect(expandQuery("   ").terms).toEqual([]);
  });
});

describe("ad-hoc search term list", () => {
  // Shaped like the dashboard's payload: many already-expanded terms.
  const many = (n: number) => Array.from({ length: n }, (_, i) => `network engineer ${i + 1}`);

  test("keeps every term up to the limit (the old cap silently kept 25)", () => {
    const r = adhocQueryList(many(60));
    expect(r.error).toBeUndefined();
    expect(r.queries).toHaveLength(60);
    expect(r.queries[59]).toBe("network engineer 60");
    expect(adhocQueryList(many(MAX_ADHOC_QUERIES)).queries).toHaveLength(MAX_ADHOC_QUERIES);
  });

  test("refuses a list over the limit instead of cutting it", () => {
    const r = adhocQueryList(many(MAX_ADHOC_QUERIES + 1));
    expect(r.queries).toEqual([]);
    expect(r.error).toContain(`${MAX_ADHOC_QUERIES + 1} search terms`);
    expect(r.error).toContain(`at most ${MAX_ADHOC_QUERIES}`);
  });

  test("sanitises, drops unusable entries and de-duplicates before counting", () => {
    const r = adhocQueryList(["Inżynier Sieci", "inzynier sieci", "a,b", "", "   ", 42, null, "x".repeat(81), "network architect"]);
    expect(r.queries).toEqual(["Inzynier Sieci", "a b", "network architect"]);
    const twice = [...many(MAX_ADHOC_QUERIES), ...many(MAX_ADHOC_QUERIES)];
    expect(adhocQueryList(twice).queries).toHaveLength(MAX_ADHOC_QUERIES);
  });

  test("nothing usable is an error", () => {
    expect(adhocQueryList([]).error).toBe("no usable queries");
    expect(adhocQueryList("network engineer").error).toBe("no usable queries");
  });
});
