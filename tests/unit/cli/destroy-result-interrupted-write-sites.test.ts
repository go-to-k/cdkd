import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #2117 — every write to the PER-STACK interrupt owner must be accounted
 * for, mechanically.
 *
 * ## Why this file exists
 *
 * `DestroyRunnerResult.interrupted` is the one per-stack answer to "did THIS
 * stack finish, or is there work left in it?", and FOUR consumers read it:
 * the stack's state preservation, its summary line, `destroy.ts`'s
 * `--purge-events` skip, and `NestedStackProvider.delete`'s
 * `{ outcome: 'skipped' }` / `markNonRetryable` decision for a child row.
 *
 * The fix for #2117 took THREE review rounds, and all three failed the same
 * way — a human enumerated the write sites and the enumeration was short:
 *
 *   - round 1 fixed `destroy.ts` and missed the runner's outer re-sync;
 *   - round 2 gated the re-sync on `statePreserved` and missed the
 *     `resourceCount === 0` early-return branch, ~950 lines ABOVE it and
 *     outside the `try`/`finally` that carries the gate;
 *   - the repo's own GREEN test pinned the wrong invariant at that branch, so
 *     nothing was red while the defect shipped.
 *
 * The lesson is not "enumerate more carefully" — that is exactly what was
 * tried twice. It is that the enumeration has to stop being a human act. This
 * file DERIVES the population from the source and fails on any write it does
 * not recognize, so a new one is a red test naming the offending line instead
 * of a fourth review round. Its limits are stated below rather than implied
 * away.
 *
 * ## Why the needle is structural rather than a name
 *
 * Matching the literal `result.interrupted` would be dodged by the most likely
 * future edit of all: renaming the local (`runResult`, `out`, `stackResult`).
 * The pattern therefore matches `<any identifier>.interrupted` followed by an
 * assignment operator — `=`, `||=`, `??=`, `&&=` — with `==` / `===`
 * excluded so a comparison is never read as a write. It also matches the three
 * spellings that dodge the dot form entirely, each measured GREEN against the
 * first cut before being added: a computed member (`x['interrupted'] =`),
 * `Object.assign(result, { interrupted })`, and an object literal — which
 * covers both a fresh result and a spread rebuild (`{ ...result, interrupted:
 * true }`). That last one is the shape most likely to appear next, because
 * every missed round so far added a new EARLY RETURN rather than a new
 * assignment.
 *
 * ## What it still does NOT catch — stated rather than implied
 *
 * A write whose receiver and property are split across lines is invisible to a
 * line-based scan. That is accepted rather than fixed: `vp run format`
 * collapses it back to the matched form, so it cannot survive a formatted
 * commit. Anything reaching the field through a dynamically-built key, or
 * through a helper in a file that neither names `DestroyRunnerResult` nor
 * calls `runDestroyForStack`, is also out of reach. The claim this file earns
 * is "every write spelled the way this repo spells writes is enumerated", not
 * "a missed site is impossible" — an earlier revision of this header said the
 * stronger thing, and a reviewer measured four spellings that falsified it.
 *
 * ## Both floors are load-bearing
 *
 * A scan that silently stops matching reports "no offenders", which is
 * indistinguishable from "everything is gated" — the same vacuous pass the
 * defect above hid behind. So this file asserts a floor on the POPULATION
 * (the constructing files were actually found and read) AND on the FIND COUNT
 * (the needle can still see the writes that exist), and pins the needle
 * against every spelling directly. Probed in both directions before landing:
 * a stray ungated write fails the allow-list assertion, and a needle broken to
 * match nothing fails the count floor.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The file that owns the type and, today, is its only constructor. */
const OWNER_FILE = 'src/cli/commands/destroy-runner.ts';

/**
 * A write to `<something>.interrupted`.
 *
 * `=(?!=)` is what keeps `===` / `==` out; `||=` / `??=` / `&&=` are listed
 * explicitly because each is a real way to publish this flag and `||=` is the
 * exact spelling both defective revisions used.
 */
const WRITE = new RegExp(
  [
    // `x.interrupted =` / `||=` / `??=` / `&&=` (equality operators excluded).
    String.raw`\b[A-Za-z_$][\w$]*\.interrupted\s*(?:\|\|=|\?\?=|&&=|=(?!=))`,
    // `x['interrupted'] =` -- a computed member dodges the dot form entirely.
    String.raw`\[\s*['\"\`]interrupted['\"\`]\s*\]\s*(?:\|\|=|\?\?=|&&=|=(?!=))`,
    // `Object.assign(result, { interrupted: ... })`.
    String.raw`Object\.assign\s*\([^)]*\binterrupted\s*:`,
    // An object literal setting the field: a fresh result, or a spread
    // rebuild (`return { ...result, interrupted: true }`). This is the
    // shape most likely to appear next, because every missed round so far
    // added a new EARLY RETURN rather than a new assignment.
    //
    // The negative lookahead drops TYPE positions -- an interface member
    // (`interrupted: boolean;`) and a parameter annotation are not writes,
    // and listing them would bury the real sites in the allow-list.
    String.raw`\binterrupted\??\s*:(?!\s*(?:boolean|undefined)\b)`,
  ].join('|')
);

