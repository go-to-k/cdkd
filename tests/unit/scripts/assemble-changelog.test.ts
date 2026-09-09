import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { marked } from 'marked';
import { describe, expect, it } from 'vite-plus/test';
import type { Entry } from '../../../scripts/assemble-changelog.js';
import {
  ARCHIVE_FILE,
  ENTRIES_DIR,
  FRAGMENT_DIR,
  HEADER_FILE,
  assembleChangelog,
  byNewest,
  headingFor,
  readEntries,
} from '../../../scripts/assemble-changelog.js';

/**
 * The assembler is the only thing standing between `changelog.d/` and the
 * document three other fences read, so a defect here is invisible to all of
 * them: they assemble the same output and would agree with a wrong answer.
 *
 * WHAT IS ACTUALLY AT RISK, in the order the assembler can get it wrong:
 *
 *   1. The GENERATED HEADING. Issue go-to-k/cdkd#1837 closed a defect class
 *      where two lanes each wrote `**Recently Implemented** (<same day>):`,
 *      keep-both left two, and an unrelated section wedged between the halves
 *      left the document's dates running 25 -> 24 -> 25 -> 23. Option A's
 *      claim is that the class is now STRUCTURALLY impossible because no lane
 *      writes a heading. That claim is only true if the assembler emits one
 *      per DATE -- emitting one per ENTRY reintroduces it through the
 *      generator, on the very first day two lanes both ship.
 *   2. The ARCHIVE SPLICE. The archive already carries a heading for its
 *      newest day. The first entry written on that same day must land UNDER
 *      it, not above it with a second copy.
 *   3. ORDER. The document is newest-first, and the uniqueness fence rejects
 *      a rising date. Two entries sharing a date must also order
 *      deterministically, or the output depends on directory-read order.
 *   4. The REFUSALS. The naming rule is what makes two lanes unable to
 *      collide; a fragment carrying its own heading is what would reintroduce
 *      (1). Both are enforced in `readEntries`, so both are tested there.
 *
 * Every case builds a THROWAWAY fragment tree rather than reading the repo's
 * own: the real `changelog.d/` has one archive heading and zero entries, so
 * it exercises none of the above. The repo tree is asserted separately, at
 * the end, for the properties only it can show.
 */

interface Tree {
  readonly root: string;
  readonly cleanup: () => void;
}

