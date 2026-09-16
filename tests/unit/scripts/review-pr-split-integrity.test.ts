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
  { step: 1, file: 'pr-stats.md', anchor: 'git rev-parse --verify -q' },
  { step: 3, file: 'bias-factors.md', anchor: 'security / process-launch surface' },
  { step: 5, file: 'output-template.md', anchor: 'If final tier is `3-axis`' },
  { step: 6, file: 'dispatch-and-marker.md', anchor: '.markgate-pr-review-sha' },
] as const;

/**
 * The two steps whose content stays INLINE, with the thing each is useless
 * without. They have no stage file, so the `STAGES` loop never looks at them —
 * and the step-numbering assertion above passes on a step reduced to its
 * heading, which would leave the base tier or the bias mapping silently gone.
 */
const INLINE_STEPS = [
  // EVERY row and EVERY arm, not one of each: a table reduced to its header
  // satisfies a single-row needle, and the bias mapping is six arms of which
  // any one alone proves nothing about the other five.
  {
    step: 2,
    needles: ['`loc < 300` OR `fc < 5`', '`300 <= loc < 1000`', '`loc >= 1000` OR `fc >= 10`'],
  },
  {
    step: 4,
    needles: [
      'inline+up→1-reviewer',
      '1-reviewer+up→3-axis',
      '3-axis+up →3-axis (clamp)',
      '3-axis+down→1-reviewer',
      '1-reviewer+down→inline',
      'inline+down→inline (clamp)',
    ],
  },
] as const;

/**
 * Measured 2026-09-16, smallest stage file 3,929 B (`pr-stats.md`; the others
 * run to 6,968 B). A floor well under that, because its job is to catch a file
 * emptied to a stub — a gutted file is its heading and intro, about 300 B —
 * never to police prose length: a stage file that legitimately halves still
 * clears it.
 *
 * An earlier revision of this comment quoted five per-file sizes taken BEFORE
 * the round-1 fixes grew them, and one of the five matched no file at any
 * commit. A dated single measurement that the floor is actually derived from
 * is the shape that cannot rot that way.
 */
const MIN_STAGE_BYTES = 1_200;

/**
 * The text of one numbered step, from its `N. **` opener to whatever ends it —
 * the next step, the next `##` heading, or the end of the file.
 *
 * A SLICE rather than a regex lookahead, because the obvious lookahead is
 * subtly wrong in JS: `\Z` is not an anchor here, it is a literal `Z`, so
 * `(?=^\d+\. \*\*|^## |\Z)` has a DEAD third arm and cannot terminate a
 * final step. It passes today only because `## Output template` happens to
 * follow step 6 — move that heading and every step-6 case fails claiming the
 * step does not exist. Measured, not reasoned: `/a\Z/.test('a')` is `false`
 * and `/\Z/.test('Z')` is `true`.
 */
