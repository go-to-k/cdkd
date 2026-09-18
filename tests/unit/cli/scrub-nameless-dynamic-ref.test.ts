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
 * `src/deployment/intrinsic-function-resolver.ts` — cross-cutting deploy code,
 * so typing it turns a no-real-AWS change into one owing a broad-set integ
 * run. The fix therefore stayed on the CONSUMER
 * side and matched the resolver's message, which made scrub a consumer of a
 * string another module owns. `.claude/rules/testing.md` is explicit about
 * that shape: a reword on the producing side makes the consumer silently stop
 * matching, and a zero match is indistinguishable from "the condition did not
 * occur" — here, indistinguishable from a clean scrub.
 *
 * SINCE go-to-k/cdkd#3181 THE MARKER LIST LIVES BESIDE THE THROWS, exported
 * from the resolver and IMPORTED by scrub, because the resolver grew the same
 * partition internally and two spellings of one predicate is what issue #1936
 * forbids. That paid the broad-integ cost this file was written to avoid, and
 * it makes the fence STRONGER rather than redundant: it no longer checks that
 * two hand-copies agree, it checks that the ONE definition still matches the
 * THROW literals beside it — the half that was always the real risk, since a
 * reworded throw leaves any number of agreeing copies equally stale.
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
  it('DYNAMIC_REFERENCE_PREFIX is the prefix the throws actually carry', () => {
    // The marker set was fenced against the throws; the PREFIX was not, and
    // since go-to-k/cdkd#3181 TWO predicates require it — scrub's
    // `isNamelessDynamicReferenceFailure` and the resolver's own
    // `isDeliberateResolutionRefusal`, which decides whether the per-unit
    // recovery re-raises. Reword the throws to `Dynamic ref: ` and both go
    // silent together: scrub reports CLEAN over a nameless reference, and the
    // recovery downgrades a refusal to a skipped unit. Neither fails loudly.
    const resolver = readFileSync(RESOLVER, 'utf8');
    const declared = resolver.match(
      /const DYNAMIC_REFERENCE_PREFIX = '([^']*)'/
    )?.[1];
    expect(declared, 'the resolver no longer declares DYNAMIC_REFERENCE_PREFIX').toBeDefined();

    const throws = namelessRequiredThrows(resolver);
    expect(throws.length).toBeGreaterThanOrEqual(2);
    const missingPrefix = throws.filter((message) => !message.includes(declared as string));
    expect(
      missingPrefix,
      `the resolver raises ${missingPrefix.length} nameless throw(s) that do NOT carry ` +
        `'${declared}': ${JSON.stringify(missingPrefix)}. Both predicates that gate on this ` +
        `prefix would stop matching them, silently.`
    ).toHaveLength(0);
  });

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
    // Read from the RESOLVER since go-to-k/cdkd#3181 moved the declaration
    // beside the throws; scrub imports it. The `scrub still consumes it` case
    // below is what keeps that import from being dropped silently.
    const resolver = readFileSync(RESOLVER, 'utf8');
    const block = resolver.match(
      /const NAMELESS_DYNAMIC_REFERENCE_MARKERS = \[([\s\S]*?)\] as const;/
    );
    expect(
      block,
      'the resolver no longer declares NAMELESS_DYNAMIC_REFERENCE_MARKERS as an array'
    ).not.toBeNull();
    const declared = [...(block?.[1] ?? '').matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
    expect(
      [...declared].sort(),
      `the resolver declares ${JSON.stringify(declared)} but this fence pins ${JSON.stringify([...MARKERS])}. ` +
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

  it('scrub still CONSUMES the marker list, wherever it is declared', () => {
    // The declaration moved to the resolver (go-to-k/cdkd#3181), so asserting
    // scrub spells each literal would now fail on correct code. What still
    // has to hold is that scrub READS the shared list: drop the import and the
    // matching failure falls back through the typed-refusal test into a debug
    // line and the run reports CLEAN again — the original #2692 disclosure.
    //
    // Asserted as an IMPORT from the resolver, not a bare mention: a local
    // re-declaration under the same name would satisfy a substring check while
    // re-creating exactly the two-copies drift the move removed.
    const scrub = readFileSync(SCRUB, 'utf8');
    const importsFromResolver = /import \{[^}]*\bisNamelessDynamicReferenceError\b[^}]*\} from '[^']*intrinsic-function-resolver\.js';/s.test(
      scrub
    );
    expect(
      importsFromResolver,
      `src/cli/commands/scrub.ts no longer imports isNamelessDynamicReferenceError from the ` +
        `resolver. Either it stopped consulting the markers — and a nameless reference reports ` +
        `CLEAN again — or it re-spelled the predicate locally, which is the drift ` +
        `go-to-k/cdkd#3181 removed by moving BOTH the list and the conjunction over it beside ` +
        `the throws.`
    ).toBe(true);
    expect(
      scrub.includes('const NAMELESS_DYNAMIC_REFERENCE_MARKERS = ['),
      'scrub re-declared its own marker list beside the imported predicate.'
    ).toBe(false);
    expect(
      /NAMELESS_DYNAMIC_REFERENCE_MARKERS\.some/.test(scrub),
      'scrub re-spelled the marker CONJUNCTION locally; it must delegate to the resolver arm.'
    ).toBe(false);
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
    // BOTH sides count bare occurrences of the predicate name, which is what
    // this case has always done and what it should keep doing.
    //
    // A go-to-k/cdkd#3160 round briefly anchored this side on the literal
    // re-raise tail `...) throw err;`, justified by "the sibling predicate
    // calls this one in its body, so names report 5 where there are 4". That
    // was true of an INTERMEDIATE cut whose predicate was message-keyed and
    // delegated here; the shipped one is positional and calls nothing. The
    // justification outlived the code it described — measured at the fix:
    // `isNamelessDynamicReferenceFailure(err)` occurs 4 times and
    // `isRegionAmbiguousRefusal(err)` 4, so the plain count still held. The
    // anchored form also reds on a formatter wrap, for no behavioral reason.
    const guarded = scrub.split('isNamelessDynamicReferenceFailure(err)').length - 1;
    const ambiguous = scrub.split('isRegionAmbiguousRefusal(err)').length - 1;
    expect(
      guarded,
      `${guarded} of scrub's best-effort catches re-raise a nameless dynamic reference, but ` +
        `${ambiguous} re-raise the region-ambiguous refusal. The two travel together — a catch ` +
        `that is loud for one and silent for the other reports a partial scrub as clean.`
    ).toBe(ambiguous);

    // ...and a FLOOR, because the equality above cannot see BOTH sides shrink.
    // The two predicates sit on the SAME line, so deleting a whole guard drops
    // both counts by one and the equality still holds. Measured, not imagined:
    // go-to-k/cdkd#3196 removed the orphan loop's guard while restructuring
    // that catch, and this case stayed GREEN at 3 == 3 — the exact
    // report-a-partial-scrub-as-clean outcome it exists to prevent.
    //
    // The floor is the number of best-effort catches that must carry it, and it
    // is DERIVED rather than written: every `abandonedScanVerdict(` call site is
    // one such catch by construction, since the verdict is only ever asked
    // inside one.
    // Two separate steps, because one `- 2` doing both jobs is a magic number
    // that breaks (loudly, in the safe direction) if the declaration is ever
    // rewritten as `const abandonedScanVerdict = (`.
    const verdictMentions = scrub.split('abandonedScanVerdict(').length - 1;
    const bestEffortCatches = verdictMentions - 1; // the declaration is not a catch
    expect(
      guarded,
      `${guarded} re-raise guards for ${bestEffortCatches} best-effort catches. A catch that ` +
        'lost its guard swallows a refusal that must abort the stack, and the equality above ' +
        'cannot see it because both predicates share a line and shrink together.'
    ).toBe(bestEffortCatches);
  });
});
