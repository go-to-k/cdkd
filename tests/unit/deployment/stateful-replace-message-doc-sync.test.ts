import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `docs/cli-deploy-safety.md` quotes the stateful-replace refusals' text
 * VERBATIM in fenced example blocks — the Cloud Control arm's message, the
 * `UpdateReplacePolicy: Retain` note appended to it, and the property-driven
 * twin's message. Nothing connected those copies to the source, and issue
 * #2514's own review round had to hand-sync them once already: the message was
 * reworded in the fix round and the doc example went stale in the same commit
 * until it was noticed by reading both files.
 *
 * The phrases come from TWO source files, not one: the messages themselves are
 * built in `deploy-engine.ts`, but the data-loss reason they interpolate is
 * `renderStatefulReason` in `src/provisioning/stateful-types.ts`. Fencing only
 * the engine would leave the most-quoted sentence in the doc unwatched.
 *
 * This fence is deliberately a small set of PHRASES rather than a whole-message
 * comparison. The source builds each message from concatenated template
 * literals and the doc hard-wraps its fenced block, so neither side holds the
 * message as one contiguous string; a phrase that fits within one line on BOTH
 * sides is the largest unit that can be compared without re-implementing the
 * concatenation. Each phrase must appear in the SOURCE and in the DOC — so a
 * reword on either side reds, which is the point (three places have to move
 * together: the message, the doc example, and the unit tests that assert the
 * wording).
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE_PATHS = {
  engine: join(repoRoot, 'src', 'deployment', 'deploy-engine.ts'),
  // `renderStatefulReason` lives here, so the data-loss reason every refusal
  // interpolates is NOT in the engine source at all — a fence that looked only
  // at the engine could never see it drift.
  statefulTypes: join(repoRoot, 'src', 'provisioning', 'stateful-types.ts'),
} as const;
const docPath = join(repoRoot, 'docs', 'cli-deploy-safety.md');

/**
 * Phrases the refusals and the doc examples must agree on, one line each side,
 * paired with the source file that OWNS each one.
 *
 * Each must be UNIQUE in its own source file, and that is asserted rather than
 * assumed: the first draft of this fence used
 * `--force-stateful-recreation to confirm the data loss`, which three separate
 * messages contain — so rewording the Cloud Control arm alone left the fence
 * green, because a sibling guard's copy still satisfied the containment check.
 * A phrase occurring twice also catches the other way this goes inert: a
 * comment quoting an old wording keeps a `toContain` satisfied after the
 * message it quotes has moved.
 */
const SHARED_PHRASES: ReadonlyArray<{
  phrase: string;
  source: keyof typeof SOURCE_PATHS;
  /**
   * How many of the doc's fenced examples legitimately quote this phrase.
   * Asserted exactly, so it is a floor AND a cap: dropping an example reds,
   * and so does DUPLICATING one, which is how a stale copy survives a reword
   * of its twin. Writing the number out rather than defaulting it to 1 is what
   * made the second `destroy loses all data in the resource` copy visible —
   * before the whitespace normalization it was hidden by a line wrap, and a
   * blanket cap of 1 was passing by accident.
   */
  docOccurrences: number;
}> = [
  { phrase: 'cannot be updated in place by the', source: 'engine', docOccurrences: 1 },
  { phrase: 'resource definition to avoid the update', source: 'engine', docOccurrences: 1 },
  { phrase: 'Retain does NOT protect this path', source: 'engine', docOccurrences: 1 },
  // The property-driven twin's opening. Its documented example sits in the
  // same doc block this PR edited, and nothing fenced it.
  { phrase: 'requires replacement (immutable property', source: 'engine', docOccurrences: 1 },
  // `renderStatefulReason('always')` — the reason BOTH documented examples
  // quote verbatim, which is why this one expects TWO. Reworded in
  // `stateful-types.ts`, every quoted example in the doc goes stale at once,
  // and silently.
  {
    phrase: 'destroy loses all data in the resource',
    source: 'statefulTypes',
    docOccurrences: 2,
  },
];

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * The doc's fenced ```text blocks, concatenated.
 *
 * Scoping the doc side to them is what makes the count meaningful: these
 * phrases are supposed to be QUOTED ERROR OUTPUT, and prose elsewhere on the
 * page that happens to repeat a phrase should neither satisfy the fence nor
 * break its cap.
 */
