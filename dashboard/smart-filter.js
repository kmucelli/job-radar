/**
 * Smart search for the Job Radar job list (the "Search" box above the jobs).
 *
 * Plain JavaScript with no build step: index.html loads it as a classic script
 * (window.SmartFilter) and the bun tests require() it.
 *
 * Accent- and case-insensitive throughout. A query like
 *
 *     sr network eng wroclaw -security
 *
 * means: a job whose title has "senior"/"sr", "network" and "engineer"/"eng" in
 * any order, located in Wrocław, with no "security" in title/company/location.
 *
 *   network engineer        a recognised job title is matched in the job TITLE,
 *                           its words in any order
 *   network / senior        other job-title words: title or company name
 *   kubernetes / wroclaw    any other word - technology, city, company - in
 *                           title, company, location, technologies or skills
 *   sr / dc / k8s / eng     abbreviations from keyword-map.json, both directions
 *   netwrok                 typos, fixed against the words present in the list
 *   network administrator   a known job title also matches the other titles of
 *                           its role family (network engineer, ...) in the
 *                           job title, including PL/DE/NL ones
 *   "network engineer"      quotes: exact phrase in title/company/location -
 *                           no synonyms, no typo fixes
 *   -security               minus: exclude jobs whose title, company or
 *                           location contains the word or "phrase"
 *
 * Words match from their start, and inside longer words for 4+ letters, so
 * "administrator" still finds "Netzwerkadministrator" as the old box did.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartFilter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Same folding as foldDiacritics() in keyword-expand.ts, so the job list and
  // Smart Search agree on what "wroclaw" or "inzynier" means.
  const SPECIAL = {
    'ł': 'l', 'Ł': 'L', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O',
    'đ': 'd', 'Đ': 'D', 'œ': 'oe', 'Œ': 'OE', 'ı': 'i', 'þ': 'th', 'Þ': 'TH',
  };
  const fold = (s) => String(s == null ? '' : s)
    .replace(/[łŁßæÆøØđĐœŒıþÞ]/g, (c) => SPECIAL[c] || c)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  /** "Sr. Network Engineer (m/w/d)" -> ["sr", "network", "engineer", "m", "w", "d"] */
  const words = (s) => fold(s).split(/[^a-z0-9+#]+/).filter(Boolean);
  const key = (seq) => seq.join(' ');

  let vocab = null;

  /** Load keyword-map.json. Without it the box still does accents, word order,
   *  prefixes, typos, quotes and exclusions; it just knows no abbreviations or
   *  role families. */
  function setVocabulary(map) {
    if (!map || typeof map !== 'object') { vocab = null; return; }

    // word -> phrases it can stand for, both directions for one-word pairs
    // (sr <-> senior, admin <-> administrator, k8s <-> kubernetes). `long` is the
    // one-way short -> long subset, used to recognise titles and to explain.
    const expand = new Map();
    const long = new Map();
    const add = (word, seq) => {
      if (!word || !seq.length || key([word]) === key(seq)) return;
      const list = expand.get(word) || [];
      if (!list.some((p) => key(p) === key(seq))) list.push(seq);
      expand.set(word, list);
    };
    for (const [abbr, full] of Object.entries(map.abbreviations || {})) {
      const a = words(abbr);
      const f = words(full);
      if (a.length !== 1 || !f.length) continue;
      add(a[0], f);
      if (!long.has(a[0])) long.set(a[0], f);
      if (f.length === 1) add(f[0], a);
    }
    for (const [full, abbr] of Object.entries(map.contractions || {})) {
      const a = words(abbr);
      const f = words(full);
      if (a.length === 1 && f.length) add(a[0], f);
      if (f.length === 1 && a.length) add(f[0], a);
    }

    // Spelling classes ("data center", "data centre", "datacenter", ...), plus
    // the single-word swaps they imply (center <-> centre).
    const spellings = Object.entries(map.spellings || {})
      .map(([canonical, variants]) => [canonical, ...variants].map(words).filter((p) => p.length));
    const swaps = new Map();
    for (const cls of spellings) {
      for (const a of cls) {
        for (const b of cls) {
          if (a.length !== b.length || key(a) === key(b)) continue;
          const diff = a.map((w, i) => (w === b[i] ? -1 : i)).filter((i) => i >= 0);
          if (diff.length !== 1) continue;
          const list = swaps.get(a[diff[0]]) || [];
          if (!list.includes(b[diff[0]])) list.push(b[diff[0]]);
          swaps.set(a[diff[0]], list);
        }
      }
    }

    const families = (map.synonyms || []).map((g) => ({
      name: g._group,
      members: [...(g.terms || []), ...(g.pl || []), ...(g.de || []), ...(g.nl || [])]
        .map(words)
        .filter((p) => p.length),
    }));

    // Words that describe a job title (network, engineer, senior, ...). They are
    // matched against the job TITLE only: matched-skill lists mention
    // "networking" on half the jobs, so "network engineer" would otherwise find
    // a DevOps posting.
    const titleWords = new Set();
    for (const fam of families) for (const m of fam.members) m.forEach((w) => titleWords.add(w));
    for (const s of [...(map.roleNouns || []), ...(map.modifiers || [])]) words(s).forEach((w) => titleWords.add(w));

    vocab = { expand, long, spellings, swaps, families, titleWords, titleList: [...titleWords] };
  }

  function spellingVariants(seq) {
    if (!vocab) return [];
    const k = key(seq);
    for (const cls of vocab.spellings) {
      if (cls.some((m) => key(m) === k)) return cls.filter((m) => key(m) !== k);
    }
    return [];
  }

  // ---- job index -----------------------------------------------------------

  const indexCache = new WeakMap();

  function indexJob(job) {
    let ix = indexCache.get(job);
    if (!ix) {
      const title = words(job.title);
      const named = title.concat(words(job.company));
      const basic = named.concat(words(job.location));
      const all = basic.concat(
        words((job.technologies || []).join(' ')),
        words((job.matched || []).join(' ')),
      );
      ix = { title, named, basic, all };
      indexCache.set(job, ix);
    }
    return ix;
  }

  const corpusCache = new WeakMap();

  /** Every word present in a list of jobs - the dictionary for typo fixes. */
  function corpus(jobs) {
    let set = corpusCache.get(jobs);
    if (!set) {
      set = new Set();
      for (const job of jobs || []) for (const w of indexJob(job).all) set.add(w);
      corpusCache.set(jobs, set);
    }
    return set;
  }

  // ---- matching ------------------------------------------------------------

  /** `loose`: what the user typed - matches a word's start, or its inside for
   *  4+ letters. Derived alternatives (abbreviations, typo fixes) match whole words. */
  const wordHit = (w, t, loose) => (loose ? w.startsWith(t) || (t.length >= 4 && w.includes(t)) : w === t);

  function seqIn(hay, seq, loose) {
    outer: for (let i = 0; i + seq.length <= hay.length; i++) {
      for (let j = 0; j < seq.length; j++) {
        if (!wordHit(hay[i + j], seq[j], loose && j === seq.length - 1)) continue outer;
      }
      return true;
    }
    return false;
  }

  /** Optimal-string-alignment distance with early exit (same as keyword-expand.ts). */
  function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = [];
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  /** Closest words in the list for a word that matches nothing (max 3). When
   *  some of them are job-title words, only those are kept: "enginer" means
   *  "engineer", not "engine". */
  function typoFixes(word, dict) {
    if (word.length < 5 || !/^[a-z]+$/.test(word) || !dict) return [];
    for (const w of dict) if (wordHit(w, word, true)) return [];
    const max = word.length >= 9 ? 2 : 1;
    const found = [];
    for (const w of dict) {
      if (w[0] !== word[0] || !/^[a-z]+$/.test(w)) continue;
      const d = editDistance(word, w, max);
      if (d <= max) found.push([d, w]);
    }
    const titled = found.filter((x) => isTitleWord(x[1]));
    return (titled.length ? titled : found)
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
      .slice(0, 3)
      .map((x) => x[1]);
  }

  const isTitleWord = (w) => !!vocab &&
    (vocab.titleWords.has(w) || (w.length > 4 && w.endsWith('s') && vocab.titleWords.has(w.slice(0, -1))));
  /** A title word, or the start of one while it is being typed ("autom"), so the
   *  result set does not jump when the word is completed. */
  const isTitleish = (w) => isTitleWord(w) || (!!vocab && vocab.titleList.some((t) => t.startsWith(w)));

  /**
   * One typed word: the word itself plus everything it can stand for. Words of
   * a recognised job title are looked up in the job title; other title words
   * (or abbreviations/typos of one) in title and company, so a company called
   * "Cloud Solutions" is still found; anything else - a technology, a city -
   * in every indexed field.
   */
  function wordClause(word, dict, explain, titleOnly) {
    const alts = [{ seq: [word], loose: true }];
    if (word.length > 4 && word.endsWith('s')) alts.push({ seq: [word.slice(0, -1)], loose: true });
    const spelled = vocab ? vocab.long.get(word) : null;
    if (vocab) {
      for (const p of vocab.expand.get(word) || []) {
        alts.push({ seq: p, loose: false });
        for (const v of spellingVariants(p)) alts.push({ seq: v, loose: false });
      }
      for (const s of vocab.swaps.get(word) || []) alts.push({ seq: [s], loose: true });
      if (spelled) explain.push(word + ' = ' + key(spelled));
    }
    const fixes = typoFixes(word, dict);
    if (fixes.length) {
      fixes.forEach((f) => alts.push({ seq: [f], loose: false }));
      explain.push(word + ' → ' + fixes.join(' / '));
    }
    const titleish = isTitleish(word) || (spelled && spelled.every(isTitleWord)) || fixes.some(isTitleWord);
    const field = titleOnly ? 'title' : titleish ? 'named' : 'all';
    return (ix) => alts.some((a) => seqIn(ix[field], a.seq, a.loose));
  }

  /**
   * Find the longest known job title in the typed words, after spelling out
   * abbreviations and plurals ("sr network eng" -> "network engineer").
   * Returns the typed-word indexes it covers and the families it belongs to.
   */
  function findTitle(typed) {
    if (!vocab) return null;
    const flat = [];
    const origin = [];
    typed.forEach((w, i) => {
      const singular = w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : null;
      const exp = vocab.long.get(w) || (singular && vocab.long.get(singular));
      const seq = exp || [singular && vocab.families.some((f) => f.members.some((m) => m.includes(singular))) ? singular : w];
      seq.forEach((x) => { flat.push(x); origin.push(i); });
    });
    let best = null;
    for (const fam of vocab.families) {
      for (const m of fam.members) {
        if (best && m.length < best.member.length) continue;
        for (let i = 0; i + m.length <= flat.length; i++) {
          if (!m.every((w, j) => flat[i + j] === w)) continue;
          if (!best || m.length > best.member.length) best = { member: m, start: i, families: [] };
          if (m.length === best.member.length && key(m) === key(best.member) && !best.families.includes(fam)) best.families.push(fam);
          break;
        }
      }
    }
    if (!best) return null;
    const covered = new Set(origin.slice(best.start, best.start + best.member.length));
    return { member: best.member, families: best.families, covered };
  }

  /**
   * Compile a query once; test it against many jobs.
   * `jobs` (optional) is the list being searched - its words are the dictionary
   * for typo fixes.
   * Returns { active, test(job) -> boolean, explain: string[] }.
   */
  function compile(query, jobs) {
    const text = String(query == null ? '' : query).trim();
    if (!text) return { active: false, test: () => true, explain: [] };

    const dict = jobs ? corpus(jobs) : null;
    const explain = [];
    const must = [];
    const mustNot = [];
    const typed = [];

    const re = /(-?)"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(text))) {
      if (m[2] !== undefined) {
        const seq = words(m[2]);
        if (!seq.length) continue;
        if (m[1]) mustNot.push(seq);
        else must.push((ix) => seqIn(ix.basic, seq, false));
        continue;
      }
      const raw = m[3];
      if (raw.startsWith('-') && raw.length > 1) {
        const seq = words(raw.slice(1));
        if (seq.length) mustNot.push(seq);
        continue;
      }
      typed.push(...words(raw));
    }

    const title = findTitle(typed);
    if (title) {
      const spanClauses = [];
      typed.forEach((w, i) => { if (title.covered.has(i)) spanClauses.push(wordClause(w, dict, explain, true)); });
      const phrases = [];
      for (const fam of title.families) {
        for (const member of fam.members) {
          for (const p of [member, ...spellingVariants(member)]) {
            if (!phrases.some((x) => key(x) === key(p))) phrases.push(p);
          }
        }
      }
      must.push((ix) => spanClauses.every((c) => c(ix)) || phrases.some((p) => seqIn(ix.title, p, false)));
      const others = phrases.filter((p) => key(p) !== key(title.member)).map(key);
      if (others.length) {
        explain.push('"' + key(title.member) + '" also matches ' + others.slice(0, 3).join(', ') +
          (others.length > 3 ? ' +' + (others.length - 3) + ' more' : '') + ' (use quotes for exact)');
      }
    }
    typed.forEach((w, i) => { if (!title || !title.covered.has(i)) must.push(wordClause(w, dict, explain, false)); });

    return {
      active: true,
      explain,
      test(job) {
        const ix = indexJob(job);
        // Exclusions look at what a job IS (title, company, location), not at
        // skill lists, so "-security" does not drop every job that lists it.
        if (mustNot.some((seq) => seqIn(ix.basic, seq, true))) return false;
        return must.every((clause) => clause(ix));
      },
    };
  }

  return { setVocabulary, compile, corpus, fold, words };
});