function stepBlockOf(step: number): string | null {
  const opener = new RegExp(`^${step}\\. \\*\\*`, 'm');
  const start = orchestrator.search(opener);
  if (start === -1) return null;
  const rest = orchestrator.slice(start + 1);
  const endRel = rest.search(/^\d+\. \*\*|^## /m);
  return endRel === -1 ? orchestrator.slice(start) : orchestrator.slice(start, start + 1 + endRel);
}

/**
 * Whitespace-normalized, because every needle below is PROSE in a wrapped
 * markdown file. A contiguous needle breaks the moment a sentence reflows —
 * measured: `thread added by comment` and `does not block on its own` are both
 * present in the source and both split across a line break, so the first cut of
 * these assertions failed on correct text. A fence that reds on rewrapping
 * trains the next author to delete it.
 */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * From a heading-or-marker line to the next `##` heading. Used to bound an
 * assertion to the SECTION that must carry it — an unbounded file-wide needle
 * is satisfied by the text surviving anywhere, including a trailing comment
 * after the step that reads it.
 */
function sectionOf(body: string, marker: string): string {
  const start = body.indexOf(marker);
  if (start === -1) return '';
  const rest = body.slice(start);
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

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
      const block = stepBlockOf(step);
      expect(block, `SKILL.md has no step ${step}`).not.toBeNull();
      expect(
        flat(block!),
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

  for (const { step, needles } of INLINE_STEPS) {
    it(`step ${step} still carries its inline content`, () => {
      const block = stepBlockOf(step);
      expect(block, `SKILL.md has no step ${step}`).not.toBeNull();
      for (const needle of needles) {
        expect(
          flat(block!),
          `step ${step} no longer contains ${JSON.stringify(needle)}. This step has no stage ` +
            'file, so nothing else checks it — and the numbering assertion above is satisfied ' +
            'by a step reduced to its heading.'
        ).toContain(needle);
      }
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
        flat(inlineBlock![0]),
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
    //
    // NEEDLE THE SEMANTICS, not the label. An earlier revision asserted only
    // that the strings `No spec declared` and `spec (secondary)` appeared, and
    // review found the asymmetry: rewriting an arm to "`spec (secondary)`
    // blocks like any other finding" keeps the label and reverses the rule,
    // and the case stayed green. That is the same hole the `inline` case above
    // closed on its own side — a bare token survives the edit that guts it.
    // SCOPED to the step-6 block, not the whole file. File-wide needles stayed
    // green with the entire verdict-sort list moved out of the step into a
    // trailing comment — the same unbounded-needle mistake the `inline` case
    // avoids by matching inside its own emitted block.
    const dispatch = sectionOf(
      readFileSync(`${skillDir}references/dispatch-and-marker.md`, 'utf8'),
      'waits for all, and synthesizes:'
    );
    const ARMS = [
      {
        // The arm the whole gate rests on, and it deleted GREEN before this.
        arm: 'any blocker',
        needles: ['Any **blocker**', 'the marker is NOT set'],
      },
      {
        arm: 'No spec declared',
        needles: ['No spec declared', 'NOT a clean axis', 'does NOT block'],
      },
      {
        arm: 'spec (secondary) precedence',
        needles: ['spec (secondary)', 'YIELDS', 'does not block on its own'],
      },
      {
        // The ordering rule the two arms need to coexist: without it the
        // "any blocker" arm and the precedence arm collide on exactly the case
        // the second exists for.
        arm: 'first-match-wins ordering',
        needles: ['IN ORDER', 'FIRST match wins'],
      },
    ] as const;
    for (const { arm, needles } of ARMS) {
      for (const needle of needles) {
        expect(
          flat(dispatch),
          `step 6's ${arm} arm no longer contains ${JSON.stringify(needle)}. It sorts verdicts ` +
            'into "any blocker" and "every finding minor / nit / clean", and these belong to ' +
            'neither — an arm reduced to its label reads as present while stating the ' +
            'opposite rule.'
        ).toContain(needle);
      }
    }
  });

  /**
   * The SECURITY-governance rules, which the split raised from 2 copies to 4
   * and which nothing pinned. Measured by probe: deleting "NEVER set the marker
   * without dispatching the reviewers first", replacing the head-sha equality
   * guard with an unconditional `markgate set`, deleting the whole security
   * add-on dispatch paragraph, or deleting the ANY-tier rule from any of its
   * copies — every one left the suite GREEN before these cases existed. Only a
   * wholesale deletion of the bash block reds, via the `.markgate-pr-review-sha`
   * anchor, and a weakened guard keeps that filename.
   */
  const SECURITY_ARMS = [
    {
      file: 'references/dispatch-and-marker.md',
      what: 'the marker follows dispatch, and binds to the PR head',
      needles: [
        'NEVER set the marker without dispatching the reviewers first',
        '= "$(git rev-parse HEAD)"',
        'markgate set pr-review',
      ],
    },
    {
      file: 'SKILL.md',
      what: 'the ANY-tier security reviewer, and that its blocker blocks',
      needles: ['ADDITIVE', '`inline` included', 'blocks the marker like any other'],
    },
    {
      file: 'references/bias-factors.md',
      what: 'the additive rule at its authoritative copy',
      needles: ['NOT part of the tier ladder', 'security fix'],
    },
  ] as const;

  for (const { file, what, needles } of SECURITY_ARMS) {
    it(`${file} still states ${what}`, () => {
      const body = flat(readFileSync(`${skillDir}${file}`, 'utf8'));
      for (const needle of needles) {
        expect(
          body,
          `${file} no longer contains ${JSON.stringify(needle)}. This is a security-governance ` +
            'rule the split duplicated, so it can now drift in one copy while the others look ' +
            'right — and the failure mode is an un-reviewed security PR reaching main.'
        ).toContain(needle);
      }
    });
  }

  it('the ladder stays monotonic — 1-reviewer asks the Closes question too', () => {
    // Biasing UP may never REMOVE a check. `inline` asks whether a declared
    // `Closes` is earned; the code reviewer dispatched at `1-reviewer` is told
    // not to rule on it, so the orchestrator has to keep asking. Deleting that
    // clause left every other case green.
    const template = flat(readFileSync(`${skillDir}references/output-template.md`, 'utf8'));
    expect(
      template,
      'the `1-reviewer` block no longer tells the ORCHESTRATOR to ask the `Closes` question ' +
        'itself. The dispatched code reviewer is explicitly forbidden to rule on it, so ' +
        '`inline+up→1-reviewer` silently REMOVES a check — a bias step may never do that.'
    ).toContain('At `1-reviewer`, the ORCHESTRATOR still asks the `Closes` question itself');
  });

  it('the inline spec question tells the reader to read the issue THREAD', () => {
    // go-to-k/cdkd#3170's own scope came from its COMMENTS, and this PR's first
    // round shipped without it for exactly that reason — the body was read and
    // the thread was not. The instruction is the part most likely to be
    // trimmed as wordy, so it is needled separately from the `Closes` pair.
    const template = readFileSync(`${skillDir}references/output-template.md`, 'utf8');
    expect(
      flat(template),
      'the inline block no longer says to read acceptance items the issue THREAD added. An ' +
        "issue's scope is not always in its body, which is how this PR's own first round " +
        'shipped two blockers.'
    ).toContain('thread added by comment');
  });
});
