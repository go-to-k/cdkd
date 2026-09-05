/**
 * Pins the `recreate-nested-logical-id-collision` fixture's needles against the
 * strings cdkd actually emits (issue
 * [#2567](https://github.com/go-to-k/cdkd/issues/2567)).
 *
 * Phases 4 and 4b measure PRE-FLIGHT REFUSALS by grepping the deploy's output,
 * which makes the fixture a CONSUMER of wording this repo changes. When the
 * producer moves, a zero match is indistinguishable from "the refusal did not
 * fire" — `.claude/rules/testing.md`, "A fixture that greps cdkd's OWN output
 * must fail loudly when the format drifts". The sibling
 * `tests/unit/provisioning/stateful-guard-message-sync.test.ts` is the same
 * instrument for the `backup` fixture.
 *
 * Each case pins BOTH sides — the emitting source still contains the template,
 * and the fixture still greps it — so a reword reds here naming the pair to
 * update, instead of silently blinding a real-AWS run that costs minutes to
 * discover. Round 3 of this PR's review is why the file exists: the unit suite
 * pinned the emitter and the fixture pinned a hand-written needle, and nothing
 * connected them, which is the exact shape a typo hides in.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const RECREATE_TARGETS = readFileSync(
  join(REPO_ROOT, 'src/deployment/recreate-targets.ts'),
  'utf8'
);
const VERIFY_SH = readFileSync(
  join(REPO_ROOT, 'tests/integration/recreate-nested-logical-id-collision/verify.sh'),
  'utf8'
);

describe('the recreate-nested-logical-id-collision fixture greps strings cdkd still emits (#2567)', () => {
  it('the unknown-id refusal still says `not present in the synth template`', () => {
    expect(
      RECREATE_TARGETS,
      'the unknown-id refusal reworded — update phase 4 of ' +
        'tests/integration/recreate-nested-logical-id-collision/verify.sh'
    ).toContain('logical id(s) not present in the synth template:');
    expect(VERIFY_SH).toContain("grep -qF 'not present in the synth template'");
  });

  it('the nesting note still says `resources inside a nested stack are NOT addressable`', () => {
    expect(
      RECREATE_TARGETS,
      'the nested-stack note reworded — update phase 4 of the fixture'
    ).toContain('resources inside a nested stack are NOT addressable');
    expect(VERIFY_SH).toContain("grep -qF 'resources inside a nested stack are NOT addressable'");
  });

  it("the nesting note still renders the list as `nested stack(s) (<ids>)`", () => {
    // The fixture greps `nested stack(s) (Child)` — the RENDERED list, not the
    // bare id, because the refusal's own `- ChildOnlyParam` line contains
    // "Child" and a substring grep would pass with the list empty or wrong.
    // That only holds while the emitter keeps this exact framing.
    expect(
      RECREATE_TARGETS,
      "the nested-stack list is no longer rendered as `nested stack(s) (<ids>)` — " +
        "phase 4's grep in the fixture would silently stop discriminating"
    ).toContain("template's nested stack(s) (");
    expect(VERIFY_SH).toContain("grep -qF 'nested stack(s) (Child)'");
  });

  it('the nested-row refusal still says `refuses to operate on N nested-stack resource(s)`', () => {
    // BOTH halves of the fixture's needle. Pinning only the tail
    // (`nested-stack resource(s):`) left the `refuses to operate on ` prefix
    // free to be reworded while this case stayed green and the fixture's grep
    // died — the needle spans the interpolation, so neither half alone is it.
    expect(
      RECREATE_TARGETS,
      'the nested-stack-row refusal reworded its prefix — update phase 4b of the fixture'
    ).toContain('${FLAG_UMBRELLA} refuses to operate on ');
    expect(
      RECREATE_TARGETS,
      'the nested-stack-row refusal reworded its tail — update phase 4b of the fixture'
    ).toContain('nested-stack resource(s):');
    expect(VERIFY_SH).toContain("grep -qF 'refuses to operate on 1 nested-stack resource'");
  });

  it('renders BOTH `Note:` paragraphs for a nested template, in order', () => {
    // The readability claim the multi-stack note's own comment makes. Nothing
    // else fences it: the two paragraphs are built by separate `lines.push`
    // calls, so their coexistence and order are invisible in either source.
    const multiStack = RECREATE_TARGETS.indexOf('Note: if a named id belongs to a DIFFERENT');
    const nesting = RECREATE_TARGETS.indexOf('Note: resources inside a nested stack');
    expect(multiStack, 'the multi-stack note is gone').toBeGreaterThan(-1);
    expect(nesting, 'the nesting note is gone').toBeGreaterThan(-1);
    expect(
      multiStack,
      'the nesting note is now pushed BEFORE the multi-stack one — the rendered block ' +
        'reads as two `Note:` paragraphs, so their order is a deliberate choice'
    ).toBeLessThan(nesting);
  });

  it('the nested-row refusal still states `DELETE the whole child stack`', () => {
    // Phase 4b asserts the refusal explains the consequence, not merely that it
    // refused: the message is the only thing standing between a user and a
    // cascade they did not ask for.
    expect(
      RECREATE_TARGETS,
      'the nested-stack-row refusal no longer states its consequence — update phase 4b'
    ).toContain('DELETE the whole child stack');
    expect(VERIFY_SH).toContain("grep -qF 'DELETE the whole child stack'");
  });

  it('phase 4b still PASSES --force-stateful-recreation, so the no-bypass property is measured', () => {
    // Phase 4b's whole extra value over phase 4 is that the refusal survives
    // the consent flag that clears the stateful guard. The sentence documents
    // it; the INVOCATION is what measures it.
    //
    // A `toContain('--force-stateful-recreation')` over the whole file was the
    // first spelling and it was decorative: the fixture's own header comment
    // carries the flag, so deleting it from the invocation left this green and
    // phase 4b silently stopped testing the property. Pin the invocation LINE.
    expect(
      RECREATE_TARGETS,
      'the nested-stack refusal no longer states that no consent flag clears it'
    ).toContain('no --force-stateful-recreation bypass');
    expect(
      VERIFY_SH,
      "phase 4b no longer passes --force-stateful-recreation on its deploy line — it now " +
        'measures only that the row is refused, not that the consent flag fails to clear it'
    ).toMatch(/^ {2}--force-stateful-recreation \\$/m);
  });
});
