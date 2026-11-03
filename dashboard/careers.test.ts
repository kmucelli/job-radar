/**
 * Tests for the employer career-site source (careers.ts). Fixtures are cut down
 * from real responses (2026-11-03) so the parsers are pinned without network.
 *
 *   bun test dashboard/careers.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  isPolishLocation,
  mapAmazon,
  mapGreenhouse,
  mapLever,
  mapOracle,
  mapWorkable,
  mapWorkday,
  parseTeamtailorRss,
  robotsAllows,
  titleMatches,
  validateCompanies,
  workdayPolandFacet,
  workdayPostedDate,
  type Company,
} from "./careers.ts";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const workday: Company = {
  id: "cisco", name: "Cisco", sector: "Network vendor", origin: "foreign", ats: "workday",
  host: "cisco.wd5.myworkdayjobs.com", tenant: "cisco", site: "Cisco_Careers", careersUrl: "https://jobs.cisco.com",
};

describe("Polish locations", () => {
  test("country, cities, codes and Workday's own spellings count", () => {
    for (const s of ["Krakow, Poland", "Poland, Gdansk", "BIG - Zielinskiego Krakow", "Warszawa, Mazowieckie, Poland",
      "Gdansk, Pomeranian Voivodeship, POL", "Remote (PL)", "Wrocław", "Łódź", "Remote, Poland; Remote, United Kingdom"]) {
      expect(isPolishLocation(s)).toBe(true);
    }
  });
  test("names that merely contain the letters do not", () => {
    for (const s of ["Annapolis Junction, Maryland, US", "Indianapolis, Indiana", "Minneapolis", "Napoli, Italy",
      "Polokwane, South Africa", "Glasgow, United Kingdom", "Remote, Europe", ""]) {
      expect(isPolishLocation(s)).toBe(false);
    }
  });
});

describe("title matching", () => {
  test("every query word starts a title word, in any order", () => {
    expect(titleMatches("Senior Network Engineer", "network engineer")).toBe(true);
    expect(titleMatches("Engineer, Networking (Data Center)", "network engineer")).toBe(true);
    expect(titleMatches("Inżynier Sieci LAN/WAN", "inzynier sieci")).toBe(true);
    expect(titleMatches("Network Engineer", "network architect")).toBe(false);
  });
  test("short words match whole, so 'it' does not find 'Italian'", () => {
    expect(titleMatches("IT Support Engineer", "it support")).toBe(true);
    expect(titleMatches("Italian Speaking Advisor", "it")).toBe(false);
    expect(titleMatches("Anything", "  ")).toBe(false);
  });
});

describe("robots.txt", () => {
  const workdayRobots = "Sitemap: https://x/siteMap.xml\n\nUser-agent: *\nAllow: /Cisco_Careers/\nDisallow: /refreshFacet/\n";
  const smartRecruiters = "User-agent: LinkedInBot\nAllow: /v1/companies/\nUser-agent: *\nDisallow: /\n";
  test("Workday's feed is allowed, its facet refresher is not", () => {
    expect(robotsAllows(workdayRobots, "/wday/cxs/cisco/Cisco_Careers/jobs")).toBe(true);
    expect(robotsAllows(workdayRobots, "/refreshFacet/abc")).toBe(false);
  });
  test("a rule for another bot does not apply to us", () => {
    expect(robotsAllows(smartRecruiters, "/v1/companies/Visa/postings")).toBe(false);
    expect(robotsAllows(smartRecruiters, "/v1/companies/Visa/postings", "linkedinbot")).toBe(true);
  });
  test("longest rule wins, Allow wins a tie, wildcards and $ anchors work", () => {
    const txt = "User-agent: *\nDisallow: /jobs\nAllow: /jobs/public\nDisallow: /*.pdf$\nAllow: /x\nDisallow: /x\nDisallow:\n";
    expect(robotsAllows(txt, "/jobs/internal")).toBe(false);
    expect(robotsAllows(txt, "/jobs/public/1")).toBe(true);
    expect(robotsAllows(txt, "/files/cv.pdf")).toBe(false);
    expect(robotsAllows(txt, "/files/cv.pdf?x=1")).toBe(true);
    expect(robotsAllows(txt, "/x")).toBe(true);
  });
  test("a group for our own agent replaces the * group", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: job-radar\nDisallow: /private\n";
    expect(robotsAllows(txt, "/api/jobs")).toBe(true);
    expect(robotsAllows(txt, "/private/x")).toBe(false);
  });
});

describe("Workday", () => {
  const city = (descriptor: string, id: string, count: number) => ({ descriptor, id, count });
  test("city facets nested one level down; US 'polis' cities are left out", () => {
    const facets = [{ facetParameter: "locationMainGroup", values: [{ facetParameter: "locations", descriptor: "Locations", values: [
      city("Annapolis Junction, Maryland, US", "a", 7), city("Krakow, Poland", "k", 63), city("Warsaw, Poland", "w", 14),
      city("Minneapolis, Minnesota, US", "m", 5), city("Gdansk, Poland", "g", 1),
    ] }] }];
    expect(workdayPolandFacet(facets)).toEqual({ param: "locations", ids: ["k", "w", "g"] });
  });
  test("a country value beats regions and cities", () => {
    const facets = [
      { facetParameter: "Location_Country", values: [city("United States", "us", 900), city("Poland", "pl", 78)] },
      { facetParameter: "Location_Region_State_Province", values: [city("Lesser Poland", "lp", 69)] },
      { facetParameter: "locations", values: [city("Krakow, Poland", "k", 65), city("Gdansk, Poland", "g", 22)] },
    ];
    expect(workdayPolandFacet(facets)).toEqual({ param: "Location_Country", ids: ["pl"] });
  });
  test("no Polish location means no facet", () => {
    expect(workdayPolandFacet([{ facetParameter: "locations", values: [city("Lysaker, Norway", "n", 3)] }])).toBeNull();
  });
  test("posted labels become dates", () => {
    expect(workdayPostedDate("Posted Today", NOW)?.slice(0, 10)).toBe("2026-11-03");
    expect(workdayPostedDate("Posted Yesterday", NOW)?.slice(0, 10)).toBe("2026-11-02");
    expect(workdayPostedDate("Posted 3 Days Ago", NOW)?.slice(0, 10)).toBe("2026-10-31");
    expect(workdayPostedDate("Posted 30+ Days Ago", NOW)?.slice(0, 10)).toBe("2026-10-04");
    expect(workdayPostedDate("", NOW)).toBeNull();
  });
  test("postings map to the public job URL; 'N Locations' reads as Poland", () => {
    const [one, two] = mapWorkday(workday, [
      { title: "Network Engineer", externalPath: "/job/Krakow-Poland/Network-Engineer_2028546", locationsText: "Krakow, Poland", postedOn: "Posted Today", bulletFields: ["2028546"] },
      { title: "SRE", externalPath: "/job/Warsaw-Poland/SRE_1", locationsText: "2 Locations", postedOn: "Posted 2 Days Ago" },
    ], NOW);
    expect(one).toMatchObject({ id: "2028546", url: "https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/Krakow-Poland/Network-Engineer_2028546", location: "Krakow, Poland", detail: "/job/Krakow-Poland/Network-Engineer_2028546" });
    expect(two.location).toBe("Poland (2 locations)");
  });
});

describe("Greenhouse, Lever, Oracle, Amazon", () => {
  test("Greenhouse: Polish office or location only, escaped HTML decoded", () => {
    const jobs = mapGreenhouse({ jobs: [
      { id: 1, title: "Network Engineer", absolute_url: "https://job-boards.greenhouse.io/x/jobs/1", location: { name: "Remote, EMEA" },
        offices: [{ name: "Warsaw", location: "Warsaw, Poland" }], first_published: "2026-10-28T10:00:00-04:00", content: "&lt;p&gt;BGP &amp;amp; EVPN&lt;/p&gt;" },
      { id: 2, title: "Sales", absolute_url: "https://job-boards.greenhouse.io/x/jobs/2", location: { name: "Berlin, Germany" }, offices: [] },
    ] });
    expect(jobs.map((j) => j.id)).toEqual(["1"]);
    expect(jobs[0].description).toBe("BGP & EVPN");
    expect(jobs[0].date).toBe("2026-10-28T14:00:00.000Z");
  });
  test("Lever: country PL or a Polish location; lists join the description", () => {
    const jobs = mapLever([
      { id: "a", text: "Cloud Network Engineer", hostedUrl: "https://jobs.lever.co/x/a", country: "PL", categories: { location: "Kraków" },
        createdAt: NOW, descriptionPlain: "Intro", lists: [{ text: "Requirements", content: "<li>Cisco ACI</li>" }], workplaceType: "remote" },
      { id: "b", text: "Admin", hostedUrl: "https://jobs.lever.co/x/b", country: "SG", categories: { location: "Singapore" } },
    ]);
    expect(jobs.map((j) => j.id)).toEqual(["a"]);
    expect(jobs[0].description).toBe("Intro\nRequirements: Cisco ACI");
    expect(jobs[0].remote).toBe(true);
  });
  test("Oracle: Polish requisitions only, candidate-experience URL", () => {
    const c: Company = { ...workday, id: "jpm", ats: "oracle", host: "jpmc.fa.oraclecloud.com", site: "CX_1001" };
    const jobs = mapOracle(c, [
      { Id: "210", Title: "Network Engineer", PostedDate: "2026-11-02", PrimaryLocation: "Warszawa, Mazowieckie, Poland", PrimaryLocationCountry: "PL", ShortDescriptionStr: "Run the DC fabric" },
      { Id: "211", Title: "Analyst", PrimaryLocation: "GLASGOW, LANARKSHIRE, United Kingdom", PrimaryLocationCountry: "GB" },
    ]);
    expect(jobs.map((j) => j.url)).toEqual(["https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210"]);
    expect(jobs[0].description).toBe("Run the DC fabric");
  });
  test("Amazon: job path becomes the URL, qualifications join the description", () => {
    const [j] = mapAmazon({ jobs: [{ id: "x", id_icims: "10592085", title: "Network Development Engineer", job_path: "/en/jobs/10592085/nde",
      normalized_location: "Gdansk, Pomeranian Voivodeship, POL", posted_date: "October 29, 2026", description: "Build", basic_qualifications: "- BGP" }] });
    expect(j).toMatchObject({ id: "10592085", url: "https://www.amazon.jobs/en/jobs/10592085/nde", description: "Build - BGP" });
    expect(j.date?.slice(0, 10)).toBe("2026-10-29");
  });
});

describe("Teamtailor and Workable", () => {
  test("Teamtailor RSS: Polish tt:location only, CDATA HTML read as text", () => {
    const rss = `<rss><channel>
      <item><title>Senior Network Engineer - SONiC</title><description><![CDATA[<p>EVPN &amp; VXLAN</p>]]></description>
        <pubDate>Mon, 19 Oct 2026 15:39:39 +0200</pubDate><link>https://jobs.codilime.com/jobs/1-sonic</link>
        <remoteStatus>fully</remoteStatus><guid>g1</guid>
        <tt:locations><tt:location><tt:name>Poland</tt:name><tt:city>Warszawa</tt:city><tt:country>Poland</tt:country></tt:location></tt:locations></item>
      <item><title>Account Manager</title><link>https://jobs.codilime.com/jobs/2-am</link><guid>g2</guid>
        <tt:locations><tt:location><tt:city>Berlin</tt:city><tt:country>Germany</tt:country></tt:location></tt:locations></item>
      <item><title>Remote Anywhere</title><link>https://jobs.codilime.com/jobs/3</link><guid>g3</guid></item>
    </channel></rss>`;
    const jobs = parseTeamtailorRss(rss);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "g1", title: "Senior Network Engineer - SONiC", url: "https://jobs.codilime.com/jobs/1-sonic",
      location: "Warszawa, Poland", description: "EVPN & VXLAN", remote: true });
    expect(jobs[0].date).toBe("2026-10-19T13:39:39.000Z");
  });
  test("Teamtailor: a page that is not RSS is an error, not an empty board", () => {
    expect(() => parseTeamtailorRss('<!DOCTYPE html><html lang="en"><head></head></html>')).toThrow("not an RSS feed");
    expect(parseTeamtailorRss("<rss><channel></channel></rss>")).toEqual([]);
  });
  test("Workable: a Polish location among several is enough, and it is the one shown", () => {
    const jobs = mapWorkable({ jobs: [
      { title: "Network Engineer", shortcode: "AB12", url: "https://apply.workable.com/j/AB12", published_on: "2026-10-13",
        locations: [{ country: "Germany", countryCode: "DE", city: "Berlin" }, { country: "Poland", countryCode: "PL", city: "Kraków" }],
        description: "<p>Juniper</p>", telecommuting: false },
      { title: "Helpdesk", shortcode: "CD34", url: "https://apply.workable.com/j/CD34", country: "United States", city: "Spring", locations: [] },
    ] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "AB12", location: "Kraków, Poland", description: "Juniper", date: "2026-10-13T00:00:00.000Z" });
  });
});

describe("company list", () => {
  test("a valid list has no problems", () => {
    expect(validateCompanies([workday, { id: "amazon", name: "Amazon", sector: "Cloud", origin: "foreign", ats: "amazon", careersUrl: "https://www.amazon.jobs" }])).toEqual([]);
  });
  test("missing fields, unknown ATS, duplicates and per-ATS parameters are reported", () => {
    const problems = validateCompanies([
      { ...workday, tenant: "" },
      { ...workday, name: "" },
      { id: "x", name: "X", sector: "IT", origin: "local", ats: "smartrecruiters", careersUrl: "https://x" },
    ]);
    expect(problems).toContain('#1 cisco: workday needs "tenant"');
    expect(problems).toContain("#2 cisco: missing name");
    expect(problems).toContain("#2 cisco: duplicate id");
    expect(problems.some((p) => p.includes('unknown ats "smartrecruiters"'))).toBe(true);
    expect(problems.some((p) => p.includes("origin must be"))).toBe(true);
    expect(validateCompanies({})).toEqual(["companies must be a JSON array"]);
  });
});