function makeTree(archive: string, entries: Record<string, string>, header = '# header\n'): Tree {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-changelog-'));
  mkdirSync(join(root, FRAGMENT_DIR, ENTRIES_DIR), { recursive: true });
  writeFileSync(join(root, FRAGMENT_DIR, HEADER_FILE), header);
  writeFileSync(join(root, FRAGMENT_DIR, ARCHIVE_FILE), archive);
  for (const [name, body] of Object.entries(entries)) {
    writeFileSync(join(root, FRAGMENT_DIR, ENTRIES_DIR, name), body);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const ARCHIVE = [headingFor('2026-09-08'), '- archived entry A', '', headingFor('2026-09-07'), '- archived entry B'].join('\n');

function withTree<T>(archive: string, entries: Record<string, string>, fn: (root: string) => T): T {
  const t = makeTree(archive, entries);
  try {
    return fn(t.root);
  } finally {
    t.cleanup();
  }
}

/** Every dated heading in an assembled document, in document order. */
function headings(doc: string): string[] {
  return doc.split('\n').filter((l) => /^\*\*Recently Implemented\*\* \(/.test(l));
}

/**
 * Every dated heading must OPEN its own block. Asserted this way rather than as
 * "no heading sits inside an <li>": two earlier drafts were narrower and each
 * missed a live case -- a proximity match reded on correct output, and an
 * <li>-shaped one was blind to a heading swallowed into a <p>, which is what a
 * fragment older than the whole archive produces.
 *
 * Anchored on a line that IS a dated heading, not on the first occurrence of
 * the marker text: the real header QUOTES the heading shape in prose, so
 * `indexOf` lands mid-line there, slices off an opening backtick and fabricates
 * one `<strong>` -- measured 52 against 51. Correct only for the fixture
 * header, which is how it passed.
 */
function assertEveryHeadingOpensItsBlock(d: string): void {
  const lines = d.split('\n');
  const at = lines.findIndex((l) => /^\*\*Recently Implemented\*\* \(\d{4}-\d{2}-\d{2}/.test(l));
  const html = marked.parse(lines.slice(at).join('\n')) as string;
  const opens = (html.match(/<(?:p|li)>\s*<strong>Recently Implemented<\/strong>/g) ?? []).length;
  const total = (html.match(/<strong>Recently Implemented<\/strong>/g) ?? []).length;
  expect(total, 'no section heading survived the render at all').toBeGreaterThan(1);
  expect(
    total - opens,
    'a section heading was absorbed into the block above it -- the section it heads disappears from the rendered page'
  ).toBe(0);
}


/**
 * The archive's own lines, in order, still in the assembled document.
 *
 * A SUBSEQUENCE rather than a contiguous substring, and the difference is the
 * whole point (issue go-to-k/cdkd#2813). The assembler SPLICES: a fragment
 * whose date the archive already heads lands under that heading, and one dated
 * between two archived sections opens a new section in descending position --
 * both documented in `changelog.d/_header.md` and both the reason the
 * go-to-k/cdkd#1837 duplicate-heading class is structurally impossible. Either
 * one puts new text INSIDE the archive's span, so the archive stops being a
 * contiguous substring while nothing about settled history has changed.
 *
 * The substring form therefore refused a CORRECT assembly: it made every date
 * from the archive's oldest section through its newest unwritable, so a lane
 * shipping on the migration day -- or rebasing an older branch forward -- had
 * to either edit `_archive.md`, which the migration says no lane does again, or
 * date its fragment something other than its date. Measured on the real tree,
 * one probe fragment at a time: dated 2026-09-09 (newer than the newest
 * section) 16 passed; dated 2026-09-08, 2026-09-07 or 2026-08-01 (at or inside
 * the span) 1 failed; dated 2026-05-01 (older than the oldest) 16 passed.
 *
 * What "settled history is not reformatted" actually claims is that every
 * archived line still appears, unmodified and in its original order -- which is
 * exactly a subsequence, and which a splice preserves by construction. The
 * three ways an assembler could break it were each introduced into
 * `scripts/assemble-changelog.ts` and measured on the real archive, one at a
 * time with the tree restored between: dropping one body line per section
 * (`s.body.slice(1)`) failed at archived line 1, collapsing runs of spaces in
 * every body line failed at line 28, and swapping two body lines failed at
 * line 3. The substring form rejects those three too -- it is not weaker
 * against a real reformat, only wrong about a splice.
 *
 * Blank lines are compared like any other, so the seam blank the assembler may
 * INSERT before a heading is absorbed (an insertion is what a subsequence
 * tolerates) while one it DELETED would still be caught.
 */
function assertArchiveConserved(doc: string, archive: string): void {
  const want = archive.split('\n');
  const have = doc.split('\n');
  let i = 0;
  for (const line of have) if (i < want.length && line === want[i]) i++;
  expect(
    i,
    `the archive is no longer reproduced in full -- the assembler is reformatting settled history. ` +
      `First archived line not found in order (${i} of ${want.length}): ${JSON.stringify(want[i] ?? '')}`
  ).toBe(want.length);
}


describe('assemble-changelog', () => {
  it('emits ONE heading per date, not one per entry', () => {
    // The go-to-k/cdkd#1837 class, reachable through the generator. Two lanes
    // shipping on the same NEW day is the ordinary case, not an edge one.
    const doc = withTree(
      ARCHIVE,
      {
        '2026-09-09-1000-first.md': '- first entry',
        '2026-09-09-1001-second.md': '- second entry',
      },
      (root) => assembleChangelog(root)
    );
    expect(headings(doc).filter((h) => h.includes('2026-09-09'))).toEqual([headingFor('2026-09-09')]);
    expect(new Set(headings(doc)).size, 'a date heading is duplicated in the assembled output').toBe(
      headings(doc).length
    );
  });

  it('splices an entry dated as the archive top UNDER the existing heading', () => {
    // Without this the first entry written on the day of the last merge gets a
    // SECOND heading for a date the archive already heads -- the same defect,
    // arriving on the most ordinary day of all.
    const doc = withTree(ARCHIVE, { '2026-09-08-1000-same-day.md': '- same-day entry' }, (root) =>
      assembleChangelog(root)
    );
    expect(headings(doc)).toEqual([headingFor('2026-09-08'), headingFor('2026-09-07')]);
    const lines = doc.split('\n');
    const at = lines.indexOf(headingFor('2026-09-08'));
    expect(lines[at + 1], 'the same-day entry did not land directly under the archive heading').toBe(
      '- same-day entry'
    );
    // And the archive's own entry is still there, after it rather than replaced.
    expect(lines).toContain('- archived entry A');
  });

  it('merges a date the archive heads BELOW its top into that section', () => {
    // The first revision spliced only the archive's TOP date and stacked every
    // other group on front. Correct exactly while every fragment is newer than
    // the newest archived day -- and the moment one is not, it emitted BOTH a
    // duplicate heading and a rising date: measured 09-07 / 09-08 / 09-07,
    // which is the go-to-k/cdkd#1837 class arriving through the generator built
    // to make it impossible. Review found it; no fixture here could, because
    // every date in them was distinct and strictly decreasing.
    const doc = withTree(ARCHIVE, { '2026-09-07-1000-older.md': '- older entry' }, (root) =>
      assembleChangelog(root)
    );
    expect(headings(doc)).toEqual([headingFor('2026-09-08'), headingFor('2026-09-07')]);
    const lines = doc.split('\n');
    expect(lines[lines.indexOf(headingFor('2026-09-07')) + 1]).toBe('- older entry');
    expect(lines).toContain('- archived entry B');
  });

  it('inserts a date the archive does NOT head in descending position', () => {
    // Between the archive's two headings: it needs a new section of its own,
    // placed so the dates still fall.
    const doc = withTree(ARCHIVE, { '2026-09-07-1000-x.md': '- x', '2026-09-06-1000-oldest.md': '- oldest' }, (root) =>
      assembleChangelog(root)
    );
    expect(headings(doc)).toEqual([
      headingFor('2026-09-08'),
      headingFor('2026-09-07'),
      headingFor('2026-09-06'),
    ]);
  });

  it('conserves every fragment: each is read, and each appears exactly once', () => {
    // The collapse floor this fence shipped without. `readEntries` returning
    // [] leaves every other verdict here green AND the three fences that read
    // the assembled document green too -- their population floors are
    // satisfied by the archive alone. So the count is asserted against the
    // DIRECTORY, and each entry's text against the OUTPUT.
    const entries = {
      '2026-09-09-1000-a.md': '- alpha entry',
      '2026-09-09-1001-b.md': '- beta entry',
      '2026-09-08-1002-c.md': '- gamma entry',
    };
    withTree(ARCHIVE, entries, (root) => {
      expect(readEntries(root).length, 'a fragment on disk was not read').toBe(Object.keys(entries).length);
      const doc = assembleChangelog(root);
      for (const text of Object.values(entries)) {
        expect(doc.split(text).length - 1, `${text} does not appear exactly once in the assembled output`).toBe(1);
      }
      // And the archive is conserved too -- an assembler that dropped it would
      // satisfy everything above.
      expect(doc).toContain('- archived entry A');
      expect(doc).toContain('- archived entry B');
    });
  });

  it('orders dates newest-first and breaks ties deterministically', () => {
    // Newest-first is what the uniqueness fence's non-rising verdict requires.
    // The tie-break exists because `readdirSync` order differs between
    // filesystems: without it the output is stable on one machine and not on
    // another, which is the worst way for this to be wrong.
    const doc = withTree(
      ARCHIVE,
      {
        '2026-09-10-2000-newer.md': '- newer day',
        '2026-09-09-1000-lower-issue.md': '- lower issue',
        '2026-09-09-1001-higher-issue.md': '- higher issue',
      },
      (root) => assembleChangelog(root)
    );
    expect(headings(doc)).toEqual([
      headingFor('2026-09-10'),
      headingFor('2026-09-09'),
      headingFor('2026-09-08'),
      headingFor('2026-09-07'),
    ]);
    const lines = doc.split('\n');
    expect(
      lines.indexOf('- higher issue') < lines.indexOf('- lower issue'),
      'same-date entries are not ordered by issue number descending, so the output depends on directory-read order'
    ).toBe(true);
  });

  it('refuses a fragment whose name cannot guarantee collision-freedom', () => {
    for (const bad of ['entry.md', '2026-09-09-first.md', '9-9-1000-x.md', '2026-09-09-1000-Caps.md']) {
      expect(
        () => withTree(ARCHIVE, { [bad]: '- x' }, (root) => readEntries(root)),
        `${bad} was accepted, so two lanes could choose the same fragment path`
      ).toThrow(/<YYYY-MM-DD>-<issue>-<slug>\.md/);
    }
    // The accepting control: without it every arm above passes on a thrower
    // that refuses everything.
    expect(() => withTree(ARCHIVE, { '2026-09-09-1000-ok-slug.md': '- x' }, (root) => readEntries(root))).not.toThrow();
  });

  it('orders two entries on the SAME issue by a TOTAL comparator', () => {
    // Two PRs on one issue is this repo's norm -- go-to-k/cdkd#2779 itself
    // shipped as option B and option A -- so date-then-issue leaves the
    // comparator returning 0 and the order falls to `readdirSync`, which
    // differs between filesystems.
    //
    // Asserted on the COMPARATOR, over two permutations of one set, rather
    // than on an assembled document. The document form cannot discriminate
    // here: the tie-break sorts by filename ASCENDING and this filesystem's
    // readdir already returns that order, so deleting the leg left the case
    // green -- measured, which is the only reason this verdict is written this
    // way. A comparator that returns 0 for a pair leaves `sort` stable, so the
    // two permutations come out DIFFERENT, on any filesystem.
    const es: Entry[] = [
      { file: '2026-09-09-2779-option-a.md', date: '2026-09-09', issue: 2779, text: '- A' },
      { file: '2026-09-09-2779-option-b.md', date: '2026-09-09', issue: 2779, text: '- B' },
    ];
    const forward = [...es].sort(byNewest).map((e) => e.file);
    const reversed = [...es].reverse().sort(byNewest).map((e) => e.file);
    expect(
      reversed,
      'the entry order is not TOTAL: two permutations of the same set sort differently, so the assembled ' +
        'document depends on directory-read order and differs between filesystems'
    ).toEqual(forward);
  });

  it('refuses an impossible date in a fragment name', () => {
    // `2026-99-99` sorts ahead of every real date, so it would silently head
    // the whole document. Accepted by a `\\d{2}` month and day; measured.
    expect(() => withTree(ARCHIVE, { '2026-99-99-1000-x.md': '- x' }, (root) => readEntries(root))).toThrow(
      /<YYYY-MM-DD>/
    );
  });

  it('refuses a heading a lane MEANT to write, however it is spelled', () => {
    // The strict regex accepts an indented, quoted or bulleted heading, so a
    // refusal keyed on it lets all three through -- and the uniqueness fence
    // then reds over the assembled document, blaming the document rather than
    // the fragment anyone can fix. Each of these was measured accepted.
    for (const spelling of [
      `  ${headingFor('2026-09-09')}`,
      `> ${headingFor('2026-09-09')}`,
      `- ${headingFor('2026-09-09')}`,
    ]) {
      expect(
        () => withTree(ARCHIVE, { '2026-09-09-1000-x.md': `- entry\n\n${spelling}\n` }, (root) => readEntries(root)),
        `a heading spelled "${spelling.slice(0, 6)}..." was accepted into a fragment`
        // The heading refusal SPECIFICALLY. Accepting the bullet-count
        // message as an alternative let the `- ` arm fall through to it and
        // stay green when the class dropped `-`, which is the one leg the
        // uniqueness fence calls costly.
      ).toThrow(/must NOT carry a dated heading/);
    }
  });

  it('refuses a fragment holding more than one entry', () => {
    // A second column-0 bullet is a second entry, and it would inherit this
    // file's date and issue number for ordering while carrying its own subject.
    expect(() => withTree(ARCHIVE, { '2026-09-09-1000-x.md': '- one\n- two\n' }, (root) => readEntries(root))).toThrow(
      /is ONE entry/
    );
    // The accepting control: continuation lines under one bullet are normal
    // and must stay legal, indented or not.
    expect(() =>
      withTree(ARCHIVE, { '2026-09-09-1000-y.md': '- one\n  continued here\n\n  and here\n' }, (root) =>
        readEntries(root)
      )
    ).not.toThrow();
  });

  it('refuses a fragment that carries its own dated heading', () => {
    // This is the rule that makes the generated heading meaningful: a fragment
    // free to write one puts the duplicate-heading class straight back.
    expect(() =>
      withTree(ARCHIVE, { '2026-09-09-1000-x.md': `- entry\n\n${headingFor('2026-09-09')}\n` }, (root) =>
        readEntries(root)
      )
    ).toThrow(/must NOT carry a dated heading/);
  });

  it('refuses a fragment that is not a single entry', () => {
    expect(() => withTree(ARCHIVE, { '2026-09-09-1000-x.md': 'prose, not a bullet\n' }, (root) => readEntries(root))
    ).toThrow(/must start with "- "/);
  });

  it('renders every section as a section, not swallowed into the bullet above', () => {
    // Every other verdict here reads LINE SHAPES, and a defect measured on this
    // branch passed all of them: a new section emitted with no trailing blank
    // line makes CommonMark read the NEXT heading as a lazy continuation of the
    // last bullet, so the following section stops existing on the docs site.
    // Five changelog fences stayed green through it. The only instrument that
    // can see it is a real renderer, so this verdict uses one -- `marked` is
    // already a devDependency, read by `rule-file-payload.test.ts` for the same
    // reason: to answer "is this VISIBLE" rather than "does the source match a
    // pattern".
    const doc = withTree(ARCHIVE, { '2026-09-09-1000-x.md': '- probe entry' }, (root) =>
      assembleChangelog(root)
    );
    assertEveryHeadingOpensItsBlock(doc);
    // The seam this fence exists for is the one BEFORE a new section, and the
    // archive's last section is where it is deterministically absent: a
    // fragment older than every archived day lands there.
    assertEveryHeadingOpensItsBlock(
      withTree(ARCHIVE, { '2026-01-01-1000-oldest.md': '- oldest entry' }, (root) => assembleChangelog(root))
    );
  });

  it('keeps the header first and the archive last', () => {
    const doc = withTree(ARCHIVE, { '2026-09-09-1000-x.md': '- fresh' }, (root) => assembleChangelog(root));
    expect(doc.startsWith('# header')).toBe(true);
    const lines = doc.split('\n');
    expect(lines.indexOf('- fresh')).toBeLessThan(lines.indexOf('- archived entry B'));
  });


  /**
   * The archive is CONSERVED at every date position, including the ones the
   * substring form refused (issue go-to-k/cdkd#2813). A wide fixture archive --
   * two sections a week apart -- so "strictly inside the span" is reachable at
   * all; with the consecutive days the other cases use, no such date exists and
   * the interesting arm could not be written.
   */
  describe('the archive survives a fragment at any date position', () => {
    const WIDE = [
      headingFor('2026-09-08'),
      '- archived entry A',
      '',
      headingFor('2026-09-01'),
      '- archived entry B',
    ].join('\n');

    for (const [date, where] of [
      ['2026-09-09', 'newer than the newest archived section'],
      ['2026-09-08', 'the newest archived section itself'],
      ['2026-09-05', 'strictly inside the archived span'],
      ['2026-09-01', 'the oldest archived section itself'],
      ['2026-08-01', 'older than the oldest archived section'],
    ] as const) {
      it(`conserves it for a fragment dated ${date} (${where})`, () => {
        const doc = withTree(WIDE, { [`${date}-2813-probe.md`]: '- probe entry' }, (root) =>
          assembleChangelog(root)
        );
        assertArchiveConserved(doc, WIDE);
        // Not vacuous: the fragment really did land, exactly once. Conservation
        // alone is satisfied by an assembler that dropped the fragment.
        expect(doc.split('- probe entry').length - 1, 'the fragment did not land exactly once').toBe(1);
        const h = headings(doc);
        expect(new Set(h).size, 'a date heading is duplicated').toBe(h.length);
        const dates = h.map((x) => /\((\d{4}-\d{2}-\d{2})/.exec(x)![1]!);
        expect([...dates].sort((a, b) => b.localeCompare(a)), 'the document stopped running newest-first').toEqual(
          dates
        );
        assertEveryHeadingOpensItsBlock(doc);
      });
    }
  });

  /**
   * The conservation check must still REJECT a real reformat, or replacing the
   * substring form with it would trade a false refusal for a false pass. Driven
   * against hand-built documents rather than a broken assembler, since a unit
   * test cannot mutate the module under test; the same three shapes were also
   * introduced into `scripts/assemble-changelog.ts` itself and measured against
   * the real archive (see `assertArchiveConserved`'s comment).
   */
  describe('the conservation check rejects a genuine reformat', () => {
    const A = ['x', '- one', '- two', '', 'y'].join('\n');
    const spliced = ['x', '- one', '- NEW', '- two', '', 'y'].join('\n');

    it('accepts a splice, which is the whole reason it is not a substring check', () => {
      expect(() => assertArchiveConserved(spliced, A)).not.toThrow();
    });

    it('rejects a dropped archived line', () => {
      expect(() => assertArchiveConserved(['x', '- one', '', 'y'].join('\n'), A)).toThrow(
        /no longer reproduced in full/
      );
    });

    it('rejects reordered archived lines', () => {
      expect(() => assertArchiveConserved(['x', '- two', '- one', '', 'y'].join('\n'), A)).toThrow(
        /no longer reproduced in full/
      );
    });

    it('rejects a re-wrapped archived line', () => {
      expect(() => assertArchiveConserved(['x', '- one', '-  two', '', 'y'].join('\n'), A)).toThrow(
        /no longer reproduced in full/
      );
    });

    it('rejects a DELETED blank line, which an insertion-tolerant check could have missed', () => {
      expect(() => assertArchiveConserved(['x', '- one', '- two', 'y'].join('\n'), A)).toThrow(
        /no longer reproduced in full/
      );
    });
  });

  it('assembles the REPO tree, and that tree is the shape the fences read', () => {
    // The properties only the real corpus can show: it parses at all, it is
    // large, and it still opens with the contract sections the policy fence
    // slices. A floor rather than an equality -- the archive grows.
    const root = join(import.meta.dirname, '..', '..', '..');
    const doc = assembleChangelog(root);
    // Read count == file count, so a `readEntries` that silently returned
    // nothing fails HERE rather than leaving every verdict above green over an
    // empty set. It is 0 today and that is the honest state: the archive holds
    // every pre-migration entry and no fragment has been written yet, so this
    // assertion is a TRIPWIRE for the first one rather than coverage now.
    // Both claims this migration rests on, asserted rather than measured once
    // by hand. (1) The ARCHIVE comes out verbatim -- the whole reason it is one
    // file and not 574 is that settled history must not be reformatted, and
    // nothing was watching that. (2) The REAL document renders with every
    // heading opening its own block; the case above uses a five-line fixture,
    // and both live seam defects on this branch were found against the real
    // archive, not a fixture.
    const archive = readFileSync(join(root, FRAGMENT_DIR, ARCHIVE_FILE), 'utf-8').replace(/\s+$/, '');
    assertArchiveConserved(doc, archive);
    assertEveryHeadingOpensItsBlock(doc);
    const onDisk = readdirSync(join(root, FRAGMENT_DIR, ENTRIES_DIR)).filter((n) => n !== '.gitkeep');
    expect(readEntries(root).length, 'a fragment on disk was not read into the assembly').toBe(onDisk.length);
    for (const e of readEntries(root)) {
      expect(doc.split(e.text).length - 1, `${e.file} does not appear exactly once in the assembled output`).toBe(1);
    }
    expect(doc.length, 'the assembled changelog collapsed -- the archive or header is not being read').toBeGreaterThan(
      2_000_000
    );
    expect(doc).toContain('## WHEN an entry is required');
    expect(doc).toContain('## What a SECTION HEADING must be');
    const h = headings(doc);
    expect(h.length, 'the assembled document lost its dated headings').toBeGreaterThanOrEqual(49);
    expect(new Set(h).size, 'the assembled repo document carries a duplicate heading').toBe(h.length);
    // Newest-first, asserted here as well as in the uniqueness fence: that one
    // reads THIS function's output, so a shared defect would agree with itself.
    const dates = h.map((x) => /\((\d{4}-\d{2}-\d{2})/.exec(x)![1]!);
    expect([...dates].sort((a, b) => b.localeCompare(a))).toEqual(dates);
  });
});
