/**
 * Portal-independent identity for a job posting.
 *
 * The dashboard's pipeline state (applied / interview / rejected / deleted) was
 * keyed purely on the canonical URL. That key is not stable:
 *
 *   - the same vacancy is listed on several boards, each with its own URL, so
 *     dismissing the justjoin copy left the pracuj copy on screen;
 *   - the surviving URL changes between runs. Comparing two consecutive scrapes,
 *     9 of the 83 postings present in both had a different URL the second time
 *     (justjoin re-slugged, or a different portal won the dedup) — so a job
 *     deleted yesterday came back today as a brand new card.
 *
 * Company + title is what actually identifies a vacancy to a human, so that is
 * what state is keyed on. Normalisation strips the noise that varies between
 * boards for the same posting: case, punctuation, and the gender/seniority
 * suffixes German and Polish listings carry — "(m/w/d)", "(m/f/d)", "(k/m)",
 * "(f/m/x)" — which appear on some boards and not others.
 *
 * Kept deliberately conservative: it must never merge two genuinely different
 * vacancies at the same company, so seniority words ("senior", "lead") are NOT
 * stripped. "Senior Network Engineer" and "Network Engineer" stay distinct.
 */

/** Gender/diversity markers that some boards append and others do not. */
const GENDER_MARKER = /\((?:[mwfdkxh][\/|\s]*){2,}\)/gi;

export function normalizeIdentityPart(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(GENDER_MARKER, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Stable key for a posting. Returns "" when there is not enough to identify it,
 * which callers must treat as "no identity" and fall back to the URL — guessing
 * would merge every untitled job into one.
 */
export function jobIdentity(company: string | null | undefined, title: string | null | undefined): string {
  const c = normalizeIdentityPart(company ?? "");
  const t = normalizeIdentityPart(title ?? "");
  if (!c || !t) return "";
  return `${c}|${t}`;
}
