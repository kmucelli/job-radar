import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { languageRequirements, postingLanguage } from "./language-req.ts";

// The real markers from config.json, so the tests cover what the scraper uses.
const gate = JSON.parse(readFileSync(join(import.meta.dir, "config.json"), "utf8")).languageGate;
const rules = { optionalMarkers: gate.optionalMarkers, requiredMarkers: gate.requiredMarkers };

const langs = (description: string, title = "Network Engineer") =>
  languageRequirements({ title, description }, rules).map((r) => `${r.lang}:${r.how}`);

describe("explicit requirements", () => {
  it("reads German requirement phrasings", () => {
    expect(langs("Sehr gute Deutschkenntnisse in Wort und Schrift.")).toEqual(["german:required"]);
    expect(langs("Deutschkenntnisse erforderlich.")).toEqual(["german:required"]);
    expect(langs("Gute Deutsch- und Englischkenntnisse.")).toEqual(["german:required"]);
    expect(langs("Das bringst du mit: Deutschkenntnisse; CCNP.")).toEqual(["german:required"]);
  });

  it("reads English, Polish and Dutch phrasings", () => {
    expect(
      langs("Remark: The following position requires fluent German language skills (min. level C1), both written and spoken."),
    ).toEqual(["german:required"]);
    expect(langs("Fluent Polish is required.")).toEqual(["polish:required"]);
    expect(langs("Biegła znajomość języka niemieckiego.")).toEqual(["german:required"]);
    expect(langs("Znajomość języka niemieckiego.")).toEqual(["german:required"]);
    expect(langs("Bardzo dobra znajomość języka niemieckiego, mile widziany angielski.")).toEqual(["german:required"]);
    expect(langs("Sehr gute Kenntnisse der deutschen Sprache.")).toEqual(["german:required"]);
    expect(langs("Vloeiend Nederlands is vereist.")).toEqual(["dutch:required"]);
  });

  it("treats a CEFR level as a requirement", () => {
    expect(langs("Languages: English C1, German B2.")).toEqual(["german:level"]);
  });

  it("takes a language named in the title as required", () => {
    expect(langs("", "Network Engineer with German")).toEqual(["german:title"]);
    expect(langs("", "Network Engineer with German language")).toEqual(["german:title"]);
  });
});

describe("not a requirement", () => {
  it("ignores nice-to-haves and explicit negations", () => {
    expect(langs("German is a plus.")).toEqual([]);
    expect(langs("German language skills are not required.")).toEqual([]);
    expect(langs("Deutsch ist kein Muss.")).toEqual([]);
    expect(langs("Mile widziana znajomość języka niemieckiego.")).toEqual([]);
    expect(langs("Knowledge of German or French would be appreciated.")).toEqual([]);
    expect(langs("Knowledge of German is considered a big plus.")).toEqual([]);
    expect(langs("You are fluent in Polish and English (Spanish very welcome).", "Presales Engineer")).toEqual([
      "polish:required",
    ]);
  });

  it("does not confuse places, companies and verbs with languages", () => {
    expect(langs("Location: Munich, Germany. Fluent English required.")).toEqual([]);
    expect(langs("Deutsche Telekom is our customer; you must hold a CCIE.")).toEqual([]);
    expect(langs("Experience with the German market is required.")).toEqual([]);
    expect(langs("", "Network Engineer (German market)")).toEqual([]);
    expect(langs("You will polish our automation tooling and must hold a CCIE.")).toEqual([]);
    expect(langs("We offer English/German language lessons with native speakers.")).toEqual([]);
    expect(langs("You will support customers across Spanish-speaking LATAM; fluent English is a must.")).toEqual([]);
  });

  it("finds nothing in an English posting", () => {
    expect(
      langs(
        "We are looking for a senior network engineer to design and operate our data center fabric. " +
          "You will work with Cisco ACI, VXLAN EVPN and Nexus switches, automate changes with Python and " +
          "Ansible, and support the operations team. Fluent English is required for this role.",
      ),
    ).toEqual([]);
  });
});

describe("posting language", () => {
  const german =
    "Wir suchen ab sofort einen Netzwerkadministrator für unser Rechenzentrum in Berlin. Du bist für den " +
    "Betrieb und die Weiterentwicklung der Netzwerkinfrastruktur verantwortlich und arbeitest eng mit dem " +
    "Team zusammen. Zu deinen Aufgaben gehören die Planung, die Umsetzung und die Dokumentation von " +
    "Änderungen sowie der Support bei Störungen. Wir bieten dir ein modernes Arbeitsumfeld und flexible Arbeitszeiten.";
  const polish =
    "Poszukujemy doświadczonego inżyniera sieci do zespołu w Krakowie. Twoje zadania to projektowanie i " +
    "utrzymanie infrastruktury sieciowej oraz wsparcie zespołu przy wdrożeniach. Wymagania: doświadczenie w " +
    "pracy z urządzeniami Cisco, znajomość protokołów routingu oraz umiejętność pracy w zespole. Oferujemy " +
    "stabilne zatrudnienie, pakiet medyczny i możliwość rozwoju w ramach firmy.";

  it("tags the language the description is written in", () => {
    expect(postingLanguage(german)).toBe("german");
    expect(postingLanguage(polish)).toBe("polish");
    expect(langs(german)).toEqual(["german:posting"]);
    expect(langs(polish)).toEqual(["polish:posting"]);
  });

  it("does not tag it when the posting says the language is optional", () => {
    expect(langs(german + " Deutsch ist kein Muss, Englisch genügt.")).toEqual([]);
  });

  it("can be switched off", () => {
    expect(languageRequirements({ title: "x", description: german }, { ...rules, postingLanguage: false })).toEqual([]);
  });
});
