import { describe, expect, test } from "bun:test";
import {
  decodeEntities,
  euresPeriod,
  htmlToText,
  mapDevitJobs,
  mapEures,
  mapJobicy,
  parseBulldogjobPage,
  parseWwrRss,
  withinDays,
} from "./sources.ts";

const DAY = 86_400_000;

describe("bulldogjob", () => {
  const page = (jobs: unknown[]) =>
    `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { totalCount: jobs.length, jobs } },
    })}</script></body></html>`;

  const html = page([
    {
      id: "1-network-engineer-krakow",
      position: "Network Engineer",
      company: { name: "Acme" },
      city: "Kraków, Warszawa",
      remote: false,
      technologyTags: ["Cisco", "BGP"],
      showSalary: true,
      denominatedSalaryLong: { money: "20 000 - 25 000", currency: "PLN" },
      contractB2b: true,
      contractEmployment: false,
    },
    { id: "2-core-engineer-riga", position: "Core Engineer", company: { name: "TeamQuest" }, city: "Riga", remote: false },
    { id: "3-platform-engineer", position: "Platform Engineer", company: { name: "Attio" }, city: "", remote: true },
    { id: "4-backend-berlin", position: "Backend Engineer", company: { name: "n8n" }, city: "Berlin", remote: true },
  ]);

  test("keeps Polish and city-less remote roles, drops foreign-only ones", () => {
    expect(parseBulldogjobPage(html).map((j) => j.id)).toEqual(["1-network-engineer-krakow", "3-platform-engineer"]);
  });

  test("maps the listing fields", () => {
    const [j] = parseBulldogjobPage(html);
    expect(j.url).toBe("https://bulldogjob.pl/companies/jobs/1-network-engineer-krakow");
    expect(j.salary).toBe("20 000 - 25 000 PLN");
    expect(j.technologies).toEqual(["Cisco", "BGP"]);
    expect(j.contractTypes).toEqual(["b2b"]);
    expect(j.date).toBeNull();
  });

  test("a page without the payload is an error, not an empty result", () => {
    expect(() => parseBulldogjobPage("<html></html>")).toThrow(/page shape/);
  });
});

describe("eures", () => {
  const payload = {
    numberRecords: 2,
    jvs: [
      {
        id: "MTQ5MzIx",
        title: "Administrator  sieci komputerowych",
        employer: { name: "Urząd Miasta" },
        locationMap: { PL: ["PL21"] },
        creationDate: Date.UTC(2026, 10, 1),
        availableLanguages: ["pl"],
        description: "<p>Konfiguracja przełączników &amp; routerów</p>",
        positionOfferingCode: "directhire",
      },
      { id: "X1", title: "Monter sieci wodociągowych", employer: { name: "Wod-Kan" }, locationMap: { PL: ["PL22"] } },
    ],
  };

  test("maps an offer and drops utility-network jobs", () => {
    const jobs = mapEures(payload);
    expect(jobs).toHaveLength(1);
    const [j] = jobs;
    expect(j.title).toBe("Administrator sieci komputerowych");
    expect(j.location).toBe("Małopolskie (Kraków), Poland");
    expect(j.url).toBe("https://europa.eu/eures/portal/jv-se/jv-details/MTQ5MzIx?lang=en");
    expect(j.description).toBe("Konfiguracja przełączników & routerów");
    expect(j.postingLanguage).toBe("polish");
    expect(j.date).toBe("2026-11-01T00:00:00.000Z");
  });

  test("buckets the job age into EURES publication periods", () => {
    expect(euresPeriod(1)).toBe("LAST_DAY");
    expect(euresPeriod(3)).toBe("LAST_THREE_DAYS");
    expect(euresPeriod(7)).toBe("LAST_WEEK");
    expect(euresPeriod(30)).toBe("LAST_MONTH");
  });
});

