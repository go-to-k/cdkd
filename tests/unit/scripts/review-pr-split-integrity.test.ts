/**
 * `/review-pr` is a SPLIT skill outside `SPLIT_SKILLS`, and this file is what
 * covers the hole that leaves (go-to-k/cdkd#3170 review).
 *
 * `skill-file-payload.test.ts` gives a split skill two guarantees: the
 * orchestrator fits `MAX_ORCHESTRATOR_BYTES`, and every `references/` link
 * resolves in both directions. `MIN_REFERENCE_FILES` and
 * `MIN_REFERENCE_CORPUS_BYTES` are deliberately NOT among them — they live
 * inside a loop over `SPLIT_SKILLS`, which holds `work-issues` alone, and both
 * are calibrated to that skill (6 files / 168,980 B). review-pr's ~27 KB corpus
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
 *
 * WHAT THIS FILE NO LONGER FENCES, and why. The skill used to resolve a SIZE
 * TIER (`inline` / `1-reviewer` / `3-axis`) from LOC and file count, bias it up
 * or down from the paths, and bind a `pr-review` markgate marker to the PR's
 * head sha — all of which this file pinned row by row. The reviewer policy is
 * now FLAT (one reviewer by default; the security reviewer added by trigger;
 * all three axes only for a state-schema bump or a security fix), and the
 * `pr-review` gate, its sentinel and `pr-review-gate.sh` are gone, so none of
 * that machinery exists to pin. The threshold rows, the bias-arithmetic rows,
 * the ladder-monotonicity case and every marker case were DELETED rather than
 * re-pointed — a fence over a deleted mechanism is worse than no fence, because
 * it keeps reading as coverage.
 *
 * What survived is the split-integrity core (step numbering, per-step
 * reachability, per-file content anchors, the byte floor) plus the governance
 * rules the split duplicated across files and nothing else pins: the security
 * add-on's trigger AND its consequence, the verdict-sort arms, the `Closes`
 * question's owner, and the mandatory-read / cost-floor statements. The
 * anti-vacuity discipline is unchanged and is the point of the file: every
 * bounded section fails when its markers cannot be found, every prose needle is
 * whitespace-normalized and CONTIGUOUS across the clause it pins, and no needle
 * is left unbounded where the text it watches could survive somewhere else.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
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
 * is, the history probe that feeds the recency signal, the roster that adds the
 * security reviewer, the block the 3-axis set is emitted from, the instruction
 * that reviewers are actually dispatched. A reworded file is expected to update
 * its anchor here; a GUTTED one cannot.
 */
const STAGES = [
  { step: 0, file: 'round-completion.md', anchor: 'said()' },
  { step: 1, file: 'pr-stats.md', anchor: 'git rev-parse --verify -q' },
  { step: 3, file: 'bias-factors.md', anchor: 'security / process-launch surface' },
  { step: 5, file: 'output-template.md', anchor: 'If the PR resolved to `3-axis`' },
  {
    step: 6,
    file: 'dispatch-and-marker.md',
    // The filename still says `marker` — the file is cross-referenced by it —
    // but the marker it was named for no longer exists, so the anchor is the
    // DISPATCH instruction, which is what the step is now for. Anchoring on
    // the stale half of the filename would pin nothing.
    anchor: 'dispatches the recommended reviewers via the Agent tool',
  },
] as const;

/**
 * The two steps whose content stays INLINE, with the thing each is useless
 * without. They have no stage file, so the `STAGES` loop never looks at them —
 * and the step-numbering assertion above passes on a step reduced to its
 * heading, which would leave the default set or the resolution order silently
 * gone.
 */
const INLINE_STEPS = [
  {
    step: 2,
    // BOTH DIRECTIONS. The default is a floor AND a ceiling for size: pinning
    // only "one reviewer by default" leaves "…but drop to none for a docs-only
    // diff" free to reappear, which is the exact discount the flat policy
    // removed. One needle per direction, each contiguous across its clause.
    needles: [
      'Default: ONE reviewer** (`pr-code-reviewer`',
      'Size selects nothing',
      'a docs-only or test-only diff is not discounted below it',
    ],
  },
  {
    step: 4,
    // The resolution ORDER, arm by arm. `flat()` strips the whitespace around
    // `→`, so a needle pins both sides of an arm without encoding where the
    // line happens to wrap — and a contiguous arm cannot be satisfied by the
    // two halves surviving a reversal.
    needles: [
      'default one reviewer→plus `pr-security-reviewer` when its trigger fired',
      'fired→all three axes when a schema bump or security fix is in play',
      'a 3-axis security fix dispatches four reviewers, not three',
    ],
  },
] as const;