/**
 * Every write site that is allowed to exist, with the reason it is correct.
 *
 * Matching is on the STATEMENT text with whitespace collapsed, so reindenting
 * does not break the fence but changing what is assigned does. A new entry
 * here is a deliberate act that has to state its own rationale — which is the
 * step the three failed rounds skipped.
 */
const ALLOWED: Array<{ statement: string; rationale: string }> = [
  {
    statement: 'result.interrupted = draining;',
    rationale:
      'The authoritative in-`try` read, taken AFTER the level loop so a signal ' +
      'that arrived while the final level drained is still observed. This is ' +
      'the assignment; everything else may only ever turn false into true.',
  },
  {
    statement: 'result.interrupted ||= draining && statePreserved;',
    rationale:
      'The outer `finally` re-sync, for a signal landing after the in-`try` ' +
      'read (renderer teardown / state flush / lock release). `&& statePreserved` ' +
      'is mandatory: ungated it reported `interrupted` over a stack whose state ' +
      'file was already DELETED, so the caller exited 2 with "State preserved -- ' +
      're-run" over a completed destroy. `||=` keeps the in-`try` read ' +
      'authoritative for every earlier signal.',
  },
  {
    statement: 'interrupted: false,',
    rationale:
      "The result INITIALISER in the runner. Not a publication -- it is the " +
      'field being brought into existence false, before any signal can have ' +
      'been observed. Flipping it to `true` would be a publication, and ' +
      'changing the assigned value drops this entry so the fence reds.',
  },
  {
    statement: 'interrupted: stackInterrupted || stackCancelled,',
    rationale:
      'A READ of the per-stack owner passed as an argument to ' +
      '`purgeEventsAfterDestroy`, not a write to it. Listed because the ' +
      'population is derived from a relation the write cannot omit, which ' +
      'necessarily admits reads too. `|| stackCancelled` is load-bearing: ' +
      'without it, declining the per-stack prompt purged the event history of ' +
      'a stack that still exists.',
  },
  {
    statement: 'this.interrupted = false;',
    rationale:
      "A DIFFERENT owner: `DeployEngine`'s own instance field, which answers " +
      '"was this engine run interrupted" and never reaches a ' +
      '`DestroyRunnerResult`. In the population only because the file also ' +
      'names the runner result type.',
  },
  {
    statement: 'this.interrupted = true;',
    rationale:
      "Same different owner as above (`DeployEngine`'s instance field); three " +
      'sites share this statement text.',
  },
  {
    statement: 'interrupted: (): boolean => interrupted,',
    rationale:
      "A GETTER on the command-level watch's returned handle, exposing the " +
      'per-RUN flag. A different scope from the per-stack owner and never ' +
      'assigned through this expression.',
  },
];

/**
 * Files that construct or return a `DestroyRunnerResult`.
 *
 * Derived rather than hard-coded so a SECOND constructor added anywhere under
 * `src/` is scanned automatically — the failure mode being fenced is a write
 * site nobody thought to look for, and a hand list reproduces exactly that.
 *
 * The pathspec is the pair `'src/*.ts' 'src/**\/*.ts'`. Under git PATHSPEC
 * (unlike a shell glob) `*` already crosses `/`, so the first alone matches
 * everything; the `**` form is kept so the intent reads as "top-level plus
 * nested" — and the population floor below fails loudly if either stops
 * matching.
 */
function constructingFiles(): string[] {
  const all = execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
  // Population = files that could HOLD a `DestroyRunnerResult`, derived from a
  // relation a write cannot omit rather than from a spelling it can.
  //
  // The first cut filtered on the TYPE ANNOTATION (`: DestroyRunnerResult` /
  // `<DestroyRunnerResult>`) and collapsed to ONE file, because `destroy.ts`
  // and `nested-stack-provider.ts` hold the object as INFERRED locals.
  // Measured 2026-08-26: planting `result.interrupted = true;` in `destroy.ts`
  // -- the site of this PR's own round-1 blocker -- left the fence 4/4 GREEN.
  // A population derived from an omittable spelling is exactly the failure
  // this file exists to end.
  //
  // A file that writes this owner must have OBTAINED the object, and there are
  // only two ways: construct it (the runner) or receive it from
  // `runDestroyForStack`. Neither can be omitted by the write. Scoping on the
  // FIELD NAME alone was tried and rejected the other way -- it pulls in
  // `RollbackReplayResult`, `deploy-engine`'s own `this.interrupted` and
  // `interrupt-watch`'s live watches, which are different types, so the
  // allow-list would fence a much broader class than the defect and fire on
  // unrelated subsystems.
  return all.filter((rel) => {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf-8');
    return /\bDestroyRunnerResult\b|\brunDestroyForStack\b/.test(src);
  });
}