describe("devitjobs (GermanTechJobs / DevITJobs.nl)", () => {
  const now = Date.UTC(2026, 10, 2, 12);
  const job = (over: Record<string, unknown>) => ({
    _id: "id",
    jobUrl: "Acme-Job",
    name: "Job",
    company: "Acme",
    actualCity: "Berlin",
    workplace: "office",
    activeFrom: new Date(now - DAY / 2).toISOString(),
    techCategory: "Java",
    technologies: [],
    language: "German",
    ...over,
  });
  const list = [
    job({ _id: "a", jobUrl: "Acme-Network-Engineer", name: "Network Engineer (m/w/d)", annualSalaryFrom: 60000, annualSalaryTo: 75000 }),
    job({ _id: "b", jobUrl: "Acme-IT-Admin", name: "IT-Administrator (m/w/d)", techCategory: "Network", workplace: "remote", language: "English" }),
    job({ _id: "c", jobUrl: "Acme-Java", name: "Java Developer" }),
    job({ _id: "d", jobUrl: "Acme-Old", name: "Network Engineer", activeFrom: new Date(now - 10 * DAY).toISOString() }),
    job({ _id: "e", jobUrl: "Acme-Paused", name: "Network Engineer", isPaused: true }),
  ];

  test("keeps query matches and the board's Network category, within the job age", () => {
    const jobs = mapDevitJobs(list, "https://germantechjobs.de/jobs/", ["network engineer"], 1, now);
    expect(jobs.map((j) => j.id)).toEqual(["a", "b"]);
  });

  test("maps URL, salary, remote and the stated posting language", () => {
    const [a, b] = mapDevitJobs(list, "https://germantechjobs.de/jobs/", ["network engineer"], 1, now);
    expect(a.url).toBe("https://germantechjobs.de/jobs/Acme-Network-Engineer");
    expect(a.salary).toBe("60000-75000 EUR/yr");
    expect(a.postingLanguage).toBe("german");
    expect(b.remote).toBe(true);
    expect(b.location).toBe("Berlin, Remote");
    expect(b.postingLanguage).toBe("english");
  });

  test("matches query words regardless of accents", () => {
    const jobs = mapDevitJobs([job({ _id: "f", name: "Inżynier sieci (k/m)" })], "https://x/jobs", ["inzynier sieci"], 1, now);
    expect(jobs).toHaveLength(1);
  });
});

describe("jobicy", () => {
  test("maps the feed and decodes entities", () => {
    const [j] = mapJobicy({
      jobs: [
        {
          id: 7,
          url: "https://jobicy.com/jobs/7-network-engineer",
          jobTitle: "Network Engineer &#8211; EMEA",
          companyName: "Acme &amp; Co",
          jobGeo: "Poland,  Germany",
          pubDate: "2026-11-01T08:54:52+00:00",
          jobDescription: "<p>BGP &amp; OSPF</p>",
          jobType: ["Full-Time"],
        },
      ],
    });
    expect(j.title).toBe("Network Engineer – EMEA");
    expect(j.company).toBe("Acme & Co");
    expect(j.location).toBe("Poland,  Germany");
    expect(j.description).toBe("BGP & OSPF");
    expect(j.date).toBe("2026-11-01T08:54:52.000Z");
    expect(j.remote).toBe(true);
  });

  test("an unparsable date becomes null rather than throwing", () => {
    const [j] = mapJobicy({ jobs: [{ id: 1, url: "https://jobicy.com/jobs/1", jobTitle: "X", pubDate: "not a date" }] });
    expect(j.date).toBeNull();
  });
});

describe("we work remotely", () => {
  const rss = `<?xml version="1.0"?><rss><channel><title>WWR</title>
<item>
  <title>Acme Corp: Senior Network Engineer</title>
  <region>Anywhere in the World</region>
  <country>🇺🇸 United States of America</country>
  <skills>BGP, Cisco</skills>
  <type>Full-Time</type>
  <description>&lt;p&gt;Run our &lt;strong&gt;BGP&lt;/strong&gt; edge &amp;amp; peering&lt;/p&gt;</description>
  <pubDate>Mon, 02 Nov 2026 10:00:00 +0000</pubDate>
  <link>https://weworkremotely.com/remote-jobs/acme-senior-network-engineer</link>
</item>
<item><title>Item without a link</title></item>
</channel></rss>`;

  test("splits company and title, normalises the region, decodes the description", () => {
    const jobs = parseWwrRss(rss);
    expect(jobs).toHaveLength(1);
    const [j] = jobs;
    expect(j.company).toBe("Acme Corp");
    expect(j.title).toBe("Senior Network Engineer");
    expect(j.location).toBe("Anywhere in the World (worldwide)");
    expect(j.technologies).toEqual(["BGP", "Cisco"]);
    expect(j.description).toBe("Run our BGP edge & peering");
    expect(j.date).toBe("2026-11-02T10:00:00.000Z");
  });
});

describe("helpers", () => {
  test("decodeEntities leaves unknown names and invalid code points alone", () => {
    expect(decodeEntities("a &#99999999; b &copy;")).toBe("a &#99999999; b &copy;");
  });

  test("htmlToText strips tags and collapses whitespace", () => {
    expect(htmlToText("<p>a</p>\n<ul><li>b</li></ul>")).toBe("a b");
  });

  test("withinDays keeps undated postings and drops older ones", () => {
    const now = Date.UTC(2026, 10, 2);
    expect(withinDays(null, 1, now)).toBe(true);
    expect(withinDays(new Date(now - 2 * DAY).toISOString(), 1, now)).toBe(false);
  });
});
