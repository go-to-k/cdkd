import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * `drift.ts`'s `resolveDriftLeafByRegion` is a DELIBERATE second implementation
 * of `rollback-executor.ts`'s `resolveLeafByRegion` (issue
 * [#2108](https://github.com/go-to-k/cdkd/issues/2108), mirroring issue #2057).
 * This is the repo's convention for that situation — a test that READS the
 * sibling source and asserts the mirrored semantics, the same shape
 * `secret-redaction-dynamic-reference-pattern.test.ts` uses for the token
 * pattern and `outputs-diff.test.ts` for its `deploy-engine.ts` twin.
 *
 * WHY A SECOND IMPLEMENTATION AT ALL, rather than an export. The two walks
 * differ only in where their evidence comes from (a required
 * `RollbackExecutorContext` versus two explicit arguments) and in the wording of
 * their two refusals, each of which names its own command. What is genuinely
 * SHARED — `classifyReplaySecretRegion`, the verdict type, the token scan — is
 * imported by both, so the duplication is ~25 lines of control flow around it.
 *
 * WHAT DRIFTS is exactly that control flow, and silently: the refuse-first
 * ordering (refusing only AFTER a token is fetched leaves half a credential
 * fetched, cached, and recorded as a redaction needle for an op about to be
 * refused), the whole-leaf fast path, the moving `indexOf` cursor, and the
 * fail-closed `at < 0` arm. None of it has a shared symbol to hang a type error
 * on, so a change on either side is invisible to the other.
 *
 * The fence therefore states the GOOD condition positively — THE TWO BODIES ARE
 * THE SAME PROGRAM — rather than enumerating divergences to forbid, which is
 * the shape that loses the race (a new bad spelling is always available). Two
 * differences are declared and normalized away, and nothing else is:
 *
 *   1. the identifiers listed in `ALIASES`, and
 *   2. every `throw` statement, elided wholesale, because each carries a
 *      command-specific message and error code.
 *
 * Anything else — a reordered guard, a dropped `cursor` argument, a fast path
 * that stops being taken — reds this test on whichever side moved.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const DRIFT_SOURCE = 'src/cli/commands/drift.ts';
const REPLAY_SOURCE = 'src/deployment/rollback-executor.ts';

/**
 * The rollback spelling on the left, the drift spelling on the right.
 *
 * ORDER DOES NOT MATTER, and this comment used to claim it did: it said
 * `execCtx.importedProducerRegions` had to be rewritten before `execCtx.region`
 * or the shorter key would eat the longer one's prefix. It would not —
 * `execCtx.region` is not a prefix of `execCtx.importedProducerRegions` (they
 * diverge at `execCtx.` + `r` vs `i`), so no rewrite here can consume another
 * entry's text. No entry's left-hand side is a substring of any other's, which
 * is the property that actually makes the loop order-independent; state it that
 * way rather than as an ordering ritual, so a future entry is checked against
 * the real condition.
 *
 * Every entry is a NAME difference forced by where each side's evidence lives —
 * the replay reads a required context object, the drift walk takes the same two
 * facts as explicit parameters. None of them is a semantic difference, which is
 * the whole reason they can be normalized away rather than asserted about.
 */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['execCtx.importedProducerRegions', 'producerRegions'],
  ['execCtx.region', 'consumerRegion'],
  ['resolverContext', 'ctx'],
];

