/** Choosing the advertiser in a terminal (surface v1 § Choosing the advertiser): the human picks a candidate; for a
 *  regional family the `proposed` members are preselected and the human toggles them. Pure text in, text out. */

export interface PageCandidate {
  kind: "page";
  pageId: string;
  name: string;
  verification?: string | null;
  likes?: number | null;
  market?: string | null;
  marketLabel?: string | null;
  confirmed?: boolean;
}
export interface FamilyMember { pageId: string; alias?: string | null; market?: string | null; marketLabel?: string | null; proposed?: boolean }
export interface FamilyCandidate {
  kind: "family";
  name: string;
  verification?: string | null;
  likes?: number | null;
  members: FamilyMember[];
  proposed: string[];
  marketMember?: string | null;
  confirmed?: boolean;
}
export type Candidate = PageCandidate | FamilyCandidate;

export interface Lookup {
  next: string;
  status: "none" | "one" | "ambiguous";
  candidates: Candidate[];
}

const likes = (n: number | null | undefined) =>
  n == null ? null : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M likes` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k likes` : `${n} likes`;
const verified = (v: string | null | undefined) => (v && v !== "NOT_VERIFIED" ? "verified" : null);
const join = (parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" · ");

export function candidateLine(c: Candidate, i: number): string {
  const n = String(i + 1).padStart(2);
  if (c.kind === "page") return `${n}  ${join([c.name, c.marketLabel ?? c.market, verified(c.verification), likes(c.likes), `page ${c.pageId}`, c.confirmed === false ? "name match only" : null])}`;
  const proposed = c.proposed.length ? `proposed: ${c.proposed.join(", ")}` : null;
  return `${n}  ${join([c.name, `family of ${c.members.length} pages`, verified(c.verification), likes(c.likes), proposed])}`;
}

/** What `--candidates` and a non-interactive run print: the API's `next`, then one line per candidate. */
export function candidatesText(l: Lookup): string {
  return [l.next, "", ...l.candidates.map(candidateLine)].join("\n");
}

/** "2" -> 1 (0-based), or null for anything that is not one of the numbers shown. */
export function parseChoice(answer: string, count: number): number | null {
  const m = /^\s*(\d+)\s*$/.exec(answer);
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return i >= 0 && i < count ? i : null;
}

export function memberLines(f: FamilyCandidate, selected: ReadonlySet<string>): string[] {
  return f.members.map((m, i) => `${String(i + 1).padStart(2)}  [${selected.has(m.pageId) ? "x" : " "}] ${join([m.marketLabel ?? m.market ?? "no market", m.alias, `page ${m.pageId}`])}`);
}

/** One answer while choosing members: numbers toggle, "a" selects all, "n" none, an empty line confirms. */
export function applyToggle(answer: string, f: FamilyCandidate, selected: ReadonlySet<string>): { selected: Set<string>; done: boolean; error?: string } {
  const a = answer.trim().toLowerCase();
  const next = new Set(selected);
  if (a === "") return selected.size ? { selected: next, done: true } : { selected: next, done: false, error: "select at least one page" };
  if (a === "a") return { selected: new Set(f.members.map((m) => m.pageId)), done: false };
  if (a === "n") return { selected: new Set(), done: false };
  const nums = a.split(/[\s,]+/).filter(Boolean);
  for (const s of nums) {
    const i = parseChoice(s, f.members.length);
    if (i === null) return { selected: new Set(selected), done: false, error: `"${s}" is not a member number` };
    const id = f.members[i]!.pageId;
    if (next.has(id)) next.delete(id);
    else next.add(id);
  }
  return { selected: next, done: false };
}

export const MAX_PAGES = 10;

/** The interactive pick: the page ids to crawl, or null when the human gave up (an empty answer at the first question). */
export async function pickPages(l: Lookup, ask: (q: string) => Promise<string>, say: (s: string) => void): Promise<string[] | null> {
  say(candidatesText(l));
  let chosen: Candidate | undefined;
  while (!chosen) {
    const answer = await ask(`Which one? (1-${l.candidates.length}, empty to stop) `);
    if (answer.trim() === "") return null;
    const i = parseChoice(answer, l.candidates.length);
    if (i === null) say(`Type a number from 1 to ${l.candidates.length}.`);
    else chosen = l.candidates[i];
  }
  if (chosen.kind === "page") return [chosen.pageId];
  let selected = new Set(chosen.proposed);
  for (;;) {
    say([`${chosen.name}: pick the pages to crawl (numbers toggle, a = all, n = none, empty line = go).`, ...memberLines(chosen, selected)].join("\n"));
    const r = applyToggle(await ask("> "), chosen, selected);
    selected = r.selected;
    if (r.error) say(r.error);
    if (r.done) {
      if (selected.size > MAX_PAGES) { say(`At most ${MAX_PAGES} pages in one job.`); continue; }
      return chosen.members.map((m) => m.pageId).filter((id) => selected.has(id));
    }
  }
}