/** Every `.interrupted` write in `rel`, as `{line, statement}`. */
function writeSites(rel: string): Array<{ line: number; statement: string }> {
  const sites: Array<{ line: number; statement: string }> = [];
  const lines = readFileSync(join(REPO_ROOT, rel), 'utf-8').split('\n');
  lines.forEach((raw, i) => {
    // Comments describe writes constantly in this file (the rationale for the
    // deleted third site is a 20-line comment mentioning `result.interrupted
    // ||= emptyInterrupted`), so a comment line is never a site.
    const code = raw
      .replace(/\/\*.*?\*\//g, '')
      .replace(/\/\/.*$/, '')
      .replace(/^\s*\*.*$/, '');
    if (!WRITE.test(code)) return;
    sites.push({ line: i + 1, statement: code.trim().replace(/\s+/g, ' ') });
  });
  return sites;
}

describe('DestroyRunnerResult.interrupted write sites are enumerated mechanically (issue #2117)', () => {
  it('has every write accounted for by an allow-list entry', () => {
    const files = constructingFiles();
    // POPULATION floor: a broken pathspec, or a type-detection regex that
    // stopped matching, would otherwise report a clean tree.
    expect(files).toContain(OWNER_FILE);
    // ...and the two CONSUMER files whose absence was the actual hole. A floor
    // naming only the owner is satisfied by the very file a narrowed
    // derivation collapses to: measured 2026-08-26, replacing the pathspec
    // with the literal `destroy-runner.ts` left the fence 4/4 GREEN. These two
    // are what a collapse drops first, so they are what the floor must name.
    expect(files).toContain('src/cli/commands/destroy.ts');
    expect(files).toContain('src/provisioning/providers/nested-stack-provider.ts');

    const found = files.flatMap((rel) =>
      writeSites(rel).map((s) => ({ ...s, rel }))
    );

    // FIND-COUNT floor: proves the needle can still see the writes that exist.
    // Two today; a fix that legitimately adds one raises this WITH its
    // allow-list entry, so the two can never drift apart silently.
    expect(found.length).toBeGreaterThanOrEqual(2);

    const allowed = new Set(ALLOWED.map((a) => a.statement));
    const offenders = found
      .filter((s) => !allowed.has(s.statement))
      .map((s) => `${s.rel}:${s.line}  ${s.statement}`);

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'Unaccounted write(s) to the PER-STACK interrupt owner.\n' +
            'This flag answers "is there work left in THIS stack?", and four ' +
            'consumers read it (state preservation, the summary line, ' +
            "destroy.ts's --purge-events skip, and NestedStackProvider.delete).\n" +
            'Route the write through the gated re-sync in the outer `finally`, ' +
            'or add an entry to ALLOWED in this file stating why the new site ' +
            'is correct. In particular a write on a path that has DELETED the ' +
            'state record is never correct -- there is no work left to report.\n' +
            `Offenders:\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('every allow-list entry still corresponds to a real site', () => {
    // The reverse direction: an entry left behind after its site was deleted
    // would silently pre-approve a future re-introduction of exactly the
    // statement that was removed. The round-2 defect
    // (`result.interrupted ||= emptyInterrupted`) is precisely such a
    // statement, so a stale entry here is not a hypothetical risk.
    const present = new Set(
      constructingFiles().flatMap((rel) => writeSites(rel).map((s) => s.statement))
    );
    for (const entry of ALLOWED) {
      expect(present, `allow-list entry no longer matches any site: ${entry.statement}`).toContain(
        entry.statement
      );
    }
  });

  it('every allow-list entry carries a rationale', () => {
    // A bare statement with no reason is how an entry gets added to silence a
    // red test rather than to record a decision.
    for (const entry of ALLOWED) {
      expect(entry.rationale.length, `no rationale for: ${entry.statement}`).toBeGreaterThan(40);
    }
  });

  it('matches every assignment spelling, and no comparison', () => {
    // The needle is this fence's discriminator, so it is asserted directly
    // rather than trusted. `||=` is the spelling BOTH defective revisions
    // used, and a rename of the local is the likeliest future edit — so the
    // renamed forms are pinned too.
    for (const write of [
      'result.interrupted = draining;',
      'result.interrupted ||= draining && statePreserved;',
      'result.interrupted ??= x;',
      'result.interrupted &&= x;',
      'runResult.interrupted = true;',
      'out.interrupted ||= emptyInterrupted;',
    ]) {
      expect(write, `should be seen as a write: ${write}`).toMatch(WRITE);
    }
    for (const notAWrite of [
      'if (result.interrupted === true) {',
      'if (result.interrupted == true) {',
      'const x = result.interrupted;',
      'if (childResult.interrupted) causes.push(1);',
    ]) {
      expect(WRITE.test(notAWrite), `should NOT be seen as a write: ${notAWrite}`).toBe(false);
    }
  });
});
