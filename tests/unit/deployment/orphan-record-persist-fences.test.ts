/**
 * Two fences for `StackState.orphans` (issue #2934), both for defects that fail
 * SILENTLY and both of which actually landed before these existed.
 *
 * 1. REDACTION. The record carries a whole `ResourceState`, and it sits on a
 *    TOP-LEVEL field — which `redactStateForPersist` reaches only through its
 *    `...state` spread, i.e. untouched. The automatic rollback captures the
 *    record from the in-memory map, which holds REAL resolved values by design,
 *    so a missing arm writes secret plaintext into `state.json`: the
 *    GHSA-p5qg-v9gv-hc7w class, one field over.
 *
 * 2. CARRY-THROUGH. Every `StackState` literal in the engine enumerates its
 *    fields, so a save that forgets `orphans` does not lose a hint — it makes a
 *    live, billing AWS resource untrackable and re-opens the deploy loop the
 *    record closes. Two of the eight literals were missed on the first pass
 *    (the no-change refresh and the success-path return), and nothing was
 *    watching: the whole suite stayed green.
 *
 * Both are checked as SOURCE-SHAPE properties rather than through a driven
 * deploy. That is a deliberate trade with a stated cost: a shape test cannot
 * prove the field arrives correct at runtime, only that no literal omits the
 * carry and that the redactor names the field. It is what makes the fence
 * exhaustive over every literal — including ones added later, which is the
 * direction this defect keeps arriving from — where a behavioural test covers
 * only the paths someone thought to drive. `orphan-adoption.test.ts` and
 * `rollback-executor-orphan-record.test.ts` carry the behaviour.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(
  new URL('../../../src/deployment/deploy-engine.ts', import.meta.url)
);
const source = readFileSync(ENGINE, 'utf8');

describe('orphans redaction fence (#2934)', () => {
  it('redactStateForPersist names the orphans field', () => {
    // Anchored on the function body, not the whole file: a mention anywhere
    // else — a comment, an unrelated helper — would satisfy a bare
    // `source.includes`, which is how a fence stops discriminating.
    const start = source.indexOf('private redactStateForPersist(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  }', start));
    expect(body).toContain('state.orphans');
  });

  it('scrubs each record with the same helper that scrubs `resources`', () => {
    const start = source.indexOf('private redactStateForPersist(');
    const body = source.slice(start, source.indexOf('\n  }', start));
    // `scrubResourceRecord` is what applies the secret needles. Reaching the
    // field but copying it verbatim would pass the case above and still leak,
    // so the fence names the call, not just the field.
    const orphanArm = body.slice(body.indexOf('state.orphans'));
    expect(orphanArm).toContain('scrubResourceRecord');
  });

  it('keys the needles on what the deploy RESOLVED, not on `state.resources`', () => {
    const start = source.indexOf('private redactStateForPersist(');
    const body = source.slice(start, source.indexOf('\n  }', start));
    const orphanArm = body.slice(body.indexOf('state.orphans'));

    // An orphan is BY DEFINITION absent from `resources` — that is what makes
    // it an orphan. Gating the needle lookup on `state.resources[...]` therefore
    // reads false for the record being MINTED, the needles go empty,
    // `scrubResourceRecord` returns identity, and the plaintext survives into
    // `state.json`. That exact regression shipped and was caught only by the
    // real-AWS secret fixture, which is not CI.
    expect(orphanArm).not.toContain('state.resources[entry.logicalId]');
    expect(orphanArm).toContain('perResourceResolvedType');
  });
});

describe('orphans carry-through fence (#2934)', () => {
  /**
   * Every `StackState` literal in the engine that enumerates its fields.
   *
   * Found by SHAPE rather than listed: a hand-list is exactly what missed two
   * of them. A literal is enumerating iff it declares `version:` — the field no
   * spread-form writer restates.
   */
  function enumeratingLiterals(): string[] {
    const out: string[] = [];
    // Anchor on the FIELD, not on `return {` / `: StackState = {`. Anchoring on
    // the opener was the first attempt and it flagged four literals that were
    // fine: a spread-form return carries unknown fields automatically, and one
    // match was not a `StackState` at all — the scan for the closing
    // `lastModified:` ran past the end of a small helper's return and dragged in
    // the next literal's fields. Starting at `version:` and stopping at the
    // `lastModified:` that follows it bounds the slice to one field list.
    const marker = 'version: STATE_SCHEMA_VERSION_CURRENT';
    let from = source.indexOf(marker);
    while (from !== -1) {
      const end = source.indexOf('lastModified:', from);
      if (end !== -1) {
        const body = source.slice(from, end);
        // A persisted stack record always enumerates its resources; a literal
        // that only stamps a version (a migration shim, a test double) is not
        // a save and has nothing to carry.
        //
        // `resources: {}` is excluded on the same principle rather than as an
        // exception: that is the SEED for a stack with no state at all
        // (`currentStateData?.state ?? {...}`), so there is no previous record
        // to carry anything FROM. Keying on the empty literal — not on a line
        // number or a name — means a second seed written later is excluded too,
        // and a save that starts carrying an empty map would correctly still be
        // required to spread the helper.
        if (body.includes('resources:') && !/resources:\s*\{\}/.test(body)) out.push(body);
      }
      from = source.indexOf(marker, from + marker.length);
    }
    return out;
  }

  it('finds every enumerating literal — derived, not a guessed floor', () => {
    // Compared against the population the scan draws FROM, not a hand-picked
    // number. A floor one below the truth (this said `>= 6` against an actual
    // 7) lets exactly one save literal drop out of the set — a renamed import
    // at one site would do it — and the carry assertion below then silently
    // stops covering it, which is the failure this fence exists to prevent.
    const versionSites = source.split('version: STATE_SCHEMA_VERSION_CURRENT').length - 1;
    const seeds = (source.match(/resources:\s*\{\}/g) ?? []).length;
    expect(enumeratingLiterals().length).toBe(versionSites - seeds);
    // And it is not vacuously zero on both sides.
    expect(enumeratingLiterals().length).toBeGreaterThan(0);
  });

  it('every enumerating literal carries `orphans` forward', () => {
    const missing = enumeratingLiterals().filter(
      (body) => !body.includes('orphansCarriedFrom') && !body.includes('orphansAfterRollback')
    );
    // The message names the offender's first line, so a failure points at the
    // literal rather than at a count.
    expect(
      missing.map((b) => b.split('\n').slice(0, 2).join(' ').trim()),
      'a StackState literal that drops `orphans` makes a live, billing AWS resource untrackable'
    ).toEqual([]);
  });

  it('the no-change save is triggered by an orphans change', () => {
    // The other half of the same defect: carrying the field is useless if the
    // save that would write it never runs. Adoption trips none of the original
    // triggers, so an entirely clean diff persisted neither the spliced-in
    // resource nor the consumed record.
    const gate = source.slice(
      source.indexOf('if (\n            observedRefresh ||'),
      source.indexOf('const refreshedState: StackState = {')
    );
    expect(gate).toContain('orphansChanged');
  });
});
