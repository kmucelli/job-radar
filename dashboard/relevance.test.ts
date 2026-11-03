/**
 * Regression tests for the relevance gate.
 *
 * The bug these lock down: scoring used a raw substring test, so the keyword
 * `aci` (+25, above mediumFitThreshold on its own) matched inside "capacity"
 * and "facilities". It fired on 93 of 160 stored postings and on 14 of 14
 * off-domain ones, which is how "Senior Full Stack Developer (JS, AWS)" was
 * published as *high* fit.
 *
 *   bun test dashboard/relevance.test.ts
 */
import { expect, test, describe } from "bun:test";
import {
  termMatches,
  titleGate,
  offDomain,
  scoreJob,
  assessJob,
  assessStoredJob,
  applyQueryOverrides,
  loadConfig,
  buildCvAlignment,
} from "./scrape-daily.ts";

const cfg = loadConfig();

describe("termMatches — whole-term, not substring", () => {
  test("does not match inside a larger word (the aci bug)", () => {
    expect(termMatches("we operate at scale and capacity", "aci")).toBe(false);
    expect(termMatches("manage our facilities team", "aci")).toBe(false);
    expect(termMatches("client-facing role", "aci")).toBe(false);
  });

  test("still matches the real term", () => {
    expect(termMatches("cisco aci fabric", "aci")).toBe(true);
    expect(termMatches("experience with ACI".toLowerCase(), "aci")).toBe(true);
    expect(termMatches("aci, nx-os and nexus", "aci")).toBe(true);
  });

  test("tolerates plurals so multi-word terms keep working", () => {
    expect(termMatches("two data centers in eu", "data center")).toBe(true);
    expect(termMatches("configure firewalls", "firewall")).toBe(true);
    expect(termMatches("network engineers wanted", "network engineer")).toBe(true);
  });

  test("handles hyphenated and non-alphanumeric terms", () => {
    expect(termMatches("sd-wan deployment", "sd-wan")).toBe(true);
    expect(termMatches("nx-os automation", "nx-os")).toBe(true);
    expect(termMatches("senior .net developer", ".net")).toBe(true);
    expect(termMatches("c++ and cuda", "c++")).toBe(true);
  });

  test("is safe for short off-domain tokens", () => {
    expect(termMatches("we build and ship", "ui")).toBe(false);
    expect(termMatches("biosphere research", "ios")).toBe(false);
    expect(termMatches("ios engineer", "ios")).toBe(true);
    expect(termMatches("ui/ux designer", "ui")).toBe(true);
  });

  test("does not treat Polish/German diacritics as boundaries", () => {
    expect(termMatches("inżynier sieci komputerowych", "sieci")).toBe(true);
    expect(termMatches("netzwerk spezialist", "netzwerk")).toBe(true);
  });
});

describe("offDomain — title veto", () => {
  const rejected = [
    "Senior Full Stack Developer (JS, AWS)", // the posting that prompted this
    "Java Developer",
    "Senior React Full-stack Developer",
    "Remote .NET Full-Stack Developer & Tech Consultant",
    "Fullstack Developer (Java/Angular) | Senior",
    "iOS Engineer",
    "Senior iOS Engineer",
    "Scrum Master",
    "Technical Product Owner",
    "Data Analyst/Scrum Master",
    "Lead SAP FICO Consultant",
    "SAP MM / Retail & Master Data (Senior) Consultant | Poland",
    "Oracle Database Administrator",
    "Kafka Engineer",
    "Technical Writer",
    "Project Manager",
    "Senior Treasury Consultant",
    "Senior C++ Software Engineer with CUDA/GPU/TPU",
    "Senior Data Engineer (Azure / Snowflake / DevOps)",
    "Senior QA Automation Engineer (Python)",
    "Test Manager",
    "Structural Engineering Specialist - Fully Remote | Upto $85/hr",
    "Digital Adoption Specialist – Microsoft 365 & Copilot – Gdańsk",
  ];
  for (const title of rejected) {
    test(`rejects: ${title}`, () => {
      expect(offDomain({ title }, cfg)).not.toBeNull();
    });
  }

  const kept = [
    "Senior Network Engineer",
    "Network Automation Engineer",
    "Datacenter Network Engineer",
    "Senior Network Engineer Campus WAN (Cisco)",
    "Staff Network Engineer (AI Fabric, Datacenter and Edge Networking)",
    "Network & Hardware AI Validation Engineer",
    "Senior Datacenter Inżynier (obszar Cisco)",
    "Inżynier Sieci/ Inżynierka Sieci",
    "Network Engineer – Cisco Spezialist (m/w/d)",
    "Principal Transport Network & DWDM Expert",
    "Structured Cabling Design Engineer",
    "Network Observability & Automation Engineer",
    "Cybersecurity Network Specialist",
    "Specjalista LAN/WAN/FW",
    "Lead Network Architect (w/m/d)",
  ];
  for (const title of kept) {
    test(`keeps: ${title}`, () => {
      expect(offDomain({ title }, cfg)).toBeNull();
    });
  }

  test("networking in the title overrides an off-domain hit", () => {
    // "Pre-Sales" trips `sales`, but "Data Center" is the stronger signal.
    const title = "Principal Solutions Architect / Pre-Sales Lead: Data Center & AI Infrastructure Networking";
    expect(offDomain({ title }, cfg)).toBeNull();
  });

  test("a network job that merely mentions Python is untouched", () => {
    expect(offDomain({ title: "Network Automation Engineer (Python)" }, cfg)).toBeNull();
  });
});

