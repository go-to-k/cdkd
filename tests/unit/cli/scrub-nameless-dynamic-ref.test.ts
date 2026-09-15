import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `cdkd scrub` must not report a run CLEAN when the resolver aborted on a
 * NAMELESS dynamic reference (issue go-to-k/cdkd#2692).
 *
 * The resolver raises a BARE `Error` for `{{resolve:ssm-secure}}` with no
 * parameter name, so it falls through scrub's typed-refusal test into a
 * `logger.debug` and the run exits 0 under `No plaintext secrets found`. What
 * makes that a disclosure rather than a cosmetic miss is WHERE the abort
 * happens: `resolver.resolve` stops at the FIRST token, so a real
 * `{{resolve:secretsmanager:...}}` in the same leaf is never fetched and
 * records no needle, and a legacy plaintext already sitting in `state.json`
 * survives the scrub that was supposed to find it.
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
 * Retire this file, and the marker with it, when the throw becomes typed.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RESOLVER = join(repoRoot, 'src', 'deployment', 'intrinsic-function-resolver.ts');
const SCRUB = join(repoRoot, 'src', 'cli', 'commands', 'scrub.ts');

/** The literal scrub keys on, spelled here a THIRD time on purpose. */
const MARKER = 'PARAMETER_NAME is required';

describe('scrub keys on the resolver nameless-dynamic-reference message', () => {
  it('the resolver still raises a message carrying the marker', () => {
    const resolver = readFileSync(RESOLVER, 'utf8');
    expect(
      resolver.includes(MARKER),
      `src/deployment/intrinsic-function-resolver.ts no longer raises a message containing ` +
        `"${MARKER}". \`cdkd scrub\` matches on exactly that substring to decide a nameless ` +
        `dynamic reference is NOT a best-effort miss (go-to-k/cdkd#2692); with the message ` +
        `reworded, the match silently stops firing and the run reports CLEAN again — the ` +
        `regression this pairing exists to prevent. Update both sides together, or type the ` +
        `throw and delete this fence with scrub's marker.`,
    ).toBe(true);
  });

  it('scrub declares the same marker', () => {
    const scrub = readFileSync(SCRUB, 'utf8');
    expect(
      scrub.includes(`'${MARKER}'`),
      `src/cli/commands/scrub.ts no longer declares the marker '${MARKER}'.`,
    ).toBe(true);
  });

  it('the marker is specific enough to be worth matching on', () => {
    // A one-word marker would match unrelated resolver failures and make every
    // partial resolution fatal. Pin the shape rather than trusting the reading.
    expect(MARKER.split(/\s+/).length).toBeGreaterThanOrEqual(3);
    const resolver = readFileSync(RESOLVER, 'utf8');
    const occurrences = resolver.split(MARKER).length - 1;
    expect(
      occurrences,
      `the marker appears ${occurrences} times in the resolver; scrub's predicate cannot tell ` +
        `which throw it matched, so a second site needs its own decision about whether it is ` +
        `best-effort.`,
    ).toBe(1);
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
        `that is loud for one and silent for the other reports a partial scrub as clean.`,
    ).toBe(ambiguous);
  });
});