function fencedTextBlocks(markdown: string): readonly string[] {
  // Leading whitespace is allowed on the fence: several of the ```text
  // blocks on this page sit inside a bullet and are indented two spaces. A
  // `^```text`-anchored regex silently skipped exactly those — the Cloud
  // Control arm's example and the Retain note among them, i.e. the blocks this
  // fence exists for.
  return [...markdown.matchAll(/^[ \t]*```text\n([\s\S]*?)^[ \t]*```/gm)].map((m) => m[1]);
}

/**
 * Collapse every run of whitespace to one space.
 *
 * The DOC side needs it: the doc hard-wraps its fenced examples, so whether a
 * phrase is findable depends on where the wrap happens to fall.
 * `destroy loses all data in the resource` lands on one line in the Cloud
 * Control example and wraps mid-phrase in the property-driven one, so
 * un-normalized the fence saw ONE copy where there are two — the cap held by
 * accident of line wrapping, and the stale-duplicate case it exists for
 * (reword the reason, update one example, leave the other) was exactly the
 * case it could not see. A cosmetic reflow would also have reddened it.
 *
 * The SOURCE side is normalized for symmetry, and buys nothing today — stated
 * plainly because an earlier revision of this comment claimed it joined the
 * messages' concatenated template literals, which is false: the `' + '`
 * between them survives, as do `//` and ` * ` comment markers, so flattening
 * neither joins a split message nor opens a comment hole. Every phrase is
 * single-line on both sides as written.
 */
function flattenWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ');
}

