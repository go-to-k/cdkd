import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `cdkd scrub` must not report a run CLEAN when the resolver aborted on a
 * NAMELESS dynamic reference (issue go-to-k/cdkd#2692).
 *
 * The resolver raises a BARE `Error` for `{{resolve:ssm-secure}}` with no
 * parameter name and for `{{resolve:secretsmanager}}` with no secret id, so
 * either falls through scrub's typed-refusal test into a `logger.debug` and the
 * run exits 0 under `No plaintext secrets found`. What makes that a disclosure
 * rather than a cosmetic miss is WHERE the abort happens: `resolver.resolve`
 * stops at the FIRST token, so a real `{{resolve:secretsmanager:...}}` in the
 * same leaf is never fetched and records no needle, and a legacy plaintext
 * already sitting in `state.json` survives the scrub that was supposed to find
 * it.
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
 * THE POPULATION IS DERIVED FROM THE RESOLVER, not listed here. An earlier cut
 * of this file asserted its single marker occurred EXACTLY ONCE in the
 * resolver, which read as rigour and was the opposite: the assertion passed
 * precisely because the `secretsmanager` throw spelled `SECRET_ID` instead, so
 * the fence CERTIFIED half-coverage as deliberate — over the dominant secret
 * spelling. The case below instead reads every nameless-required throw out of
 * the resolver and requires each to be matched, so a third one reds this file
 * rather than silently joining the unmatched half.
 *
 * Retire this file, and the markers with it, when the throws become typed.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESOLVER = join(repoRoot, 'src', 'deployment', 'intrinsic-function-resolver.ts');
const SCRUB = join(repoRoot, 'src', 'cli', 'commands', 'scrub.ts');

/** The literals scrub keys on, spelled here a THIRD time on purpose. */
const MARKERS = ['PARAMETER_NAME is required', 'SECRET_ID is required'] as const;

/**
 * Every `throw new Error(...)` in the resolver whose message declares a
 * dynamic reference is missing its name. Template literals are included —
 * the ssm-secure one interpolates `${service}` — so the match is on the
 * message's fixed TAIL rather than on the whole string.
 */
function namelessRequiredThrows(resolver: string): string[] {
  const matches = resolver.matchAll(
    /throw new Error\(\s*[`'"](Dynamic reference:[^`'"]*?is required)[`'"]/g
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
        `scrub's predicate does not match: ${JSON.stringify(unmatched)}. Each one aborts ` +
        `\`resolver.resolve\` at the FIRST token, so a real secret beside it in the same leaf ` +
        `records no needle and \`cdkd scrub\` reports the stack CLEAN over surviving plaintext ` +
        `(go-to-k/cdkd#2692). Add the literal to NAMELESS_DYNAMIC_REFERENCE_MARKERS in ` +
        `src/cli/commands/scrub.ts and to MARKERS here, or type the throw.`
    ).toEqual([]);
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
    // A one-word marker would match unrelated resolver failures and make every
    // partial resolution fatal. Pin the shape rather than trusting the reading.
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
    const guarded = scrub.split('isNamelessDynamicReferenceFailure(err)').length - 1;
    const ambiguous = scrub.split('isRegionAmbiguousRefusal(err)').length - 1;
    expect(
      guarded,
      `${guarded} of scrub's best-effort catches re-raise a nameless dynamic reference, but ` +
        `${ambiguous} re-raise the region-ambiguous refusal. The two travel together — a catch ` +
        `that is loud for one and silent for the other reports a partial scrub as clean.`
    ).toBe(ambiguous);
  });
});