/**
 * Measured 2026-09-18, smallest stage file 3,535 B (`output-template.md`; the
 * others run to 5,838 B). A floor well under that, because its job is to catch
 * a file emptied to a stub — a gutted file is its heading and intro, about
 * 300 B — never to police prose length: a stage file that legitimately halves
 * still clears it.
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
  // Whitespace around `→` is stripped too, so a needle can pin BOTH sides of a
  // resolution arm without encoding where the line happens to wrap. Pinning
  // only the left side let an arm be rewritten to `default one reviewer →only
  // for a schema bump` -- a silent narrowing -- while staying green.
  return text.replace(/\s+/g, ' ').replace(/\s*→\s*/g, '→');
}

/**
 * The text between two explicit markers. Used to bound an
 * assertion to the SECTION that must carry it — an unbounded file-wide needle
 * is satisfied by the text surviving anywhere, including a trailing comment
 * after the step that reads it.
 */
function sectionOf(body: string, marker: string, endMarker: string): string {
  const start = body.indexOf(marker);
  if (start === -1) return '';
  const rest = body.slice(start + marker.length);
  const end = rest.indexOf(endMarker);
  return end === -1 ? '' : rest.slice(0, end);
}

/**
 * The EXECUTABLE lines of a markdown file's fenced bash blocks — comments and
 * fences stripped.
 *
 * Needed because a whole-file needle is position-blind: a probe that deleted a
 * live command and left `# (we also read the review threads)` behind kept the
 * assertion green (measured, on the marker block this helper used to serve).
 * The command has to be asserted where it RUNS.
 *
 * ONE block, selected by a marker, not every block joined: the first cut joined
 * all of them, so gutting the real block and appending a second
 * "counter-example" block kept both needles green — position blindness one
 * level up from the flaw it was added to fix.
 */