describe("scoreJob", () => {
  test("the reported posting no longer scores on a phantom aci match", () => {
    const raw = {
      title: "Senior Full Stack Developer (JS, AWS)",
      description:
        "Join our team to build scalable services. You will grow capacity across our facilities and work in a client-facing role.",
      technologies: ["react", "nodejs", "typescript", "aws", "python"],
    };
    const { matched } = scoreJob(raw, cfg);
    expect(matched).not.toContain("aci");
    expect(matched).not.toContain("nexus");
  });

  test("a title match outweighs the same term in a description", () => {
    const inTitle = scoreJob({ title: "Network Engineer", description: "" }, cfg);
    const inBody = scoreJob({ title: "Consultant", description: "works with a network engineer" }, cfg);
    expect(inTitle.score).toBeGreaterThan(inBody.score);
  });

  test("a genuine ACI role still scores high", () => {
    const raw = {
      title: "Senior Data Center Network Engineer (Cisco ACI)",
      description: "CCIE Data Center preferred. Nexus, VXLAN, EVPN, ACI fabric, pyATS.",
      technologies: [],
    };
    const { fit, matched } = scoreJob(raw, cfg);
    expect(matched).toContain("aci");
    expect(fit).toBe("high");
  });
});

describe("scoreJob with CV alignment", () => {
  const cvText =
    "Senior Network Engineer (CCIE #69110). Cisco ACI Multi-Pod / Multi-Site, NDO/NDFC, " +
    "VXLAN EVPN, Nexus, UCS, Intersight, MDS. IXIA IxNetwork, Spirent TestCenter. " +
    "Python, Terraform, Ansible. Solution Validation Services Consulting Engineer.";
  const cv = buildCvAlignment(cvText, cfg)!;

  test("recognises CV skills with whole-term matching", () => {
    expect(cv).not.toBeNull();
    expect(cv.skills.has("aci")).toBe(true);
    expect(cv.skills.has("ndo")).toBe(true);
    expect(cv.skills.has("pyats")).toBe(false);
    expect(cv.senior).toBe(true);
  });

  test("a posting built on CV-proven skills outranks one built on aspirational ones", () => {
    // Same raw config weight (25) on both sides: ixia is in the CV, pyats is not.
    const proven = scoreJob({ title: "Validation Engineer", description: "ixia" }, cfg, cv);
    const wish = scoreJob({ title: "Validation Engineer", description: "pyats" }, cfg, cv);
    expect(scoreJob({ title: "Validation Engineer", description: "ixia" }, cfg).score).toBe(
      scoreJob({ title: "Validation Engineer", description: "pyats" }, cfg).score,
    );
    expect(proven.score).toBeGreaterThan(wish.score);
    expect(proven.cvMatched).toContain("ixia");
    expect(wish.cvMatched).not.toContain("pyats");
  });

  test("CV-only skills add weight, but capped", () => {
    const base = scoreJob({ title: "Network Engineer", description: "" }, cfg, cv);
    const withExtra = scoreJob(
      { title: "Network Engineer", description: "ndo ndfc multi-site multi-pod intersight mds ixnetwork testcenter terraform" },
      cfg,
      cv,
    );
    expect(withExtra.matched).toContain("ndo");
    const extraOnly =
      withExtra.score - base.score - Math.round(cfg.scoring.positive.terraform * cfg.scoring.cvAlignment!.inCvMultiplier);
    expect(extraOnly).toBeLessThanOrEqual(cfg.scoring.cvAlignment!.extraSkillCap);
  });

  test("senior title earns the seniority bonus for a senior CV", () => {
    const sr = scoreJob({ title: "Senior Network Engineer", description: "" }, cfg, cv);
    const plain = scoreJob({ title: "Network Engineer", description: "" }, cfg, cv);
    expect(sr.score - plain.score).toBe(cfg.scoring.cvAlignment!.seniorityTitleBonus);
  });

  test("no CV means config-only scoring (unchanged behaviour)", () => {
    const raw = { title: "Network Engineer", description: "pyats" };
    expect(scoreJob(raw, cfg, null).score).toBe(scoreJob(raw, cfg).score);
    expect(buildCvAlignment("", cfg)).toBeNull();
  });
});

