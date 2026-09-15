import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `cdkd scrub` must not report a run CLEAN when the resolver refused a
 * NAMELESS dynamic reference (issue go-to-k/cdkd#2692).
 *
 * The resolver raises a BARE `Error` for `{{resolve:ssm-secure}}` with no
 * parameter name and for `{{resolve:secretsmanager}}` with no secret id, so
 * either falls through scrub's typed-refusal test into a `logger.debug` and
 * the run exits 0 under `No plaintext secrets found`. What makes that a
 * disclosure rather than a cosmetic miss is WHERE the abort happens: the token
 * loop in `resolveDynamicReferences` has NO per-token `try`, so either one
 * abandons every remaining `{{resolve:...}}` token in the leaf. A real
 * `{{resolve:secretsmanager:prod/db}}` after it is never fetched and records no
 * needle, and a legacy plaintext already sitting in `state.json` survives the
 * scrub that was supposed to find it.
 *
 * WHY THIS FILE IS A SYNC FENCE RATHER THAN A BEHAVIOUR TEST. The correct fix
 * is a typed error at the throw site, but that site is in
 * `src/deployment/intrinsic-function-resolver.ts`, which
 * `.claude/hooks/integ-broad-gate.sh`'s `CROSS_CUTTING_REGEX` arms on ANY
 * touch — it has no hunk filter — so typing it turns a no-real-AWS change into
 * one needing a broad-set integ run. The fix therefore stays on the CONSUMER
 * side and matches the resolver's message, which makes scrub a consumer of a
 * string another module owns. `.claude/rules/testing.md` is explicit about
 * that shape: a reword on the producing side makes the consumer silently stop
 * matching, and a zero match is indistinguishable from "the condition did not
 * occur" — here, indistinguishable from a clean scrub. So the two are pinned
 * to each other, and a reword fails HERE rather than going quiet in the field.
 *
 * THE POPULATION IS DERIVED, AND ITS BOUNDARY IS ASSERTED IN BOTH DIRECTIONS.
 * An earlier cut keyed on `PARAMETER_NAME is required` alone and asserted that
 * literal occurred EXACTLY ONCE in the resolver — which passed precisely
 * BECAUSE the secretsmanager throw spells `SECRET_ID`, so the fence CERTIFIED
 * half-coverage as deliberate, over the dominant secret spelling. The next cut
 * over-corrected to the whole `Dynamic reference:` family and had to be
 * reverted: scrub resolves with template DEFAULTS and no `--parameters`, so
 * the four RESOLUTION failures in the same loop fire on healthy stacks. The
 * two cases below therefore pin both edges — every nameless-required throw is
 * IN, every sibling is OUT (go-to-k/cdkd#3160 holds the sibling class).
 *
 * Retire this file, and the marker with it, when the throws become typed.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESOLVER = join(repoRoot, 'src', 'deployment', 'intrinsic-function-resolver.ts');
const SCRUB = join(repoRoot, 'src', 'cli', 'commands', 'scrub.ts');

/** The literal scrub keys on, spelled here a THIRD time on purpose. */
const MARKERS = ['PARAMETER_NAME is required', 'SECRET_ID is required'] as const;

/**
 * Every message the resolver raises for a dynamic reference it refused.
 * Template literals are included — several interpolate a `${service}` or a
 * secret id — so the match runs to the closing quote of the literal.
 */
function namelessRequiredThrows(resolver: string): string[] {
  const matches = resolver.matchAll(
    /(?:new Error\(\s*)[`'"](Dynamic reference:[^`'"]*?is required)[`'"]/g
  );
  return [...matches].map((m) => m[1] as string);
}

describe('scrub keys on the resolver nameless-dynamic-reference messages', () => {
  it('every nameless-required throw in the resolver is matched by a marker', () => {
    const resolver = readFileSync(RESOLVER, 'utf8');
    const throws = namelessRequiredThrows(resolver);

    // Floor: the checker must prove it SEES its input. A regex that silently
    // stopped matching would report "every throw is covered" over zero throws.
    expect(
      throws.length,
      `found ${throws.length} nameless-required dynamic-reference throws in the resolver; ` +
        `at least two exist (ssm-secure's PARAMETER_NAME, secretsmanager's SECRET_ID), so a ` +
        `lower count means this fence's own extractor stopped matching and is asserting ` +
        `nothing.`
    ).toBeGreaterThanOrEqual(2);

    const unmatched = throws.filter((message) => !MARKERS.some((m) => message.includes(m)));
    expect(
      unmatched,
      `the resolver raises ${unmatched.length} nameless-dynamic-reference failure(s) that ` +
        `scrub's predicate does not match: ${JSON.stringify(unmatched)}. The token loop has no ` +
        `per-token \`try\`, so each aborts every remaining {{resolve:...}} token in the leaf — ` +
        `a real secret after it records no needle and \`cdkd scrub\` reports the stack CLEAN ` +
        `over surviving plaintext (go-to-k/cdkd#2692). Add the literal to ` +
        `NAMELESS_DYNAMIC_REFERENCE_MARKERS in src/cli/commands/scrub.ts and to MARKERS here, ` +
        `or type the throw.`
    ).toEqual([]);
  });

  it("the marker set is EXACTLY what scrub declares — no re-widening", () => {
    // The previous cut of this case filtered the population with
    // `!includes('is required')` and then asserted those did not contain
    // 'PARAMETER_NAME is required' — a superset of the excluded substring, so
    // the loop was a TAUTOLOGY for every possible input and could not detect a
    // re-widening at all. The only thing that CAN detect it is reading scrub's
    // own declared array and comparing it to this file's hand-copy.
    const scrub = readFileSync(SCRUB, 'utf8');
    const block = scrub.match(
      /const NAMELESS_DYNAMIC_REFERENCE_MARKERS = \[([\s\S]*?)\] as const;/
    );
    expect(block, 'scrub no longer declares NAMELESS_DYNAMIC_REFERENCE_MARKERS as an array').not
      .toBeNull();
    const declared = [...(block?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
    expect(
      [...declared].sort(),
      `scrub declares ${JSON.stringify(declared)} but this fence pins ${JSON.stringify([...MARKERS])}. ` +
        `If the set GREW, check the new entry is a structurally-broken reference and not a ` +
        `RESOLUTION failure: scrub resolves with template defaults and no --parameters, so ` +
        `refusing on a resolution failure refuses HEALTHY stacks (measured — widening to the ` +
        `whole 'Dynamic reference:' family reddened ` +
        `tests/unit/cli/commands/scrub-cross-region-secret.test.ts). See go-to-k/cdkd#3160.`
    ).toEqual([...MARKERS].sort());
  });

  it('the SIBLING resolution failures are NOT matched by the predicate', () => {
    // Real siblings, named rather than derived by a filter that presupposes
    // the answer: each is a resolution failure the same token loop raises, and
    // each must fall through to scrub's best-effort debug.
    const SIBLINGS = [
      "Dynamic reference: SSM parameter '/p' not found or has no value",
      "Dynamic reference: secret 'x' does not contain a SecretString value",
      "Dynamic reference: key 'k' not found in secret 'x'",
      "Dynamic reference: secret 'x' is not valid JSON but JSON_KEY 'k' was specified",
    ];
    // Non-vacuity: each named sibling must really be a throw in the resolver,
    // or this case is asserting things about messages nothing produces.
    const resolver = readFileSync(RESOLVER, 'utf8');
    for (const sibling of SIBLINGS) {
      const stem = sibling.slice(0, sibling.indexOf("'"));
      expect(
        resolver.includes(stem),
        `the resolver no longer raises anything starting '${stem}'; this case is asserting ` +
          `about a message that does not exist.`
      ).toBe(true);
      expect(
        MARKERS.some((m) => sibling.includes(m)),
        `'${sibling}' is now matched by scrub's nameless predicate. It is a RESOLUTION failure ` +
          `that scrub reaches on HEALTHY stacks, because it resolves with template defaults — ` +
          `refusing on it refuses those stacks. See go-to-k/cdkd#3160.`
      ).toBe(false);
    }
  });

  it('scrub declares every marker', () => {
    const scrub = readFileSync(SCRUB, 'utf8');
    for (const marker of MARKERS) {
      expect(
        scrub.includes(`'${marker}'`),
        `src/cli/commands/scrub.ts no longer declares the marker '${marker}'. With it gone the ` +
          `matching failure falls back through the typed-refusal test into a debug line and the ` +
          `run reports CLEAN again.`
      ).toBe(true);
    }
  });

  it('each marker is specific enough to be worth matching on', () => {
    for (const marker of MARKERS) {
      expect(marker.split(/\s+/).length, `marker '${marker}' is too short`).toBeGreaterThanOrEqual(
        3
      );
    }
  });

  it('scrub applies the predicate at EVERY best-effort re-raise, not just one', () => {
    // The issue named one call site; the same swallow shape occurs four times.
    // A per-site fix leaves the other three reporting CLEAN.
    const scrub = readFileSync(SCRUB, 'utf8');
    // The RE-RAISE shape, not bare occurrences of the predicate name: since
    // go-to-k/cdkd#3160 the sibling predicate CALLS this one in its own body,
    // so counting names reported 5 call sites where there are 4. Counting the
    // `... ) throw err;` tail keeps the subject the thing the case is about.
    const RERAISE = /isNamelessDynamicReferenceFailure\(err\)\) throw err;/g;
    const AMBIGUOUS = /isRegionAmbiguousRefusal\(err\) \|\|/g;
    const guarded = [...scrub.matchAll(RERAISE)].length;
    const ambiguous = [...scrub.matchAll(AMBIGUOUS)].length;
    expect(
      guarded,
      `${guarded} of scrub's best-effort catches re-raise a nameless dynamic reference, but ` +
        `${ambiguous} re-raise the region-ambiguous refusal. The two travel together — a catch ` +
        `that is loud for one and silent for the other reports a partial scrub as clean.`
    ).toBe(ambiguous);
  });
});
