/**
 * Assembles `docs/changelog-cdkd.md` from `changelog.d/`.
 *
 * WHY THE FILE IS NO LONGER EDITED DIRECTLY (issue
 * go-to-k/cdkd#2779, option A). Every lane appended its entry to the SAME
 * anchor -- the top of one list -- so the file conflicted on essentially every
 * parallel-lane rebase. Measured on that issue: four rebases across two PRs in
 * one day, all four conflicting, all four on this file alone, with nothing else
 * in either branch's diff ever colliding. A per-entry layout removes the shared
 * anchor: two lanes write two different files and git has nothing to resolve.
 *
 * THE ASSEMBLED OUTPUT IS NOT COMMITTED, and that is the condition the option
 * turns on rather than a detail. The issue's own analysis is that assembly
 * "removes the conflict only under one condition ... the assembled file must
 * not be committed by each lane" -- committing it reproduces the same anchor
 * one file over and gains nothing. So `docs/changelog-cdkd.md` is gitignored
 * and built.
 *
 * ## The layout
 *
 *   changelog.d/_header.md          frontmatter, intro, the contract sections
 *   changelog.d/entries/<date>-<issue>-<slug>.md   ONE entry each
 *   changelog.d/_archive.md         every entry written before the migration
 *
 * The archive is one file rather than 574, deliberately: splitting settled
 * history would produce a diff nobody can review, in which a mis-split is
 * indistinguishable from a correct one, to make uniform something no lane will
 * ever edit again.
 *
 * ## A fragment carries NO dated heading, and that is load-bearing
 *
 * The heading is EMITTED here, grouped by the date in each filename. Letting a
 * lane write its own heading is what produced the defect class issue
 * go-to-k/cdkd#1837 closed: two lanes opening the same day both wrote
 * `**Recently Implemented** (<date>):`, keep-both left two, and on one occasion
 * an unrelated section wedged between the halves left the document's dates
 * running 25 -> 24 -> 25 -> 23. A generated heading cannot be duplicated by a
 * merge resolution, because no lane writes one.
 *
 * ## Collision-freedom is by CONSTRUCTION
 *
 * A fragment path embeds the DATE, the issue number and a slug, and two lanes
 * would have to match on all three to collide. The issue asks for "a naming
 * rule that guarantees two PRs cannot choose the same fragment path"; this is
 * that rule, and `readEntries` enforces the shape rather than trusting it.
 *
 * The issue number alone is NOT that guarantee, and saying so was wrong: two
 * PRs on one issue is this repo's norm -- go-to-k/cdkd#2779 shipped as option
 * B and option A. What the slug adds is that the remaining collision requires
 * two lanes to pick the same words on the same day for the same issue, which
 * is a conflict git will show them rather than one it resolves silently.
 *
 * ## The bound, stated rather than implied
 *
 * The seam guarantee below is over the ASSEMBLER'S OWN output structure. It
 * does not extend to a fragment whose BODY opens a CommonMark container the
 * assembler cannot close: a column-0 unclosed ``` passes all three refusals in
 * `readEntries` and collapses the rendered document from 52 headings to 1.
 * Nothing here catches it, and the fence's render verdict only sees it through
 * its `total > 1` floor. Closing it means parsing each fragment rather than
 * pattern-matching it, which is a real change and not one this migration
 * needs; it is written down so the next reader does not have to discover it.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FRAGMENT_DIR = 'changelog.d';
export const ENTRIES_DIR = 'entries';
export const HEADER_FILE = '_header.md';
export const ARCHIVE_FILE = '_archive.md';

/**
 * `<YYYY-MM-DD>-<issue>-<slug>.md`, with a slug of lowercase words. The month
 * and day are RANGE-bounded rather than any two digits: `2026-99-99` sorts
 * ahead of every real date and would silently head the document.
 */
const ENTRY_NAME = /^(\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))-(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/** The heading the assembler emits, and the only place its shape is written. */
export function headingFor(date: string): string {
  return `**Recently Implemented** (${date}):`;
}

/**
 * EXPORTED so a consumer cannot carry a looser copy: a pattern that matches a
 * line this one rejects sees a section the assembler does not, and any count
 * derived from it disagrees with the document. Both forms return 51 on today's
 * archive, so the drift would be silent (go-to-k/cdkd#2813 review).
 */
export const HEADING = /^\*\*Recently Implemented\*\* \((\d{4}-\d{2}-\d{2})[^)]*\):$/;

