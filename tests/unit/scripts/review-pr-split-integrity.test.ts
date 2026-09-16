/**
 * `/review-pr` is a SPLIT skill outside `SPLIT_SKILLS`, and this file is what
 * covers the hole that leaves (go-to-k/cdkd#3170 review).
 *
 * `skill-file-payload.test.ts` gives a split skill two guarantees: the
 * orchestrator fits `MAX_ORCHESTRATOR_BYTES`, and every `references/` link
 * resolves in both directions. `MIN_REFERENCE_FILES` and
 * `MIN_REFERENCE_CORPUS_BYTES` are deliberately NOT among them — they live
 * inside a loop over `SPLIT_SKILLS`, which holds `work-issues` alone, and both
 * are calibrated to that skill (6 files / 168,980 B). review-pr's ~23 KB corpus
 * cannot join them without per-skill numbers, and the issue is explicit that it
 * must not be added to that list.
 *
 * So two failures are invisible to every existing fence, and both were measured
 * on this tree rather than imagined:
 *
 *  - **Gutting a stage file.** Empty `references/pr-stats.md` down to its
 *    heading and everything stays green: the file exists, it is still linked,
 *    it is under its cap, and `check-verification-depth-rule.ts` only hunts
 *    BANNED phrases, so less text means fewer violations, not more.
 *  - **Losing a step from the orchestrator.** SKILL.md could drop step 1
 *    wholesale while keeping `references/pr-stats.md` linked from any trailing
 *    line, and the link guard — which asks only "is this file linked SOMEWHERE"
 *    — stays green, even though step 1's own text calls the history probe
 *    mandatory.
 *
 * The three caps in `skill-file-payload.test.ts` are UPPER bounds, and an upper
 * bound reads every deletion as an improvement. These are the lower ones.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skillDir = fileURLToPath(new URL('../../../.claude/skills/review-pr/', import.meta.url));
const orchestrator = readFileSync(`${skillDir}SKILL.md`, 'utf8');

/**
 * Step number → the stage file that step reads, and a phrase that must survive
 * inside it.
 *
 * The ANCHOR is the point, not the filename: a link proves a file exists, and
 * only content proves the instruction is still in it. Each phrase is the thing
 * the step cannot be executed without — the query that decides whose turn it
 * is, the flag that excludes generated LOC, the roster that forces a tier up,
 * the rule that the marker follows dispatch, the format the recommendation is
 * rendered in. A reworded file is expected to update its anchor here; a GUTTED
 * one cannot.
 */
const STAGES = [
  { step: 0, file: 'round-completion.md', anchor: 'said()' },
  { step: 1, file: 'pr-stats.md', anchor: 'docs/_generated/' },
  { step: 3, file: 'bias-factors.md', anchor: 'security / process-launch surface' },
  { step: 6, file: 'dispatch-and-marker.md', anchor: '.markgate-pr-review-sha' },
  { step: 5, file: 'output-template.md', anchor: 'Recommendation:' },
] as const;

/**
 * Measured 2026-09-16 at the split: 3,903 / 3,629 / 3,155 / 4,853 / 6,968 B.
 * A floor well under the smallest, because its job is to catch a file emptied
 * to a stub, never to police prose length — a stage file that legitimately
 * shrinks by half still clears it.
 */
const MIN_STAGE_BYTES = 1_200;

describe('/review-pr split integrity (go-to-k/cdkd#3170)', () => {
  it('the orchestrator still names every step, with no gap in the sequence', () => {
    const steps = [...orchestrator.matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1]));
    expect(
      steps,
      'SKILL.md no longer numbers its steps 0-6 in order. A step deleted here is ' +
        'invisible to the payload fence, which only asks whether the files it links exist — ' +
        'so the stage file survives, still linked, and nothing routes a session to it.'
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  for (const { step, file, anchor } of STAGES) {
    it(`step ${step} points at references/${file}, which still has its content`, () => {
      // REACHABILITY, not mere presence: the link must sit in the step that
      // reads the file. `skill-file-payload.test.ts` accepts a link anywhere in
      // the orchestrator, which a trailing "see also" would satisfy.
      const stepBlock = orchestrator.match(
        new RegExp(`^${step}\\. \\*\\*[\\s\\S]*?(?=^\\d+\\. \\*\\*|^## |\\Z)`, 'm')
      );
      expect(stepBlock, `SKILL.md has no step ${step}`).not.toBeNull();
      expect(
        stepBlock![0],
        `step ${step} does not link references/${file}. The link may still exist elsewhere in ` +
          'SKILL.md — which the payload fence accepts — but a pointer the step does not carry ' +
          'is one the session reading that step will not follow.'
      ).toContain(`references/${file}`);

      const body = readFileSync(`${skillDir}references/${file}`, 'utf8');
      const size = statSync(`${skillDir}references/${file}`).size;
      expect(
        size,
        `references/${file} is ${size} B, under the ${MIN_STAGE_BYTES} B floor. A stage file ` +
          'emptied to its heading passes every other fence: it exists, it is linked, and it is ' +
          'under its upper cap.'
      ).toBeGreaterThanOrEqual(MIN_STAGE_BYTES);
      expect(
        body,
        `references/${file} no longer contains ${JSON.stringify(anchor)}, the instruction step ` +
          `${step} cannot be executed without. If the file was legitimately reworded, update ` +
          'the anchor in STAGES; if it was gutted, restore it.'
      ).toContain(anchor);
    });
  }

  it('the one BEHAVIOUR change the split carries is present: inline asks the spec question', () => {
    // go-to-k/cdkd#3170's second scope comment, which called this out as the
    // one change the split should carry rather than pure relocation: `inline`
    // is the most common tier and was the only one with no spec owner at all.
    const template = readFileSync(`${skillDir}references/output-template.md`, 'utf8');
    const inlineBlock = template.match(/\*\*If final tier is `inline`\*\*[\s\S]*?```[\s\S]*?```/);
    expect(inlineBlock, 'the inline dispatch block was renamed or removed').not.toBeNull();
    // Both halves, because the bare word `Closes` survives deleting the
    // TRIGGER line while leaving the explanation behind it — measured: a probe
    // that removed the `Closes #N` line alone left this case GREEN.
    for (const needle of ['Closes #N', 'EARNED']) {
      expect(
        inlineBlock![0],
        `the \`inline\` block no longer contains ${JSON.stringify(needle)}, so it has stopped ` +
          'asking whether a declared `Closes` is earned. No reviewer is dispatched at this ' +
          "tier, so nothing else asks it — `1-reviewer` has the code reviewer's secondary " +
          'pass and `3-axis` has the real axis, and `inline` has nobody.'
      ).toContain(needle);
    }
  });

  it('step 6 can represent a verdict the two-bucket sort cannot', () => {
    // Both arms exist for the same reason and were added together: a verdict
    // that is neither "blocker" nor "minor / nit / clean" otherwise falls
    // silently into the second bucket at the one place a verdict is consumed.
    const dispatch = readFileSync(`${skillDir}references/dispatch-and-marker.md`, 'utf8');
    for (const [arm, needle] of [
      ['No spec declared', 'No spec declared'],
      ['spec (secondary) precedence', 'spec (secondary)'],
    ] as const) {
      expect(
        dispatch,
        `step 6 lost its ${arm} arm. It sorts verdicts into "any blocker" and "every finding ` +
          'minor / nit / clean", and this one belongs to neither — without the arm it is ' +
          'indistinguishable from Clean at the point the marker is decided.'
      ).toContain(needle);
    }
  });
});
