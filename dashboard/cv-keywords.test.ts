/**
 * CV keyword selection. Every keyword is appended to every scrape and costs a
 * call per portal per location, so the list must hold distinct, searchable
 * titles — not one title plus its tech-prefixed clones.
 *
 *   bun test dashboard/cv-keywords.test.ts
 */
import { expect, test } from "bun:test";
import { keywordsFromText } from "./cv-keywords.ts";

// The shape of the CV on file: one current title held twice, two Cisco-internal
// Tier titles, a one-off junior role, and a skills section.
const cv = [
  "Senior Network Engineer (CCIE #69110) with strong expertise in Cisco technologies.",
  "Data Center & SDN — Cisco ACI (Multi-Pod / Multi-Site), Cisco NDO/NDFC, VXLAN EVPN Fabrics, Cisco NX-OS, Nexus, Cisco UCS",
  "Automation — Python scripting, Terraform, Ansible",
  "Sr. Solution Validation Services Consulting Engineer, Cisco Systems, Inc.",
  "Solution Validation Services Consulting Engineer, Cisco Systems, Inc.",
  "DC ACI Technical Consulting Engineer – Tier 2, Cisco Systems, Inc.",
  "DC Infra. Technical Consulting Engineer – Tier 1, Cisco Systems, Inc.",
  "IT Specialist (NOC) – ShortCut.al/Rally.ca",
].join("\n");

const terms = keywordsFromText(cv, 12).map((k) => k.term);

test("keeps the CV's role families and the best narrowing of a broad one", () => {
  expect(terms).toContain("technical consulting engineer");
  expect(terms).toContain("network engineer");
  expect(terms).toContain("cisco network engineer");
});

test("drops fragments, over-specific extensions and one-off titles", () => {
  expect(terms).not.toContain("consulting engineer"); // fragment of a family title
  expect(terms).not.toContain("dc aci technical consulting engineer"); // extension, seen once
  expect(terms).not.toContain("it specialist"); // one-off, no family
});

test("does not prefix a specific title with technologies, or pad to the limit", () => {
  expect(terms.some((t) => /^(cisco|aci|nexus|ucs) technical consulting engineer$/.test(t))).toBe(false);
  expect(terms.length).toBeLessThan(12);
});