/**
 * "This line was MEANT to be a heading", looser than {@link HEADING} on the
 * axes a fragment can get wrong. EXPORTED because
 * `changelog-entry-uniqueness.test.ts` needs exactly this predicate: it is
 * what that fence reports as an unparsed heading, so a second copy drifting
 * wider there re-opens the case this refusal closes -- the fence reds over the
 * ASSEMBLED document while the fragment anyone could fix goes unnamed.
 */
export const LOOSE_HEADING = /^(?:[>#*+-]\s*)*\*\*recently implemented\*\*/;

export interface Entry {
  readonly file: string;
  readonly date: string;
  readonly issue: number;
  readonly text: string;
}

export function readEntries(root: string): Entry[] {
  const dir = join(root, FRAGMENT_DIR, ENTRIES_DIR);
  const names = readdirSync(dir).filter((n) => n !== '.gitkeep');

  const bad = names.filter((n) => !ENTRY_NAME.test(n));
  if (bad.length > 0) {
    throw new Error(
      `changelog fragment names must be <YYYY-MM-DD>-<issue>-<slug>.md -- date, issue and slug TOGETHER are ` +
        `what keep two lanes from choosing one path, and the date is where the section heading comes from. ` +
        `Offending: ${bad.join(', ')}`
    );
  }

  return names.map((file) => {
    const m = ENTRY_NAME.exec(file)!;
    const text = readFileSync(join(dir, file), 'utf-8').replace(/\s+$/, '');
    if (!text.startsWith('- ')) {
      throw new Error(`${file}: a fragment is ONE entry and must start with "- " at column 0`);
    }
    // LOOSE, not the strict heading regex. A heading that is indented, behind
    // a `>` or behind a `- ` is still a heading a lane MEANT to write, and the
    // strict form accepts all three -- measured. The uniqueness fence then reds
    // over the ASSEMBLED document and blames it, when the fixable thing is the
    // fragment. Refusing here names the file. (Same reasoning, and the same
    // loose/strict pairing, as `changelog-entry-uniqueness.test.ts`.)
    if (text.split('\n').some((l) => LOOSE_HEADING.test(l.trimStart().toLowerCase()))) {
      throw new Error(
        `${file}: a fragment must NOT carry a dated heading -- the assembler emits one per date, which is ` +
          `what stops two lanes writing the same heading (issue go-to-k/cdkd#1837)`
      );
    }
    // ONE entry, not a list of them: a second column-0 bullet is a second
    // entry, and it would inherit this file's date and issue number for
    // ordering while carrying its own subject.
    if (text.split('\n').filter((l) => l.startsWith('- ')).length !== 1) {
      throw new Error(`${file}: a fragment is ONE entry -- split a second column-0 bullet into its own file`);
    }
    return { file, date: m[1]!, issue: Number(m[2]), text };
  });
}

/**
 * Newest first, matching the document. Ties break on the issue number
 * DESCENDING and then on the FILENAME, which is what makes the order total --
 * two entries sharing a date must not depend on directory-read order, which
 * differs between filesystems.
 *
 * The filename leg is not belt-and-braces: two PRs on ONE issue is this repo's
 * norm, and go-to-k/cdkd#2779 is itself the example, shipping as option B
 * (go-to-k/cdkd#2789) and option A. Same date plus same issue leaves the
 * comparator returning 0, and an earlier revision of this comment claimed the
 * order was total anyway. Measured, it was not.
 */
export function byNewest(a: Entry, b: Entry): number {
  return b.date.localeCompare(a.date) || b.issue - a.issue || a.file.localeCompare(b.file);
}

/**
 * One dated section: its heading line VERBATIM plus everything under it. The
 * heading is kept rather than regenerated so the archive round-trips byte for
 * byte, including the one legitimate variant form -- `(2026-07-02, second
 * batch):`, a day deliberately split in two, which `headingFor` cannot
 * reproduce and must not overwrite.
 */
interface Section {
  readonly date: string;
  readonly heading: string;
  readonly body: string[];
}

function splitSections(lines: readonly string[]): { preamble: string[]; sections: Section[] } {
  const first = lines.findIndex((l) => HEADING.test(l));
  if (first === -1) throw new Error(`${ARCHIVE_FILE}: no dated heading found`);
  const preamble = lines.slice(0, first);
  const sections: Section[] = [];
  for (const line of lines.slice(first)) {
    const m = HEADING.exec(line);
    if (m) sections.push({ date: m[1]!, heading: line, body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  return { preamble, sections };
}

export function assembleChangelog(root: string): string {
  const header = readFileSync(join(root, FRAGMENT_DIR, HEADER_FILE), 'utf-8').replace(/\s+$/, '');
  const archive = readFileSync(join(root, FRAGMENT_DIR, ARCHIVE_FILE), 'utf-8').replace(/\s+$/, '');
  const entries = [...readEntries(root)].sort(byNewest);

  const { preamble, sections } = splitSections(archive.split('\n'));

  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(e.date, [...(groups.get(e.date) ?? []), e]);

  // MERGE into the archive's own section list rather than emitting every
  // fragment group above it. The first revision spliced only the archive's TOP
  // date and stacked the rest on front, which is correct exactly while every
  // fragment is newer than the newest archived day -- and produces BOTH a
  // duplicate heading and a rising date the moment one is not. Measured: a
  // fragment dated at the archive's SECOND heading yielded
  // 09-07 / 09-08 / 09-07, which is the go-to-k/cdkd#1837 defect class arriving
  // through the generator that exists to make it impossible. Found by review,
  // not by the fence, because every fixture date was distinct and decreasing.
  //
  // A date the archive already heads takes that section, newest entries first.
  // A date it does not gets a NEW section inserted in descending position, so
  // an entry older than part of the archive still lands in order.
  const merged: Section[] = sections.map((s) => {
    const es = groups.get(s.date);
    if (!es) return s;
    groups.delete(s.date);
    return { ...s, body: [...es.map((e) => e.text), ...s.body] };
  });

  for (const [date, es] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const fresh: Section = { date, heading: headingFor(date), body: es.map((e) => e.text) };
    const at = merged.findIndex((s) => s.date < date);
    if (at === -1) merged.push(fresh);
    else merged.splice(at, 0, fresh);
  }

  // THE SEAM IS NORMALISED ONCE, not patched per insertion point, and that is
  // the whole reason this reads the way it does.
  //
  // A heading needs a blank line before it or CommonMark reads it as a lazy
  // continuation of whatever precedes: after a bullet it lands INSIDE the
  // `<li>`, after a paragraph inside the `<p>`, and either way the section it
  // heads stops existing on the rendered page while every line-shape fence
  // stays green. The first fix appended a blank to each NEW section's body,
  // which guarantees the seam AFTER it and leaves the one BEFORE it open --
  // and the archive's last section deterministically ends with no blank,
  // because the file is read with its trailing whitespace stripped. Measured:
  // a fragment older than the whole archive rendered its heading inside the
  // preceding paragraph, where the `<li>`-shaped verdict written for the first
  // defect could not see it.
  //
  // So the seam is ENSURED rather than imposed: each body is emitted verbatim,
  // and a blank line is inserted before a heading only when the line already
  // there is not one.
  //
  // Normalising instead -- trimming every body and rejoining with a blank --
  // also makes the property hold, and produces a ZERO diff against today's
  // archive: 0 characters, 0 differing lines of 1,439, measured. An earlier
  // revision of this comment rejected it as rewriting "1,015 bytes across 574
  // settled entries", which was a figure taken from a wrongly-anchored
  // comparison and then written down as the reason for a design decision.
  // Retracted.
  //
  // The real reason to prefer this form is that it preserves the archive by
  // CONSTRUCTION rather than by coincidence. Normalising agrees with the
  // archive only while the archive is already normalised; the first hand-edit
  // that leaves two blank lines or a trailing space silently rewrites settled
  // history, and no fence would report it as anything but a large diff.
  const out: string[] = [...preamble];
  for (const s of merged) {
    if (out.length > 0 && out[out.length - 1]!.trim() !== '') out.push('');
    out.push(s.heading, ...s.body);
  }

  return [header, '', out.join('\n').replace(/^\n+/, ''), ''].join('\n');
}

export const OUTPUT_PATH = join('docs', 'changelog-cdkd.md');

function main(): void {
  const root = join(import.meta.dirname, '..');
  writeFileSync(join(root, OUTPUT_PATH), assembleChangelog(root));
  process.stdout.write(`assembled ${OUTPUT_PATH}\n`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) main();