describe('the stateful-replace refusal and its documented example stay in sync', () => {
  const sources = {
    engine: flattenWhitespace(readFileSync(SOURCE_PATHS.engine, 'utf8')),
    statefulTypes: flattenWhitespace(readFileSync(SOURCE_PATHS.statefulTypes, 'utf8')),
  };
  const doc = readFileSync(docPath, 'utf8');
  const docBlocks = fencedTextBlocks(doc).map(flattenWhitespace);
  /**
   * Occurrences summed PER BLOCK, never over the joined text: joining first
   * lets a phrase match across a block boundary and satisfy a count no single
   * example actually contains. No live instance — the per-block sums equal the
   * joined totals today — but the joined form is the one that can lie.
   */
  const docOccurrencesOf = (needle: string): number =>
    docBlocks.reduce((total, block) => total + occurrences(block, needle), 0);

  it('checks every phrase (floor, so a shrunken list cannot pass vacuously)', () => {
    expect(SHARED_PHRASES).toHaveLength(5);
  });

  it('actually captured the blocks it claims to scan', () => {
    // Guard-the-guard, asserted on the CAPTURED blocks rather than on the raw
    // markdown: counting fence markers in the source text says nothing about
    // whether `fencedTextBlocks` extracted them, which is the step that can
    // silently return nothing and make every assertion below vacuous. The
    // first cut of this scoping did exactly that — `^```text` matched only the
    // unindented fences and dropped the two blocks this fence exists for.
    // A floor of 3, not the page's current total: this fence depends on three
    // blocks, and coupling it to the total would red it whenever an unrelated
    // example elsewhere on the page is removed — a failure that says nothing
    // about what this test guards.
    expect(docBlocks.length).toBeGreaterThanOrEqual(3);
    // And the INDENTED form specifically must be among what was captured. This
    // needle is the Cloud Control example's own opening line, so it can only be
    // present if a bullet-indented block was extracted. Asserted through the
    // same normalization the phrase checks use, so a reflow cannot red it.
    expect(docBlocks.join('\n')).toContain(
      'MyTable (AWS::DynamoDB::Table) cannot be updated in place'
    );
  });

  it("the doc sentence deploy-engine.ts's JSDoc quotes still exists", () => {
    // `DeployEngineOptions.forceStatefulRecreation`'s JSDoc defers the
    // EXEMPTION enumeration to this page by quoting the sentence that
    // introduces it, rather than restating the list. Nothing else reds when a
    // doc reword orphans that quote.
    //
    // Both sides asserted, so neither can be satisfied by editing the other.
    // `toBe(1)` rather than a floor on either side: two copies make the
    // pointer ambiguous, zero orphans it.
    const anchor = flattenWhitespace('Three exemptions apply to this trigger specifically');
    expect(occurrences(flattenWhitespace(doc), anchor)).toBe(1);
    expect(occurrences(sources.engine, anchor)).toBe(1);
  });

  for (const { phrase, source, docOccurrences } of SHARED_PHRASES) {
    it(`"${phrase}" appears once in ${source} and ${docOccurrences}x in the doc's examples`, () => {
      // Exactly once on the source side: a second occurrence means the phrase
      // no longer identifies this one message, and the fence stops biting.
      expect(occurrences(sources[source], flattenWhitespace(phrase))).toBe(1);
      // An EXACT count on the doc side — a floor AND a cap. A bare `toContain`
      // is one-sided: it reds when the doc drops the phrase, but says nothing
      // when a doc edit DUPLICATES an example, which is how a stale second
      // copy survives a reword of the first.
      expect(docOccurrencesOf(flattenWhitespace(phrase))).toBe(docOccurrences);
    });
  }

  it('the doc lists one row per path, and every guard READER in src/ is accounted for', () => {
    // The doc used to open this table with a prose count ("Five paths consult
    // this guard"), and the fence compared that count with the table's own
    // rows. Both halves were the doc's, so the pair could agree while `src/`
    // grew a sixth consulting site — a prose count checked against itself.
    //
    // The count is gone from the page (the table IS the enumeration), and the
    // fence now reads the CODE instead. The mapping between the two sides is
    // the content of the assertion:
    //
    //   recreate-targets.ts        -> --recreate-via-cc-api,
    //                                 --recreate-via-sdk-provider
    //                                 (one pre-flight probe, two flags)
    //   deploy-engine.ts (diff)    -> property-driven replacement
    //   deploy-engine.ts (update-  -> --replace,
    //     failure fallback)           Cloud Control auto-fallback
    //                                 (one guard, two triggers)
    //   rollback-executor.ts       -> NO row. It is an ADVISORY reader: it
    //                                 warns that a reverse-replacement cannot
    //                                 bring the data back, and gates nothing.
    //                                 It is in the list so the scan can SEE it
    //                                 — a reader dropped from the scan is the
    //                                 failure this fence exists for, and
    //                                 "which readers exist" is the checkable
    //                                 question; "which of them gate" is not.
    //   recreate-confirm-prompt.ts -> NO row, same ADVISORY class as the
    //                                 rollback reader, added by issue [#2558]'s
    //                                 review round. It decides whether a target
    //                                 in the `--recreate-via-*` plan carries
    //                                 the **DATA LOSS** prefix; the REFUSAL for
    //                                 that path is already the
    //                                 `recreate-targets.ts` row above, and this
    //                                 reader can only reach a target the guard
    //                                 has already let through (it fires under
    //                                 `--force-stateful-recreation`, which is
    //                                 what makes the prompt reachable at all).
    //                                 So it adds display, not a path.
    //
    // The scan covers the spellings the CURRENT readers use — the two
    // predicates and a direct `STATEFUL_TYPES.has(...)` — and no others.
    // Matching only the predicates left the rollback reader invisible while the
    // test's own name claimed completeness.
    //
    // A new reader reds the first expectation naming its file, and a dropped or
    // added doc row reds the second. Neither can be satisfied by editing the
    // other, which is what the old version got wrong.
    //
    // Residuals, stated because the assertion's name would otherwise overclaim
    // — the regex is a syntactic sniff, not a resolver, so each of these is a
    // reader it does NOT see:
    //
    //  - The scan is TEXTUAL, so a comment writing a reader's name followed by
    //    `(` counts. Over-strict — a false RED naming the file, cheap to
    //    resolve.
    //  - **An ALIASED binding is invisible.** `const g = STATEFUL_TYPES;` then
    //    `g.has(t)`, or `import { STATEFUL_TYPES as S }` then `S.has(t)`, reads
    //    the guard without ever writing the matched spelling. Same for the
    //    predicates re-exported or wrapped under another name.
    //  - **Non-`.has` membership is invisible.** `[...STATEFUL_TYPES]`,
    //    `for (const t of STATEFUL_TYPES)`, `STATEFUL_TYPES.forEach(...)` and
    //    `Array.from(STATEFUL_TYPES)` all consult the set; only `.has(` is
    //    matched. The shape is not hypothetical — fences in
    //    `tests/unit/provisioning/stateful-types.test.ts` iterate the set that
    //    way — it is simply not a shape any `src/` reader uses today.
    //  - **The predicate alternation enumerates TODAY's exports.** A third
    //    sibling predicate exported from `stateful-types.ts` would be invisible
    //    until someone widens `(?:Sync|ForReplace)`; the aliasing residual
    //    above does not cover it, because such a predicate needs no alias.
    //  - **Only `.ts` is walked**, so a reader landing in a `.mts` / `.cts`
    //    module would not be seen.
    //  - **A new PATH routed through an EXISTING reader adds no file and reds
    //    nothing.** That is precisely the shape of issue #2514: the Cloud
    //    Control auto-fallback trigger joined the update-failure fallback's
    //    existing guard, so the path count moved while the call sites did not.
    //    Nothing here would have caught it, and no file-level scan could. What
    //    catches that class is the behavioural tests in
    //    `deploy-engine-replace.test.ts`, which assert the refusal per TRIGGER.
    //
    // Widening the regex to the bare identifier was considered and rejected.
    // Measured over `src/`: it admits `src/analyzer/replacement-rules.ts`,
    // which names the set in a comment and reads it nowhere, and it counts
    // prose mentions (a `{@link STATEFUL_TYPES}`, a comment) alongside call
    // sites. The equality below would stop meaning one entry per call site and
    // would red on a comment edit. The residuals are stated instead of hidden.
    const srcDir = join(repoRoot, 'src');
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // The defining module is not a reader of itself.
        if (full === SOURCE_PATHS.statefulTypes) continue;
        const text = readFileSync(full, 'utf8');
        for (const _ of text.matchAll(
          /\bisStatefulRecreateTarget(?:Sync|ForReplace)\s*\(|\bSTATEFUL_TYPES\s*\.\s*has\s*\(/g
        )) {
          readers.push(full);
        }
      }
    };
    walk(srcDir);
    // Floor first: a walk that stopped seeing `src/` would make the equality
    // below hold at zero against a table that also could not be found.
    expect(readers.length).toBeGreaterThanOrEqual(5);
    expect(readers.map((f) => f.slice(repoRoot.length + 1)).sort()).toEqual([
      'src/cli/commands/recreate-confirm-prompt.ts',
      'src/deployment/deploy-engine.ts',
      'src/deployment/deploy-engine.ts',
      'src/deployment/recreate-targets.ts',
      'src/deployment/rollback-executor.ts',
    ]);

    // Scoped to the table that FOLLOWS the sentence, not the whole page: a row
    // counted from anywhere in the document would make the assertion agree by
    // accident.
    const marker = 'Every path that consults this guard:';
    expect(doc).toContain(marker);
    const afterMarker = doc.slice(doc.indexOf(marker) + marker.length);
    const table = afterMarker.slice(0, afterMarker.indexOf('\n#'));
    const rows = table.split('\n').filter((line) => line.startsWith('| ') && line.includes(' | '));
    // Header row + separator row + one row per documented path.
    expect(rows).toHaveLength(2 + 5);
  });
});