// The user's CV (CCIE DC, Cisco consulting/validation roles) names no software
// title, yet "Senior Java Software Engineer" reached the dashboard at high fit:
// the scraper searched "nexus" (a query cut to its first word), Sonatype Nexus
// matched the Cisco "nexus" weight, and generic CV skills (ansible, gitlab,
// git) did the rest. Everything below locks that path shut.
describe("title gate", () => {
  const cvText =
    "Senior Network Engineer (CCIE #69110). Cisco ACI, NDO/NDFC, VXLAN EVPN, Nexus, UCS. " +
    "Python, Terraform, Ansible, CI/CD, Git / GitLab, REST APIs. Data Center.";
  const cvTitles = ["network engineer", "technical consulting engineer", "solution validation services consulting engineer"];
  const cv = buildCvAlignment(cvText, cfg, cvTitles, cvTitles)!;
  const verdict = (title: string) => titleGate({ title }, cfg, cv).verdict;

  const off = [
    "Senior Java Software Engineer", // the reported posting
    "Senior Software Engineer (Java)",
    "Java Software Engineer",
    "Senior Software Engineer (Python)",
    "Python Developer",
    "Senior DevOps Engineer",
    "DevOps / SRE Engineer",
    "Platform Engineer",
    // A generic infrastructure word must not rescue another discipline.
    "Senior Python DevOps Engineer – Cloud Infrastructure & Automation",
    "Senior Platform DevOps Engineer – Observability & Platform Integration",
    // Another profession's role noun decides the job even beside a networking word.
    "Software Engineer Rust & Network Security (m/w/d) - 100% Remote (Softwareentwickler/in)",
    "Elektryk / Elektromonter – Data Center (Polska i Europa) (f/m/x)",
    "Starszy / Starsza Menadżer / Menadżerka Sprzedaży - Cyber Security & Data Center",
    "Projektant Instalacje Chłodzenia / Data Center / AI Infrastructure (m/k)",
    "Computer Vision Engineer - Body Sensor Networks",
    "Network Planning Technical Project Manager",
  ];
  for (const title of off) test(`off: ${title}`, () => expect(verdict(title)).toBe("off"));

  const on = [
    "Network Automation Engineer (DevOps) (m/k)",
    "NetDevOps Engineer",
    "Autonomous Networks Tester",
    "SONiC Expert",
    "Technology Infrastructure Datacentre Specialist",
  ];
  for (const title of on) test(`on: ${title}`, () => expect(verdict(title)).toBe("on"));

  test("generic infrastructure titles are weak, signal-free titles neutral", () => {
    expect(verdict("Infrastructure Engineer")).toBe("weak");
    expect(verdict("Solution Validation Engineer")).toBe("weak");
    expect(verdict("Solution Architect")).toBe("neutral");
    expect(verdict("Technical Lead")).toBe("neutral");
  });

  test("Sonatype Nexus in a title is not a networking signal", () => {
    expect(verdict("DevOps Engineer – Nexus / Artifact Repository Migration")).toBe("off");
  });

  test("a discipline the CV's own titles name is not off-domain for that CV", () => {
    const devCv = buildCvAlignment("Java Developer at ACME. Java, Spring, Kafka.", cfg, ["java developer"])!;
    expect(titleGate({ title: "Senior Java Developer" }, cfg, devCv).verdict).not.toBe("off");
    expect(titleGate({ title: "Senior Java Developer" }, cfg, cv).verdict).toBe("off");
  });

  test("the candidate's own role title is on-domain and reaches medium from the title alone", () => {
    // LinkedIn returns titles only: no description to supply evidence.
    expect(verdict("Technical Consulting Engineer")).toBe("on");
    const a = assessJob({ title: "Technical Consulting Engineer" }, cfg, cv);
    expect(a.reject).toBeNull();
    expect(a.fit).not.toBe("low");
  });
});