function bashBlockContaining(body: string, marker: string): string {
  const block = [...body.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((m) => m[1]!)
    .find((b) => b.includes(marker));
  if (block === undefined) return '';
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
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

      const body = flat(readFileSync(`${skillDir}references/${file}`, 'utf8'));
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

  /**
   * The step-0 query, asserted on the lines that RUN. All three GitHub comment
   * surfaces have to be read: a contributor answering from "Files changed" —
   * GitHub's default — writes only a review body or a review-thread reply, and
   * `issues/<N>/comments` never shows either. Dropping one surface makes the
   * skill conclude "they never replied" and review a head the author has
   * already moved past, which is the exact failure step 0 exists to prevent.
   */
  it('step 0 reads all three comment surfaces, in the lines that run', () => {
    const block = bashBlockContaining(
      readFileSync(`${skillDir}references/round-completion.md`, 'utf8'),
      'said()'
    );
    expect(block, "no bash block in round-completion.md defines `said()`").not.toBe('');
    for (const surface of [
      `issues/$PR/comments`,
      `pulls/$PR/comments`,
      `pulls/$PR/reviews`,
    ]) {
      expect(
        block,
        `the step-0 query no longer reads ${surface} on an executable line. A surface named ` +
          'only in a comment is one the query does not consult, and a missing surface reads as ' +
          '"they have not replied" — the skill then reviews a head the author moved past.'
      ).toContain(surface);
    }
  });

  it('the one BEHAVIOUR change the split carries is present: the orchestrator asks the spec question', () => {
    // go-to-k/cdkd#3170's second scope comment called this out as the one
    // change the split should carry rather than pure relocation. It used to
    // live in the `inline` dispatch block; with `inline` gone, the DEFAULT
    // single-reviewer set is where it has to be, because the dispatched code
    // reviewer is explicitly forbidden to rule on it.
    const template = readFileSync(`${skillDir}references/output-template.md`, 'utf8');
    // BOTH ends explicit. An unfound end marker returns '' and REDS, rather
    // than silently widening the "section" to the rest of the file — the first
    // cut of a sibling case searched forward for a `## ` heading this file does
    // not have, covered 93% of it, and the mutation it claimed to catch stayed
    // green.
    const orchestratorCheck = sectionOf(
      template,
      '**With the default single reviewer, the ORCHESTRATOR still asks the `Closes`',
      '**If the PR resolved to `3-axis`**'
    );
    expect(
      orchestratorCheck,
      'the orchestrator `Closes` check could not be bounded — its opening sentence or the ' +
        '3-axis block that follows it was renamed or removed'
    ).not.toBe('');
    // The emitted snippet, not just the sentence introducing it: a block the
    // orchestrator never emits asks nobody anything.
    expect(
      flat(orchestratorCheck),
      'the `Closes` check is no longer emitted as its own block. A sentence saying the ' +
        'orchestrator asks the question, with no snippet to emit, is not an instruction.'
    ).toContain('Orchestrator check (not delegated):');
    // Both halves, because the bare word `Closes` survives deleting the
    // TRIGGER line while leaving the explanation behind it — measured: a probe
    // that removed the `Closes #N` line alone left the predecessor of this case
    // GREEN.
    for (const needle of ['Closes #N', 'EARNED']) {
      expect(
        flat(orchestratorCheck),
        `the orchestrator check no longer contains ${JSON.stringify(needle)}, so it has stopped ` +
          'asking whether a declared `Closes` is earned. The dispatched code reviewer is told ' +
          'not to rule on it and the security reviewer refuses it outright, so nothing else asks.'
      ).toContain(needle);
    }
  });

  it('the orchestrator check tells the reader to read the issue THREAD', () => {
    // go-to-k/cdkd#3170's own scope came from its COMMENTS, and that PR's first
    // round shipped without it for exactly that reason — the body was read and
    // the thread was not. The instruction is the part most likely to be
    // trimmed as wordy, so it is needled separately from the `Closes` pair.
    const template = readFileSync(`${skillDir}references/output-template.md`, 'utf8');
    const orchestratorCheck = sectionOf(
      template,
      'Orchestrator check (not delegated):',
      '**If the PR resolved to `3-axis`**'
    );
    expect(orchestratorCheck, 'the orchestrator-check block could not be bounded').not.toBe('');
    expect(
      flat(orchestratorCheck),
      'the orchestrator check no longer says to read acceptance items the issue THREAD added. ' +
        "An issue's scope is not always in its body, which is how go-to-k/cdkd#3170's own first " +
        'round shipped two blockers.'
    ).toContain('thread added by comment');
  });

  it('adding reviewers may never REMOVE the spec question', () => {
    // The surviving half of the old ladder-monotonicity case. The ladder it was
    // written against (`inline+up→1-reviewer`) is gone, but the property is not
    // about the ladder: the code reviewer is forbidden to rule on `Closes` and
    // the security reviewer refuses it, so if the question were handed to
    // "whoever was dispatched", dispatching MORE reviewers would drop it.
    const template = flat(readFileSync(`${skillDir}references/output-template.md`, 'utf8'));
    expect(
      template,
      'output-template.md no longer records WHY the orchestrator keeps the `Closes` question ' +
        'when reviewers are dispatched. Without the reason, the next author reads the check as ' +
        'redundant with the reviewer it sits next to and deletes it.'
    ).toContain('would REMOVE a check, which adding reviewers must never do');
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
    // and the case stayed green. A bare token survives the edit that guts it.
    // SCOPED to the step-6 synthesis section, not the whole file. File-wide
    // needles stayed green with the entire verdict-sort list moved out of the
    // step into a trailing comment.
    // BOTH ends given explicitly. The first cut searched forward for a `## `
    // heading, and this file has none — so the "section" ran to EOF, covered
    // 93% of the file, and the mutation the comment claimed to catch (the whole
    // verdict list moved into a trailing comment) stayed GREEN. An unfound end
    // marker returns '' and reds, rather than silently widening to everything.
    const dispatch = sectionOf(
      readFileSync(`${skillDir}references/dispatch-and-marker.md`, 'utf8'),
      'waits for all, and synthesizes:',
      '**Security add-on dispatch**'
    );
    expect(dispatch, 'the step-6 synthesis section could not be bounded').not.toBe('');
    const ARMS = [
      {
        // The arm the whole review rests on, and it deleted GREEN before this.
        arm: 'any blocker',
        // CONTIGUOUS across the verdict: the two halves as separate needles
        // stayed green when the arm was reversed to "merge anyway".
        needles: ['Any **blocker** surviving the pre-filters→**do not merge**'],
      },
      {
        // The clean arm. With no marker to set, an explicit STATEMENT is the
        // only record that a round happened at all, so it carries the same
        // weight the marker block used to — and the head sha is what makes a
        // later push visibly un-reviewed.
        arm: 'every finding minor / nit / clean',
        needles: [
          'the review round is CLOSED',
          'naming the head sha you reviewed and which reviewers ran',
        ],
      },
      {
        arm: 'No spec declared',
        needles: ['No spec declared', 'NOT a clean axis', 'does NOT block'],
      },
      {
        arm: 'spec (secondary) pre-filter',
        needles: [
          'spec (secondary)',
          'is DISCOUNTED',
          // CONDITION 2 is the security-critical half and the reason this is
          // not keyed on the label or on severity: the label is explicitly
          // allowed to carry a blocker when the finding is independently a
          // security defect, and severity is inert because minor findings
          // never blocked anyway.
          'not independently a code or security defect',
          // ONE WORD carries the whole security property. Changing `when BOTH
          // hold` to `when EITHER holds` left every other needle verbatim and
          // stayed green -- and then condition 1 alone discounts a security
          // blocker the primary axis never examined (measured).
          'when BOTH hold',
          // ...and the fall-through, without which a discounted-only run never
          // reaches the arm that closes the round.
          'FALL THROUGH',
        ],
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
   * and which nothing else pins. Measured by probe on the predecessor of this
   * file: deleting the "dispatch before you close the round" rule, deleting the
   * whole security add-on dispatch paragraph, or deleting the additive rule
   * from any of its copies — every one left the suite GREEN before these cases
   * existed. There is no marker left to notice any of it.
   */
  const SECURITY_ARMS = [
    {
      file: 'references/dispatch-and-marker.md',
      what: 'dispatch precedes the verdict, and a security blocker stops the merge',
      needles: [
        'NEVER report a round closed without dispatching the reviewers first',
        'fold its findings in',
        'a security blocker stops the merge like any other',
        // The rationale paragraphs are the only record of WHY the discount may
        // not be re-keyed on the label or on severity -- one word away, per B1.
        'Condition 2 is what makes this safe',
        'BACKSTOP against a reviewer definition that overshoots',
      ],
    },
    {
      file: 'SKILL.md',
      what: 'the additive security reviewer, and that its blocker blocks',
      // The needle runs from the reviewer's NAME through `additive to whatever
      // else runs` on purpose. Bare tokens (`pr-security-reviewer`, `security
      // fix`) all SURVIVE the one-line narrowing `additive to whatever else
      // runs` → `only when the 3-axis set runs`, which removes the security
      // reviewer from the default set — i.e. from most PRs. Contiguity is what
      // catches that, exactly as it did for the deleted ANY-tier wording.
      needles: [
        'Security add-on** (`pr-security-reviewer`, additive to whatever else runs)',
        'A security blocker stops the merge like any other',
      ],
    },
    {
      file: 'references/bias-factors.md',
      what: 'the additive rule and the two 3-axis cases at their authoritative copy',
      needles: [
        'Dispatch `pr-security-reviewer` alongside the default whenever any of these holds',
        'security fix',
        // The belonging test is the ONLY defence against the surface list
        // rotting by omission, and `security-surface-list-sync.test.ts` names
        // it as ITS backstop while passing happily without it.
        '(a) verifies or mints',
        // 3-axis is now the only escalation the rules resolve, so its
        // population has to be pinned in BOTH directions: `exactly two cases`
        // stops it widening into a size proxy again, and the schema-bump arm
        // stops it narrowing to security alone.
        'exactly two cases',
        'a **state-schema bump** (`StackState.version`)',
        // The FLOOR half. The old down-bias section deleted green, taking with
        // it the arm SKILL.md itself calls the one a `.claude/**`-only diff
        // gets wrong; these are its replacement, and a cap with no floor
        // rewards the inverse regression.
        'There is no size ladder: LOC and file count do NOT move the count in either direction',
        'Agent-instruction files never get a discount',
        'the low-risk premise is false',
      ],
    },
    {
      file: 'references/output-template.md',
      what: 'the security add-on dispatch block step 5 actually emits',
      // The trigger list carried contiguously with the `append` instruction:
      // a block whose trigger is intact but which is never appended dispatches
      // nobody, and the reverse reads as unconditional.
      needles: [
        'security add-on trigger fired** (a secret / credential',
        'whichever set resolved, same parallel batch',
        'pr-security-reviewer.md',
      ],
    },
    {
      file: 'references/pr-stats.md',
      what: 'both halves of step 1 — what the step is FOR, and the history probe',
      // The LOC-exclusion arithmetic this used to pin existed only to feed the
      // size ladder and went with it. What replaced it is the statement of what
      // the step now reads for, which is what stops the size fields quietly
      // becoming inputs again.
      needles: ['Size no longer selects anything', '`paths` is the load-bearing field', 'git rev-parse --verify -q'],
    },
    {
      file: 'references/round-completion.md',
      what: 'the ordered arms and the measured wait bound, not just the query',
      needles: ['THEIRS` newer than `MINE', '30 minutes', 'Skip the wait outright'],
    },
    {
      file: 'SKILL.md',
      what: 'the mandatory-read rule and the cost-is-never-a-reason floor',
      needles: [
        'at stage entry is MANDATORY',
        'FLOOR, not a cap',
        'never a reason to come in under it',
      ],
    },
  ] as const;

  /**
   * DERIVED, not listed — every `pr-*-reviewer` agent on disk must be reachable
   * from the dispatch templates, and each set must name the right NUMBER.
   *
   * This is the structural answer to a defect the needle tables kept missing:
   * they cannot see the absence of a thing nobody listed. Measured — the
   * `3-axis` block could be degraded to dispatch a SINGLE reviewer and all 20
   * cases stayed green, because `pr-spec-reviewer.md` and `pr-test-reviewer.md`
   * appeared in no needle anywhere. The top set silently becoming the default
   * one is the same shape as the round-3 tier-column swap: the trigger intact,
   * the verdict gutted, still reading as authoritative.
   *
   * Reading the agents off the FILESYSTEM is what stops this going stale: a new
   * reviewer agent is a deliberate decision about the dispatch templates, not a
   * silent no-op.
   */
  it('every reviewer agent is dispatched, and each set names the right number', () => {
    const template = readFileSync(`${skillDir}references/output-template.md`, 'utf8');
    const agents = readdirSync(fileURLToPath(new URL('../../../.claude/agents/', import.meta.url)))
      .filter((f) => /^pr-.*-reviewer\.md$/.test(f))
      .sort();
    expect(agents.length, 'no pr-*-reviewer agents found — the scan broke').toBeGreaterThanOrEqual(
      4
    );
    for (const agent of agents) {
      expect(
        template,
        `${agent} exists but references/output-template.md never names it, so no set ` +
          'dispatches it. A reviewer nobody dispatches is a review axis that silently does ' +
          'not happen.'
      ).toContain(agent);
    }

    // `pr-security-reviewer` is ADDITIVE and deliberately outside both counts:
    // it rides along with whichever set resolved, so counting it would make the
    // default set look like two and the 3-axis set like four.
    const dispatched = (block: string): number =>
      agents.filter((a) => a !== 'pr-security-reviewer.md' && block.includes(a)).length;
    // Markers taken verbatim from the file, and a start marker that does not
    // match yields '' and a count of 0 — which reads as a regression rather
    // than as a broken probe, so both sections are asserted non-empty first.
    const threeAxis = sectionOf(
      template,
      '**If the PR resolved to `3-axis`**',
      "**The `Closes` question is the ORCHESTRATOR's"
    );
    const defaultSet = sectionOf(
      template,
      'Then, **unless the PR resolved to 3-axis**, emit the default single reviewer:',
      '**With the default single reviewer'
    );
    expect(threeAxis, 'the 3-axis block could not be bounded').not.toBe('');
    expect(defaultSet, 'the default single-reviewer block could not be bounded').not.toBe('');
    expect(
      dispatched(threeAxis),
      'the `3-axis` block no longer dispatches exactly three reviewers (spec + code + test). ' +
        'Degrading it to fewer makes the top set the default set, silently — and with the ' +
        '`pr-review` gate gone, nothing downstream would notice.'
    ).toBe(3);
    // PRESENCE of three names is not THREE DISPATCHES, and the difference is
    // the likelier edit: an author trimming this block writes "escalate if
    // needed" before they delete a filename. Rewriting it to "emit the block
    // ONCE for the code reviewer, escalate to the other two only if asked"
    // keeps all three names, keeps `dispatched()` at 3, and stays green
    // (measured) -- the top set becomes one unconditional reviewer plus two
    // conditional ones, and nothing downstream counts reviewers.
    expect(
      flat(threeAxis),
      'the `3-axis` block no longer says the reviewers are dispatched TOGETHER. Three names ' +
        'present in the block is not three dispatches ordered — a block that escalates to two ' +
        'of them conditionally reads as 3-axis and behaves as one reviewer.'
    ).toContain('the same block three times in ONE parallel message');
    expect(
      dispatched(defaultSet),
      'the default block no longer dispatches exactly one reviewer.'
    ).toBe(1);
  });

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
});
