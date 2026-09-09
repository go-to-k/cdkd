import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Issue [#2828](https://github.com/go-to-k/cdkd/issues/2828) was the SECOND
 * instance of one class, after issue
 * [#1926](https://github.com/go-to-k/cdkd/issues/1926): a live-AWS readback
 * assigned onto `ResourceState.observedProperties` without passing through
 * `redactSecretsForState`, so a resource deployed from a
 * `{{resolve:secretsmanager:...}}` reference persisted its DECRYPTED value into
 * `state.json` (the GHSA-p5qg-v9gv-hc7w disclosure direction).
 *
 * WHY A SWEEP MISSED IT, which is what this file exists to make impossible a
 * third time. The #1926 sweep was framed as "every WRITER passes a position
 * source" and was executed by finding CALLERS of `secret-redaction.ts`.
 * `src/cli/commands/import.ts` already had one — `resolveImportedProperties`
 * redacts the sibling `properties` bag — so the file read as covered while its
 * SECOND writer, `captureObservedForImportedResources`, leaked. A
 * module-caller sweep cannot see a second writer inside a file that already
 * calls the module; only enumerating the WRITE SITES of the field can.
 *
 * So this file enumerates them. Two assertions, and they fail on different
 * regressions:
 *
 *  1. POPULATION — every site is listed below with a reason, in both
 *     directions, plus a literal total. A NEW write site anywhere in `src/`
 *     reds this with a diff naming the file, whatever its RHS.
 *  2. SHAPE — every ASSIGNMENT-form site (`<expr>.observedProperties = ...`)
 *     must have `redactSecretsForState(` as its right-hand side, unless it is
 *     in {@link UNREDACTED_AT_SITE} with a reason. This is the one that would
 *     have caught #2828 on the day it was written.
 *
 * WHAT THIS DOES NOT PROVE: that a listed site redacts CORRECTLY — the right
 * secrets map, the right position source, the right `PathSourceRules`. Those
 * are per-site questions fenced by each site's own suite
 * (`tests/unit/cli/import.test.ts`'s `observedProperties redaction` block,
 * `tests/unit/cli/state-refresh-observed.test.ts`, the deploy engine's persist
 * tests). This file only fences the POPULATION and the call SHAPE — the same
 * split `tests/unit/cli/readline-prompt-population.test.ts` makes, which is
 * the fence this one is modelled on.
 *
 * CALIBRATION, measured 2026-09-09 against the PRE-FIX tree
 * (`git show origin/main:<path>` at `93592cf1`) with the regex below: **11
 * sites across 7 files**, identical to the post-fix count — the fix changed a
 * site's RHS, it did not add or remove one. Of the four ASSIGNMENT-form sites
 * there, exactly TWO had a bare RHS: `src/cli/commands/import.ts` (the defect)
 * and `src/deployment/deploy-engine.ts` (the legitimate allow-list entry). So
 * assertion 2 with the allow-list as written goes RED on the pre-fix tree
 * naming `src/cli/commands/import.ts` and nothing else, which is the
 * calibration a scanner fence owes before it is trusted.
 *
 * The pattern is a NEEDLE with a COMMENT-LINE exclusion rather than a comment
 * STRIPPER — a stripper being the fragile part of every scanner fence this
 * repo has written. It refuses a line whose first non-blank characters are `*`
 * or `//`, which is what keeps the ~120 prose mentions of the field across
 * `src/provisioning/providers/**` from counting as sites.
 *
 * KNOWN HOLES, stated rather than overstated, because a fence whose comment
 * overstates its coverage is worse than a narrower honest one:
 *
 *  - A write through a computed key (`record['observed' + 'Properties'] = x`),
 *    a spread that carries the field from another bag
 *    (`{ ...someBagHoldingIt }`), or the shorthand `{ ...rec, observedProperties }`
 *    puts no occurrence of the identifier in a value-carrying position at the
 *    write site and is invisible here. Closing that needs an AST fence that
 *    follows the binding, which this deliberately is not. The logical
 *    assignments (`??=` / `||=` / `&&=`) WERE in this list and are not any
 *    more — a review probe found them evading both regexes, and both now
 *    accept them.
 *  - `ResourceState.attributes` is OUT OF SCOPE, and the reason is a decision
 *    rather than an absence of risk. It is the other bag the import path
 *    persists from a live AWS read (`provider.import()`) and it passes through
 *    no redactor there. Across the `import()` implementations under
 *    `src/provisioning/providers/**` the returned keys are ARNs, ids, names,
 *    endpoints, timestamps and states — `IAMAccessKeyProvider.import` returns
 *    `{Id}` only, never the secret. TWO exceptions, both found by a reviewer
 *    re-deriving an earlier revision of this bullet that claimed the
 *    enumeration was clean, and both left in scope for the follow-up rather
 *    than waved at: `src/provisioning/cloud-control-provider.ts` — which this
 *    glob does not even cover — returns the WHOLE parsed Cloud Control
 *    `ResourceModel` as `attributes`, uncurated, and `cdkd import` reaches it
 *    for any Cloud-Control-routed type; and `AppSyncProvider.import` returns
 *    `{ApiKey, Arn}` for `AWS::AppSync::ApiKey`, which IS a credential, though
 *    a bounded one — it is split out of a physical id state persists anyway.
 *    Fencing this bag means calibrating a second population with its own
 *    allow-list over a wider glob, and neither mechanism `redactSecretsForState`
 *    offers applies directly (no secrets map and no template counterpart to
 *    position against on this path). Tracked as its own issue,
 *    [#2847](https://github.com/go-to-k/cdkd/issues/2847).
 *  - The SHAPE assertion reads one LINE. A site spelled
 *    `record.observedProperties =` with the call on the next line would read as
 *    bare — the safe direction (a false RED naming the file), and no such
 *    spelling exists today.
 *  - A `:`-form site is not shape-checked at all, only counted, because the
 *    object-literal writers in `drift.ts` build their bag in a named variable
 *    on an earlier line. Those two are covered by `drift.ts`'s own suite; what
 *    this file guarantees for them is that a THIRD one cannot appear unlisted.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * An occurrence of `observedProperties` in a value-carrying position on a
 * non-comment line: either an ASSIGNMENT (`= `, never `==`) or an
 * object-literal / destructuring KEY (`: `).
 *
 * The optional-property declarations in `src/types/state.ts`
 * (`observedProperties?: Record<...>`) are excluded by `[ \t]*` alone, which
 * refuses the `?` between the name and the colon. An earlier revision also
 * carried a `(?<!\?)` lookbehind and this comment credited it with that
 * exclusion; a reviewer measured it inert — the lookbehind inspects the
 * character before the WHITESPACE RUN, which is always the `s` of
 * `observedProperties` — and removing it left the population at an identical
 * 11 across 7 files. Removed rather than kept, because a construct that
 * appears to do the excluding is what stops the next reader from checking
 * whether anything actually does.
 *
 * The lookbehind is `(?<![\w$])` rather than `(?<![\w.$])`: a member access
 * (`resource.observedProperties`) is exactly the shape being hunted, so the
 * dot must be ALLOWED, while `foo.myObservedProperties` stays blocked by the
 * word character before it.
 *
 * `m` (not `s`) so `.` cannot cross lines and `^` means line-start; at most
 * one match per line, which is the granularity the counts below assume.
 *
 * The separators are `[ \t]*`, NOT `\s*`, and that was a measured correction
 * rather than a style choice: `\s` matches a NEWLINE, so the first draft read
 * `drift.ts`'s wrapped ternary
 * (`? existing.observedProperties` / `: existing.properties` on two lines) as
 * a key. Re-measured on `93592cf1` and on HEAD after a reviewer refuted the
 * first number written here: the `\s*` draft yields **12** sites (`drift.ts`
 * 4), the corrected pattern **11**. The wrong figure sat in this paragraph for
 * one round, which is the argument for re-deriving a number rather than
 * recalling it.
 */
const OBSERVED_WRITE_SOURCE = String.raw`^(?![ \t]*(?:\*|\/\/)).*?(?<![\w$])observedProperties(?:[ \t]*(?:\?\?|\|\||&&)?=(?!=)|[ \t]*:)`;
const OBSERVED_WRITE_LINE = new RegExp(OBSERVED_WRITE_SOURCE);
const OBSERVED_WRITE_ALL = new RegExp(OBSERVED_WRITE_SOURCE, 'gm');

/**
 * The ASSIGNMENT half of the population — the subset assertion 2 shape-checks.
 * The logical-assignment alternatives (`??=` / `||=` / `&&=`) are here for the
 * same reason they are in the pattern above: a review probe showed
 * `resource.observedProperties ??= observed;` matched NEITHER regex, so it was
 * invisible to both assertions — a new writer in the spelling a future
 * contributor is most likely to reach for.
 */
const OBSERVED_ASSIGNMENT = /(?<![\w$])observedProperties[ \t]*(?:\?\?|\|\||&&)?=(?!=)/;

/** `path -> { sites, why }`. The COUNT is part of the contract, not just the file. */
const EXPECTED: Readonly<Record<string, { readonly sites: number; readonly why: string }>> = {
  'src/cli/commands/import.ts': {
    sites: 1,
    why:
      "`captureObservedForImportedResources` — the issue #2828 site. Serves BOTH " +
      'import call sites (the root walk and the recursive ' +
      '`--migrate-from-cloudformation` child walk), which is why one row covers two.',
  },
  'src/cli/commands/state.ts': {
    sites: 1,
    why: '`cdkd state refresh-observed` — the issue #1926 site, the first of this class.',
  },
  'src/deployment/secret-redaction.ts': {
    sites: 1,
    why:
      '`scrubResourceRecord` — the redactor itself, shared by the deploy persist ' +
      'choke point and `cdkd scrub`. Redacts by construction.',
  },
  'src/deployment/deploy-engine.ts': {
    sites: 1,
    why:
      '`drainObservedCaptures` — the one ASSIGNMENT site that legitimately does NOT ' +
      'redact at the call site; see UNREDACTED_AT_SITE below.',
  },
  'src/cli/commands/drift.ts': {
    sites: 3,
    why:
      "Two `:`-form WRITES — `--accept`'s new baseline (redacted into " +
      '`redactedBaseline` one statement earlier) and the issue #1644 revert ' +
      'narrowing (redacted into `delta` before it reaches `newBaseline`) — plus ' +
      'one `:`-form READ, the ternary picking the revert baseline, which the ' +
      'pattern cannot tell from a key and which is listed rather than excused by ' +
      'a cleverer regex.',
  },
  'src/deployment/rollback-executor.ts': {
    sites: 1,
    why:
      'NOT a write: the destructuring rename that STRIPS `observedProperties` off a ' +
      'previous-generation record before a reverse-replacement replay re-adopts it.',
  },
  'src/provisioning/stateful-types.ts': {
    sites: 3,
    why:
      'NOT writes: three PARAMETER declarations on the stateful-recreate predicates, ' +
      'which read the bag and never build one. They match because a parameter is ' +
      'spelled `name: Type` like an object-literal key.',
  },
};

/**
 * The ASSIGNMENT-form sites permitted to have a bare RHS, each with the reason
 * the redaction happens elsewhere. Keeping this to ONE entry is the point: an
 * addition here is the exact edit that would reopen #2828, and it should be
 * hard to make without noticing.
 */
const UNREDACTED_AT_SITE: Readonly<Record<string, string>> = {
  'src/deployment/deploy-engine.ts':
    'The deploy path redacts at its single persist CHOKE POINT — every ' +
    '`stateBackend.saveState` in the engine goes through `withParentInfo` -> ' +
    '`redactStateForPersist` -> `scrubResourceRecord`, which covers `properties` / ' +
    '`attributes` / `observedProperties` uniformly across create / update / ' +
    'replacement / rollback / observed-capture. Redacting again here would be ' +
    'redundant, and — unlike import, which has no such choke point — the engine ' +
    'cannot persist an unredacted record at all.',
};

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function posixPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function scanPopulation(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walkTsFiles(SRC_ROOT)) {
    const matches = readFileSync(file, 'utf-8').match(OBSERVED_WRITE_ALL);
    if (matches && matches.length > 0) {
      found[posixPath(file)] = matches.length;
    }
  }
  return found;
}

/** Every assignment-form site as `path:line -> the line's text`. */
function scanAssignments(): Array<{ path: string; line: number; text: string }> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  for (const file of walkTsFiles(SRC_ROOT)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((text, i) => {
      if (OBSERVED_WRITE_LINE.test(text) && OBSERVED_ASSIGNMENT.test(text)) {
        out.push({ path: posixPath(file), line: i + 1, text: text.trim() });
      }
    });
  }
  return out;
}

describe('observedProperties write population (issue #2828)', () => {
  it('every write site in src/ is listed here with a reason', () => {
    const actual = scanPopulation();
    const expectedCounts = Object.fromEntries(
      Object.entries(EXPECTED).map(([path, entry]) => [path, entry.sites])
    );

    // `toEqual` in BOTH directions on purpose: an unlisted site is a writer
    // nobody has audited, and a listed site that vanished means this table
    // documents something that no longer exists.
    expect(actual).toEqual(expectedCounts);
  });

  it('holds LITERAL totals, so the table shrinking is visible on its own', () => {
    // Literals rather than sums over `EXPECTED`: a floor computed from the pool
    // it guards moves with the pool, so deleting rows would keep a derived
    // comparison green. 11 across 7 files = the 2026-09-09 measurement in the
    // header, taken identically on the pre-fix and post-fix trees.
    const actual = scanPopulation();
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(11);
    expect(Object.keys(EXPECTED)).toHaveLength(7);
  });

  it('every ASSIGNMENT-form site redacts at the call site, or is allow-listed', () => {
    const assignments = scanAssignments();

    // INERTNESS floor first, then the per-site loop, then the exact count.
    // The order is deliberate and was a review finding: with the exact `toBe(4)`
    // ahead of the loop, a contributor adding a new BARE writer — the very
    // class this fence exists to catch — got `expected 5 to be 4` instead of
    // the message naming their file and telling them what to do. A bare
    // non-zero floor still catches a scan that stopped matching, which is all
    // the pre-loop position needs to do.
    expect(assignments.length, 'the assignment scan found nothing — it is inert').toBeGreaterThan(
      0
    );

    for (const { path, line, text } of assignments) {
      if (path in UNREDACTED_AT_SITE) continue;
      expect(
        /observedProperties[ \t]*(?:\?\?|\|\||&&)?=[ \t]*redactSecretsForState\(/.test(text),
        `${path}:${line} assigns observedProperties without redactSecretsForState — ` +
          'this is the issue #2828 / #1926 class. Redact at the site, or add an ' +
          'UNREDACTED_AT_SITE entry naming where the redaction actually happens.'
      ).toBe(true);
    }

    // The exact count LAST, as a literal: it still pins the population, but a
    // new bare writer now reports itself through the loop above rather than
    // through an arithmetic mismatch here.
    expect(assignments.length).toBe(4);
  });

  it('the allow-list stays at exactly one entry, and names a file that still exists', () => {
    // The allow-list is the fence's own escape hatch, so it gets a cap. Growing
    // it is the edit that reopens the class, and a cap makes that edit red here
    // rather than silent.
    expect(Object.keys(UNREDACTED_AT_SITE)).toEqual(['src/deployment/deploy-engine.ts']);
    // ...and the reason it gives must still be TRUE: the engine's persist choke
    // point is what makes the bare assignment safe, so assert the choke point
    // is still wired rather than trusting the paragraph.
    const engine = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine.ts'), 'utf-8');
    expect(engine).toContain('this.redactStateForPersist(state)');
    expect(engine).toContain('scrubResourceRecord');
  });
});
