/**
 * Regression tests for the vacancy identity key.
 *
 * The bug: dashboard state was keyed on the canonical URL, which is not stable.
 * Across two consecutive real scrapes, 9 of the 83 postings present in both had
 * a different URL the second time, and 15 postings appeared 2-3 times at once
 * under different boards' links. Either way a deleted job came back.
 *
 *   bun test dashboard/job-identity.test.ts
 */
import { expect, test, describe } from "bun:test";
import { existsSync } from "node:fs";
import { jobIdentity, normalizeIdentityPart } from "./job-identity.ts";

describe("jobIdentity — same vacancy across boards and runs", () => {
  // Real duplicate groups observed in data/jobs.json.
  const sameVacancy: [string, string, string, string][] = [
    ["HTP GmbH", "Network Engineer (m/w/d)", "htp gmbh", "Network Engineer"],
    ["Quality", "Datacenter Network Engineer", "quality", "Datacenter Network Engineer"],
    ["Zscaler", "Sr. Staff Network Engineer", "Zscaler", "Sr Staff Network Engineer"],
    ["ITCARD S.A.", "LAN/WAN Network Engineer", "ITCARD S.A", "LAN / WAN Network Engineer"],
    ["Redcare Pharmacy", "Senior Azure Network Engineer (m/f/d)", "Redcare Pharmacy", "Senior Azure Network Engineer"],
    ["Euroclear", "IT Network Engineer", "euroclear", "IT  Network  Engineer"],
    ["Motorola Solutions", "Network Engineer", "MOTOROLA SOLUTIONS", "Network Engineer"],
  ];
  for (const [c1, t1, c2, t2] of sameVacancy) {
    test(`merges: ${t1} @ ${c1}`, () => {
      expect(jobIdentity(c1, t1)).toBe(jobIdentity(c2, t2));
      expect(jobIdentity(c1, t1)).not.toBe("");
    });
  }

  test("strips the gender markers boards disagree on", () => {
    const base = jobIdentity("ACME", "Network Engineer");
    for (const suffix of ["(m/w/d)", "(m/f/d)", "(k/m)", "(f/m/x)", "(m/w/x)", "(w/m/d)"]) {
      expect(jobIdentity("ACME", `Network Engineer ${suffix}`)).toBe(base);
    }
  });
});

describe("jobIdentity — must NOT merge different vacancies", () => {
  const distinct: [string, string, string, string][] = [
    // Seniority is a real difference — deleting one must not hide the other.
    ["ACME", "Network Engineer", "ACME", "Senior Network Engineer"],
    ["ACME", "Network Engineer", "ACME", "Lead Network Engineer"],
    ["ACME", "Network Engineer", "ACME", "Junior Network Engineer"],
    // Different discipline at the same employer.
    ["ACME", "Network Engineer", "ACME", "Network Architect"],
    ["ACME", "Network Engineer", "ACME", "Network Security Engineer"],
    // Same role at different employers.
    ["ACME", "Network Engineer", "Globex", "Network Engineer"],
    // Real pair from the dataset.
    ["Jeppesen ForeFlight", "iOS Engineer", "Jeppesen ForeFlight", "Senior iOS Engineer"],
  ];
  for (const [c1, t1, c2, t2] of distinct) {
    test(`keeps apart: "${t1}" @ ${c1} vs "${t2}" @ ${c2}`, () => {
      expect(jobIdentity(c1, t1)).not.toBe(jobIdentity(c2, t2));
    });
  }

  test("a lone letter-pair marker is not mistaken for a gender marker", () => {
    // "(AI)" is two letters but not a gender marker; it must survive so that
    // "Network Engineer (AI)" stays distinct from "Network Engineer".
    expect(jobIdentity("ACME", "Network Engineer (AI)"))
      .not.toBe(jobIdentity("ACME", "Network Engineer"));
  });
});

describe("jobIdentity — degenerate input", () => {
  test("returns empty when it cannot identify the posting", () => {
    expect(jobIdentity("", "Network Engineer")).toBe("");
    expect(jobIdentity("ACME", "")).toBe("");
    expect(jobIdentity(null, null)).toBe("");
    expect(jobIdentity(undefined, "x")).toBe("");
    // Punctuation-only normalises away to nothing, which must not become a key
    // that every such posting collides on.
    expect(jobIdentity("—", "***")).toBe("");
  });

  test("normalisation collapses punctuation and case", () => {
    expect(normalizeIdentityPart("  Sr.  Staff—Network/Engineer  ")).toBe("sr staff network engineer");
  });

  test("handles Polish and German letters without mangling them", () => {
    expect(jobIdentity("Firma", "Inżynier Sieci")).toBe("firma|inżynier sieci");
    expect(jobIdentity("Firma", "Netzwerkspezialist")).toBe("firma|netzwerkspezialist");
    // Different words must stay different.
    expect(jobIdentity("F", "Inżynier Sieci")).not.toBe(jobIdentity("F", "Inzynier Sieci"));
  });
});

// Checks the job list of the last real scrape. A fresh checkout has none yet
// (data/ is personal and never committed), so the block is skipped there.
const DATASET = `${import.meta.dir}/data/jobs.json`;

describe.skipIf(!existsSync(DATASET))("real dataset invariant", () => {
  test("no vacancy appears twice in the shipped dataset", async () => {
    const payload = await Bun.file(DATASET).json();
    const byIdentity = new Map<string, string[]>();
    for (const j of payload.jobs) {
      const id = jobIdentity(j.company, j.title);
      if (!id) continue;
      byIdentity.set(id, [...(byIdentity.get(id) ?? []), j.url]);
    }
    const dupes = [...byIdentity.entries()].filter(([, urls]) => urls.length > 1);
    expect(dupes).toEqual([]);
  });

  test("cards merged from several boards keep every source link", async () => {
    const payload = await Bun.file(DATASET).json();
    const merged = payload.jobs.filter((j: any) => (j.sources ?? []).length > 1);
    // The dataset genuinely contains cross-portal duplicates, so the dedup must
    // have merged some; if this hits zero the fixture stopped exercising it.
    expect(merged.length).toBeGreaterThan(0);
    for (const j of merged) {
      // The visible link must be one of the sources, and every source distinct.
      const urls = j.sources.map((s: any) => s.url);
      expect(urls).toContain(j.url);
      expect(new Set(urls).size).toBe(urls.length);
    }
  });

  test("every job carries an identity the dashboard can match on", async () => {
    const payload = await Bun.file(DATASET).json();
    const missing = payload.jobs.filter((j: any) => !j.identity);
    expect(missing.map((j: any) => j.title)).toEqual([]);
  });
});