describe("scoring evidence", () => {
  const cvText = "Cisco ACI, Nexus, VXLAN EVPN, BGP, Python, Terraform, Ansible, Git, GitLab, CI/CD, scalability";
  const cv = buildCvAlignment(cvText, cfg, ["network engineer"])!;

  test("Sonatype Nexus does not score as Cisco Nexus", () => {
    const sonatype = scoreJob({ title: "Build Engineer", description: "Maven builds published to Sonatype Nexus repository" }, cfg, cv);
    expect(sonatype.matched).not.toContain("nexus");
    const cisco = scoreJob({ title: "Engineer", description: "Cisco Nexus 9000 switches in a VXLAN fabric" }, cfg, cv);
    expect(cisco.matched).toContain("nexus");
  });

  test("supporting terms raise the score but are no domain evidence", () => {
    const r = scoreJob({ title: "Engineer", description: "python terraform ansible" }, cfg, cv);
    expect(r.score).toBeGreaterThan(0);
    expect(r.domainScore).toBe(0);
  });

  test("the reported posting is rejected as off-domain", () => {
    const a = assessJob(
      {
        title: "Senior Java Software Engineer",
        description: "Spring Boot services, artifacts in Sonatype Nexus, deployments via Ansible, GitLab CI/CD, Git.",
        technologies: ["java", "spring", "gitlab"],
      },
      cfg,
      cv,
    );
    expect(a.reject).toBe("off-domain");
    expect(a.matched).not.toContain("nexus");
  });

  test("a neutral title needs real domain evidence, not a DevOps toolset", () => {
    const devops = assessJob(
      { title: "Solution Architect", description: "python terraform ansible git gitlab ci/cd scalability kubernetes" },
      cfg,
      cv,
    );
    expect(devops.reject).toBe("no-evidence");

    const network = assessJob(
      { title: "Solution Architect", description: "Cisco ACI and Nexus data center fabrics, VXLAN EVPN, BGP, routing and switching" },
      cfg,
      cv,
    );
    expect(network.reject).toBeNull();
    // Nothing in the title vouches for it, so it never rates "high".
    expect(network.score).toBeGreaterThanOrEqual(cfg.scoring.highFitThreshold);
    expect(network.fit).toBe("medium");
  });

  test("a weak title needs some domain evidence", () => {
    expect(assessJob({ title: "Infrastructure Engineer", description: "kubernetes terraform python" }, cfg, cv).reject).toBe(
      "no-evidence",
    );
    expect(
      assessJob({ title: "Infrastructure Engineer", description: "cisco routing and switching, firewalls" }, cfg, cv).reject,
    ).toBeNull();
  });

  test("an on-domain title is judged by its score as before", () => {
    const a = assessJob({ title: "Senior Network Engineer", description: "Cisco ACI, BGP" }, cfg, cv);
    expect(a.reject).toBeNull();
    expect(a.fit).toBe("high");
  });

  test("stored jobs are re-checked from their matched terms", () => {
    const base = { portal: "justjoin", url: "https://x", company: "ACME", technologies: [] } as any;
    expect(assessStoredJob({ ...base, title: "Senior Java Software Engineer", matched: ["nexus", "ansible"], fit: "high" }, cfg, cv).keep).toBe(false);
    const neutral = assessStoredJob(
      { ...base, title: "Solution Architect", matched: ["cisco", "aci", "data center", "vxlan", "bgp", "routing"], fit: "high" },
      cfg,
      cv,
    );
    expect(neutral.keep).toBe(true);
    expect(neutral.fit).toBe("medium");
  });
});

describe("query pruning", () => {
  const withPortal = (queries: string[]) => {
    const c = structuredClone(cfg);
    c.portals = { p: { ...c.portals.justjoin, enabled: true, queries } };
    c.apiSources = {};
    return c;
  };

  test("a CV term is dropped where a broader query already runs", () => {
    const c = withPortal(["network", "solution validation engineer"]);
    applyQueryOverrides(c, null, ["network engineer", "cisco network engineer", "technical consulting engineer", "solution validation services consulting engineer"]);
    expect(c.portals.p.queries).toEqual(["network", "solution validation engineer", "technical consulting engineer"]);
  });

  test("configured and ad-hoc queries are never pruned for being narrow", () => {
    const c = withPortal(["network", "network architect"]);
    applyQueryOverrides(c, null, []);
    expect(c.portals.p.queries).toEqual(["network", "network architect"]);
  });

  test("a query the title gate would reject is not searched at all", () => {
    const c = withPortal([]);
    const skipped = applyQueryOverrides(c, ["network automation engineer", "devops engineer", "site reliability engineer"], []);
    expect(c.portals.p.queries).toEqual(["network automation engineer"]);
    expect(skipped).toEqual(["devops engineer", "site reliability engineer"]);
  });
});