/** Strip JSDoc blocks and `//` line comments so the fence compares CODE. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*');
    })
    .join('\n');
}

/**
 * The BODY of `async function <name>`, from the opening `{` of
 * `): Promise<string> {` to the closing brace in column 0.
 *
 * The signature is deliberately excluded — the parameter lists are exactly the
 * declared difference, so including them would make the comparison fail for the
 * one reason it must tolerate.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  expect(start, `${name} not found — did it move or get renamed?`).toBeGreaterThan(-1);
  const bodyStart = source.indexOf('): Promise<string> {', start);
  expect(bodyStart, `${name} no longer returns Promise<string>`).toBeGreaterThan(-1);
  const end = source.indexOf('\n}\n', bodyStart);
  expect(end, `${name} has no closing brace in column 0`).toBeGreaterThan(-1);
  return source.slice(bodyStart + '): Promise<string> {'.length, end);
}

/**
 * Elide every `throw` statement down to a marker.
 *
 * The two sides' refusals name their own command (`Rollback of X cannot ...`
 * versus `X property '...': the secret reference ...`) and carry their own
 * error codes, so their TEXT must be allowed to differ. What must NOT differ is
 * WHERE each throw sits in the control flow, and the marker preserves that
 * exactly — a refusal moved after the first fetch changes the marker's position
 * and reds the comparison.
 */
function elideThrows(body: string): { text: string; count: number } {
  let count = 0;
  const text = body.replace(/throw [\s\S]*?\n\s*\);/g, () => {
    count++;
    return 'throw THROW;';
  });
  return { text, count };
}

/**
 * Whitespace and trailing commas carry no meaning here — both files are
 * formatted by oxfmt, which breaks lines purely on width, so the same statement
 * is spelled across three lines in one file and one line in the other.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
}

function mirroredBody(relative: string, fn: string): { normalized: string; throws: number } {
  const body = functionBody(stripComments(readFileSync(`${REPO_ROOT}${relative}`, 'utf8')), fn);
  const { text, count } = elideThrows(body);
  return { normalized: normalize(text), throws: count };
}

describe('the drift leaf walk mirrors the rollback replay leaf walk (issue #2108)', () => {
  it('is the same program once the declared aliases and the throw texts are normalized', () => {
    const drift = mirroredBody(DRIFT_SOURCE, 'resolveDriftLeafByRegion');
    const replay = mirroredBody(REPLAY_SOURCE, 'resolveLeafByRegion');

    let aliased = replay.normalized;
    for (const [from, to] of ALIASES) {
      aliased = aliased.split(normalize(from)).join(normalize(to));
    }

    expect(aliased).toBe(drift.normalized);
  });

  it('elides exactly the two refusals on each side, and nothing more', () => {
    // NON-VACUITY, and it is the load-bearing half. `elideThrows` is a regex
    // over the body: an over-greedy match could swallow the whole function and
    // leave two trivially-equal `throw THROW;` strings, which would compare
    // EQUAL and report a mirror that no longer exists. Pin the throw count and
    // assert the surviving text still holds the walk's actual operations.
    const drift = mirroredBody(DRIFT_SOURCE, 'resolveDriftLeafByRegion');
    const replay = mirroredBody(REPLAY_SOURCE, 'resolveLeafByRegion');

    // The region-ambiguous refusal and the token-scan-mismatch refusal.
    expect(drift.throws).toBe(2);
    expect(replay.throws).toBe(2);

    for (const { normalized } of [drift, replay]) {
      // The refuse-FIRST guard, over the whole leaf.
      expect(normalized).toContain("verdict.kind==='ambiguous'");
      // The whole-leaf fast path taken when nothing names a foreign region.
      // The resolver-context argument is one of the declared ALIASES, so it is
      // spelled differently on each side and is left out of this probe — the
      // equality test above is what pins it.
      expect(normalized).toContain('resolvers.primary.resolveDynamicReferences(leaf,');
      // The segment rebuild: the moving cursor, both splices, the advance.
      expect(normalized).toContain('leaf.indexOf(token,cursor)');
      expect(normalized).toContain('out+=leaf.slice(cursor,at)');
      expect(normalized).toContain('cursor=at+token.length');
      expect(normalized).toContain('returnout+leaf.slice(cursor)');
      // A body reduced to two throws would be far shorter than this.
      expect(normalized.length).toBeGreaterThan(400);
    }
  });
});
