/**
 * Tests for the job-list search box (smart-filter.js).
 *
 * The old box was a raw substring test over title + company: word order,
 * accents, abbreviations, locations and technologies all made it miss
 * ("wroclaw" found 0 of 58 Wrocław jobs, "sr network engineer" found 0).
 *
 *   bun test dashboard/smart-filter.test.ts
 */
import { expect, test, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import SmartFilter from "./smart-filter.js";

const job = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  company: "Acme",
  location: "Warszawa",
  technologies: [],
  matched: [],
  ...extra,
});

const JOBS = [
  job("Network Engineer"),
  job("Sr. Staff Network Engineer", { company: "Zscaler" }),
  job("Senior Network Security Engineer"),
  job("Data Center Engineer (m/w/d)"),
  job("IT Network Administrator (m/w/d)", { company: "GEBHARDT Fördertechnik GmbH" }),
  job("Network Engineer Datacenter and Cloud / Netzwerkadministrator (m/w/d)"),
  job("Senior DevOps Engineer", { technologies: ["Kubernetes", "Networking"], matched: ["network"] }),
  job("Remote AI & Automation Engineer", { location: "Remote; Wrocław" }),
  job("Cloud Architect", { company: "Cloud Solutions GmbH" }),
  job("Inżynier sieci / Network Engineer"),
];

const titles = (query: string) => JOBS.filter(SmartFilter.compile(query, JOBS).test).map((j) => j.title);

describe("without the vocabulary", () => {
  beforeAll(() => SmartFilter.setVocabulary(null));

  test("empty query matches everything", () => {
    const m = SmartFilter.compile("  ", JOBS);
    expect(m.active).toBe(false);
    expect(JOBS.every(m.test)).toBe(true);
  });

  test("words in any order, accents folded", () => {
    expect(titles("engineer network")).toContain("Network Engineer");
    expect(titles("wroclaw")).toEqual(["Remote AI & Automation Engineer"]);
    expect(titles("fordertechnik")).toEqual(["IT Network Administrator (m/w/d)"]);
    expect(titles("inzynier")).toEqual(["Inżynier sieci / Network Engineer"]);
  });

  test("prefixes while typing, and inside long words like the old box", () => {
    expect(titles("autom")).toEqual(["Remote AI & Automation Engineer"]);
    expect(titles("administrator")).toContain("Network Engineer Datacenter and Cloud / Netzwerkadministrator (m/w/d)");
  });

  test("technologies are searchable", () => {
    expect(titles("kubernetes")).toEqual(["Senior DevOps Engineer"]);
  });
});

describe("with keyword-map.json", () => {
  beforeAll(() => {
    SmartFilter.setVocabulary(JSON.parse(readFileSync(join(import.meta.dir, "keyword-map.json"), "utf8")));
  });

  test("abbreviations work in both directions", () => {
    expect(titles("senior network engineer")).toContain("Sr. Staff Network Engineer");
    expect(titles("sr network engineer")).toContain("Senior Network Security Engineer");
    expect(titles("dc engineer")).toContain("Data Center Engineer (m/w/d)");
    expect(titles("k8s")).toEqual(["Senior DevOps Engineer"]);
  });

  test("title words match the title, not skill lists", () => {
    // The DevOps job lists "networking" as a skill; that must not make it a network engineer.
    expect(titles("network engineer")).not.toContain("Senior DevOps Engineer");
    expect(titles("netwrok")).not.toContain("Senior DevOps Engineer");
  });

  test("but a title word still finds a company name", () => {
    expect(titles("cloud solutions")).toContain("Cloud Architect");
  });

  test("a known title also finds its role family, quotes make it exact", () => {
    const broad = titles("network administrator");
    expect(broad).toContain("Network Engineer");
    expect(broad).toContain("Network Engineer Datacenter and Cloud / Netzwerkadministrator (m/w/d)");
    expect(titles('"network administrator"')).toEqual(["IT Network Administrator (m/w/d)"]);
    expect(SmartFilter.compile("network administrator", JOBS).explain.join(" ")).toContain("also matches");
  });

  test("typos are fixed against words in the list and explained", () => {
    const m = SmartFilter.compile("netwrok enginer", JOBS);
    expect(m.explain).toContain("netwrok → network");
    expect(m.explain).toContain("enginer → engineer");
    expect(JOBS.filter(m.test).map((j) => j.title)).toContain("Network Engineer");
  });

  test("minus excludes by title, company or location", () => {
    const r = titles("network -security");
    expect(r).toContain("Network Engineer");
    expect(r).not.toContain("Senior Network Security Engineer");
    expect(titles("engineer -remote")).not.toContain("Remote AI & Automation Engineer");
  });

  test("explain is empty for a plain word", () => {
    expect(SmartFilter.compile("kubernetes", JOBS).explain).toEqual([]);
  });
});
