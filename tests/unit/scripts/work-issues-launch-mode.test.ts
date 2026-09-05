import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `/work-issues` LAUNCH-MODE machinery, which decides whether a run creates
 * a worktree per lane or works in the tree it was launched in.
 *
 * WHY THIS FILE EXISTS. `skill-file-payload.test.ts` and
 * `work-issues-skill-refs.test.ts` measure BYTES and CITATIONS. Neither looks at
 * what the prose says, so every mode-specific arm in this skill was untested --
 * and the orchestrator cap made that worse than merely untested: `SKILL.md` sits
 * a few hundred bytes under a 12,000 B cap, so DELETING the launch-mode section
 * was the cheapest way to buy headroom and the suite would have called it an
 * improvement. Measured 2026-09-01: deleting the probe block, deleting the whole
 * `## Launch mode` section, and deleting every line containing `IN-PLACE` or
 * `MAIN-CHECKOUT` were all GREEN before this file existed.
 *
 * Three properties, in increasing order of what they actually prove:
 *
 *   1. the probe exists EXACTLY ONCE in the skill directory -- pinning both its
 *      presence and the single-copy claim the text makes about it (a second
 *      verbatim copy is the drift shape section 10-b fences elsewhere);
 *   2. every file carrying a mode-specific ARM still names the mode(s) it
 *      branches on, so gutting one file's arms fails even though the corpus
 *      byte floor (which only notices the LARGEST file disappearing) would not;
 *   3. the probe is EXECUTED, in a real git repo and in a real linked worktree
 *      of it, and must answer with the two literal verdicts. This is the one
 *      arm of the whole change that is executable rather than prose, and the
 *      shell-edge-case reading beside it in the doc is otherwise re-checked by
 *      nothing.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const skillDir = join(repoRoot, '.claude', 'skills', 'work-issues');
const LAUNCH_MODE_DOC = join('references', 'launch-mode.md');

/** Every markdown file of the skill, orchestrator first. */
function skillDocs(): string[] {
  return [
    'SKILL.md',
    ...readdirSync(join(skillDir, 'references'))
      .filter((f) => f.endsWith('.md'))
      .sort()
      .map((f) => join('references', f)),
  ];
}

function read(rel: string): string {
  return readFileSync(join(skillDir, rel), 'utf8');
}

/**
 * The probe's distinguishing token. `--git-common-dir` is what makes the mode
 * decidable at all (a linked worktree's `--git-dir` differs from it, the main
 * checkout's does not), so counting it counts copies of the probe.
 */
const PROBE_TOKEN = '--git-common-dir';

/**
 * Files that carry a mode-specific ARM and the marker(s) each must still name.
 * Not every file needs both: `claim.md` and `gotchas.md` only qualify the
 * IN-PLACE side, and `gates-and-pr.md` deliberately carries NO arm (its
 * `git -C "<LANE_TREE>"` spelling is correct in both modes, which is why the
 * mode words were removed from it rather than duplicated).
 */
const ARM_BEARING: Record<string, string[]> = {
  'SKILL.md': ['MAIN-CHECKOUT', 'IN-PLACE'],
  [LAUNCH_MODE_DOC]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'triage.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'implement.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'ship.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'retro.md')]: ['MAIN-CHECKOUT', 'IN-PLACE'],
  [join('references', 'claim.md')]: ['IN-PLACE'],
  [join('references', 'gotchas.md')]: ['IN-PLACE'],
};

/**
 * Files carrying an arm of the LAUNCH_BRANCH contract (go-to-k/cdkd#2417): the
 * probe records the branch the outer tool handed the tree over on, section 5
 * refuses to commit onto it, and section 9 puts it back AS-IS at the very end.
 * Separate from ARM_BEARING because the mode words survive deleting the restore
 * — a file can still say IN-PLACE everywhere while the one step that makes the
 * mode leave no trace is gone, which is what the byte floors also cannot see.
 */
const LAUNCH_BRANCH_BEARING: Array<{ doc: string; arm: string; pattern: RegExp }> = [
  // Each row pins ONE arm, not the token. A bare `.toContain('LAUNCH_BRANCH')`
  // was measured VACUOUS in 4 of 7 files: `launch-mode.md` mentions the token
  // 11 times and `ship.md` 6, so deleting the lane-dispatch arm, the "PUT BACK"
  // paragraph, consequence rows 4/6/9, or ship.md's restore fence ALL stayed
  // green. A presence check can only catch deleting a file's LAST mention,
  // which is the one failure nobody makes.
  {
    doc: 'SKILL.md',
    arm: 'the opening report states LAUNCH_BRANCH with the other probe values',
    pattern: /MAIN_CHECKOUT`\s*and\s*\n?`LAUNCH_BRANCH`/,
  },
  {
    doc: 'SKILL.md',
    arm: 'lane dispatches carry LAUNCH_BRANCH (without it a lane cannot restore)',
    pattern: /MAIN_CHECKOUT` \/ `LAUNCH_BRANCH`/,
  },
  {
    doc: LAUNCH_MODE_DOC,
    arm: 'the "a branch to PUT BACK, never one to commit to" rule',
    pattern: /PUT\s*\n?BACK, never one to commit to/,
  },
  {
    // Its own row rather than a widening of the pattern above: a RENAME
    // satisfies "never one to commit to" -- nothing is committed onto the outer
    // tool's branch -- while destroying the restore target outright, so the two
    // arms fail independently and deleting one must not stay covered by the
    // other. Measured 2026-09-02: SIX workspaces renamed their launch branch
    // away inside SEVEN minutes, one of them the tree that wrote this row.
    doc: LAUNCH_MODE_DOC,
    arm: 'the "never one to RENAME" rule (a rename leaves nothing for section 9 to restore)',
    // `\s+` rather than literal spaces, matching the sibling row's `\s*\n?`:
    // the phrase currently sits at column 5 of a 77-char wrapped line, so a
    // few characters added to the clause before it would reflow the wrap
    // THROUGH the phrase and red this fence on an edit that changed nothing.
    pattern: /never\s+one\s+to\s+RENAME/,
  },
  {
    doc: LAUNCH_MODE_DOC,
    arm: 'consequence row: branch in place, never commit onto LAUNCH_BRANCH',
    pattern: /^\|.*never commit onto `LAUNCH_BRANCH`.*\|$/m,
  },
  {
    doc: LAUNCH_MODE_DOC,
    arm: 'consequence row: switch back as-is',
    pattern: /^\|.*`LAUNCH_BRANCH`\s*\*\*as-is\*\*.*\|$/m,
  },
  {
    doc: join('references', 'claim.md'),
    arm: 'do NOT claim LAUNCH_BRANCH',
    pattern: /Do NOT claim `LAUNCH_BRANCH`/,
  },
  {
    doc: join('references', 'ship.md'),
    arm: 'the AS-IS restore rationale',
    pattern: /AS-IS is the whole rule/,
  },
  {
    doc: join('references', 'ship.md'),
    arm: 'the restore runs LAST, not per-lane',
    pattern: /runs LAST, not per-lane/,
  },
  {
    doc: join('references', 'retro.md'),
    // retro.md HARD-WRAPS the command across a newline, so a copy of ship.md's
    // single-line regex silently misses it -- the reason this is a pattern per
    // row rather than one shared regex.
    arm: 'section 10-d runs section 9\'s IN-PLACE cleanup arm as the last step',
    pattern: /git switch\s*\n?\s*--no-guess <LAUNCH_BRANCH> && git branch -D/,
  },
  {
    doc: join('references', 'gotchas.md'),
    arm: 'the Stop-hook bullet points at the restore instead of the detach',
    pattern: /LEAVING the lane branch/,
  },
  {
    doc: join('references', 'implement.md'),
    arm: 'section 5 branches in place ALWAYS rather than conditionally',
    pattern: /ALWAYS, and WITHOUT leaving the tree/,
  },
];

/** Every fenced ```bash block of a markdown file, in order. */
export function bashBlocks(markdown: string): string[] {
  const out: string[] = [];
  const lines = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (/^```bash\s*$/.test(lines[i]!)) start = i + 1;
    } else if (/^```\s*$/.test(lines[i]!)) {
      out.push(lines.slice(start, i).join('\n'));
      start = -1;
    }
  }
  return out;
}

/**
 * Command lines of a block: blanks and whole-line comments dropped, a trailing
 * `# ...` comment stripped.
 *
 * The strip is quote-aware. An unconditional `/\s+#.*$/` truncates a legitimate
 * `git commit -m "closes #2417"` mid-string, and the caller then reports the
 * MUTILATED text as an unrecognised command -- a confusing failure for an edit
 * that was fine.
 */
export function commandLines(block: string): string[] {
  const stripComment = (line: string): string => {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"') {
        quote = c;
      } else if (c === "'" && /(^|[\s=(])'/.test(line.slice(Math.max(0, i - 1), i + 1))) {
        // A single quote OPENS a string only where a string can START -- at the
        // line's beginning or after whitespace / `=` / `(`. Treating every `'`
        // as an opener makes an APOSTROPHE INSIDE A WORD ("the tool's branch")
        // open a string that never closes, so every `#` after it looks quoted
        // and the trailing comment is never stripped. The caller then compares
        // the comment-bearing line against the prescribed command and reports a
        // mismatch for an edit that was fine -- a false FAILURE, which is the
        // expensive direction for a fence nobody expects to be wrong.
        // Found on the go-to-k/cdk-local#651 sibling lane, whose copy of this
        // helper had the same defect (go-to-k/cdkd#2432 shipped it here).
        // A double quote needs no such rule: `"` does not appear inside words.
        quote = c;
      } else if (c === '#' && i > 0 && /\s/.test(line[i - 1]!)) {
        return line.slice(0, i);
      }
    }
    return line;
  };
  return block
    .split('\n')
    .map((l) => stripComment(l).trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/**
 * `git` plus any GLOBAL options before the verb. `git -C "<LANE_TREE>" ...` is
 * this skill's OWN spelling (gates-and-pr.md uses it throughout), so a pattern
 * anchored on a literal `git branch` / `git switch` walks straight past the most
 * likely way a bad line would actually be written. Measured on the
 * go-to-k/cdk-local#651 sibling, whose equivalent scans were added in the same
 * commit that closed this hole elsewhere and reopened it here:
 * `git -C "<LANE_TREE>" branch -D <LAUNCH_BRANCH>` survived green. Module-scope
 * so every scan in this file is built from ONE spelling of it.
 */
const GIT = String.raw`git(?:\s+(?:-C\s+\S+|-c\s+\S+|--git-dir=\S+|--work-tree=\S+))*\s+`;

/** The first fenced ```bash block of a markdown file. */
export function firstBashBlock(markdown: string): string | null {
  const lines = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start === -1) {
      if (/^```bash\s*$/.test(lines[i]!)) start = i + 1;
    } else if (/^```\s*$/.test(lines[i]!)) {
      return lines.slice(start, i).join('\n');
    }
  }
  return null;
}

describe('work-issues launch-mode probe', () => {
  it('the probe exists exactly once across the skill directory, in launch-mode.md', () => {
    const hits = skillDocs().filter((doc) => read(doc).includes(PROBE_TOKEN));
    expect(
      hits,
      `Expected exactly one file to carry the launch-mode probe (\`${PROBE_TOKEN}\`), found ` +
        `${hits.length}: ${hits.join(', ') || '(none)'}. The skill's own text calls ` +
        `${LAUNCH_MODE_DOC} the ONLY copy: zero hits means the probe was deleted and every ` +
        `IN-PLACE arm downstream is unreachable; two means a second verbatim copy that will ` +
        `drift out of step with the first.`
    ).toEqual([LAUNCH_MODE_DOC]);
    const occurrences = read(LAUNCH_MODE_DOC).split(PROBE_TOKEN).length - 1;
    expect(occurrences, `${LAUNCH_MODE_DOC} repeats the probe token ${occurrences} times`).toBe(1);
  });

  it('the orchestrator points at the launch-mode stage file', () => {
    // The parent reads SKILL.md and nothing else before stage 0; if the pointer
    // goes, the probe is unreachable however intact the file it lives in is.
    expect(read('SKILL.md')).toContain(`references/launch-mode.md`);
  });

  for (const [doc, markers] of Object.entries(ARM_BEARING)) {
    it(`${doc} still names the mode(s) it branches on: ${markers.join(', ')}`, () => {
      const text = read(doc);
      const missing = markers.filter((m) => !text.includes(m));
      expect(
        missing,
        `${doc} no longer mentions ${missing.join(' / ')}. Either its mode-specific arm was ` +
          `deleted (the byte floors do not notice: they only catch the LARGEST stage file ` +
          `disappearing), or the arm moved -- in which case update ARM_BEARING in this file ` +
          `so the assertion keeps tracking where the behaviour actually lives.`
      ).toEqual([]);
    });
  }

  for (const { doc, arm, pattern } of LAUNCH_BRANCH_BEARING) {
    it(`${doc} still carries its arm: ${arm}`, () => {
      expect(
        read(doc),
        `${doc} no longer carries the arm "${arm}" (${pattern}). Deleting it breaks the ` +
          `restore contract even though the file may still MENTION LAUNCH_BRANCH ` +
          `elsewhere -- which is exactly why this asserts the arm and not the token. ` +
          `If the arm MOVED, update its row in LAUNCH_BRANCH_BEARING.`
      ).toMatch(pattern);
    });
  }

  describe('section 9 restores LAUNCH_BRANCH as-is rather than moving it', () => {
    // The spec was CORRECTED mid-filing: an early draft fast-forwarded the branch
    // to origin/main first, and that clause is WITHDRAWN -- the branch is the
    // outer tool's artifact and this run puts it back untouched.
    //
    // The first version of this guard was a single-line blacklist over the WHOLE
    // FILE (`not.toMatch(/git (pull|rebase|merge|fetch)[^\n]*<LAUNCH_BRANCH>/)`).
    // Measured against real re-introductions, it missed nearly all of them: a
    // `git merge --ff-only origin/main` or `git pull --ff-only` on the NEXT line
    // (the regex cannot cross a newline), `git reset --hard` and `git update-ref`
    // (absent from the alternation), and -- worst -- `git branch -D
    // <LAUNCH_BRANCH>`, which DELETES the outer tool's branch, the single most
    // damaging thing this contract exists to prevent. It also fired on PROSE
    // quoting the withdrawn clause, i.e. backwards.
    //
    // So the guard is now a WHITELIST scoped to the restore's own fenced block:
    // the block is extracted, and every command line in it must be one of the
    // four the recipe prescribes. Anything added is a failure by default, which
    // is the right polarity for a recipe this small and this dangerous.
    const shipBlocks = bashBlocks(read(join('references', 'ship.md')));
    const restore = shipBlocks.find((b) => /^\s*(?:&&\s*)?git switch --no-guess <LAUNCH_BRANCH>/m.test(b));
    const fallback = shipBlocks.find((b) => /--detach origin\/main/.test(b));

    // The EXACT command sequence, in order. An `ALLOWED`-set check alone is an
    // UPPER bound: it forbids additions but permits deletions and reordering,
    // so the three things the review round before this one fixed --
    // `git status` running FIRST, the delete being PLURAL, and the closing
    // check existing at all -- were each silently re-revertible. Measured: four
    // separate mutations of ship.md stayed GREEN under the set check. Ordered
    // equality subsumes it.
    const PRESCRIBED = [
      "git show-ref --verify --quiet refs/heads/<LAUNCH_BRANCH> || echo 'gone -> use the fallback'",
      'DIRTY=$(git status --porcelain)',
      "[ -z \"$DIRTY\" ] || echo 'dirty -> commit or stash first, then re-run this block'",
      '[ -z "$DIRTY" ] \\',
      '&& git switch --no-guess <LAUNCH_BRANCH> \\',
      '&& git branch -D <each branch this run created>',
      'git branch --show-current',
      "git branch --list '<your prefix>*'",
    ];
    // The fallback gets its own ordered equality: without one, adding
    // `&& git reset --hard origin/main` to it was measured as passing every
    // assertion, because the blacklist only fires on lines naming LAUNCH_BRANCH
    // and the fallback deliberately names none.
    const PRESCRIBED_FALLBACK = [
      'git fetch origin \\',
      '&& git switch --detach origin/main \\',
      '&& git branch -D <each branch this run created>',
    ];

    it('exactly one block matches each selector -- no decoy copy', () => {
      // `.find()` takes the FIRST match, so a "for reference, the canonical
      // restore is:" block placed ABOVE the real one lets the real one be
      // gutted unnoticed. Same single-copy discipline the probe token gets.
      const restores = shipBlocks.filter((b) => /^\s*(?:&&\s*)?git switch --no-guess <LAUNCH_BRANCH>/m.test(b));
      const fallbacks = shipBlocks.filter((b) => /--detach origin\/main/.test(b));
      expect(restores, 'references/ship.md must carry EXACTLY ONE restore block').toHaveLength(1);
      expect(fallbacks, 'references/ship.md must carry EXACTLY ONE detach fallback block').toHaveLength(1);
    });

    it('the restore block is exactly the prescribed sequence, in order', () => {
      expect(
        commandLines(restore!),
        `references/ship.md's IN-PLACE restore block no longer matches the prescribed ` +
          `sequence. Every line is load-bearing, and so are the ORDER and the CHAINING. ` +
          `(1) \`show-ref\` decides which ARM applies, so it runs before either is taken. ` +
          `(2) \`[ -z "$(git status --porcelain)" ]\` gates the rest, because \`git switch\` ` +
          `carries uncommitted changes ACROSS -- checking AFTER the switch reports a clean ` +
          `tree only because the dirt moved with you, onto the outer tool's branch. It is a ` +
          `TEST rather than a bare command, since \`--porcelain\` exits 0 either way, and it ` +
          `is CHAINED because a reader copies a line, not its intent. ` +
          `(3) The switch and the delete stay \`&&\`-chained: unchained, a FAILED switch ` +
          `still runs the -D, which git refuses only for the CHECKED-OUT branch -- so every ` +
          `other branch this run created, the section 10-d retro branch included, is deleted ` +
          `while the tree stays on the lane branch it was meant to leave. ` +
          `(4) The delete is PLURAL, and the closing \`--list\` check is the IN-PLACE twin ` +
          `of the MAIN-CHECKOUT arm's. ` +
          `Anything that MOVES LAUNCH_BRANCH (pull / merge / rebase / reset) re-introduces ` +
          `the withdrawn fast-forward clause; anything that DELETES it destroys the outer ` +
          `tool's branch.`
      ).toEqual(PRESCRIBED);
    });

    it('never deletes or moves LAUNCH_BRANCH itself, in either block', () => {
      for (const [name, block] of [['restore', restore!], ['fallback', fallback!]] as const) {
        for (const raw of commandLines(block)) {
          // Strip a leading `&&` / `||`: this contract's own recipes are CHAINED,
          // so an anchored `^git` was blind to `&& git branch -D <LAUNCH_BRANCH>`
          // -- the single worst edit -- and to `&& git push --force`.
          const line = raw.replace(/^(&&|\|\|)\s*/, '');
          expect(
            line,
            `references/ship.md's ${name} block line \`${line}\` targets LAUNCH_BRANCH with a ` +
              `destructive or history-moving verb.`
            // `(\s|$)` rather than `\b`: a word boundary also matches the hyphen
            // in `git merge-base --is-ancestor`, a READ that moves nothing, so
            // `\b` would block a correct future edit.
          ).not.toMatch(
            /^git (branch -D|branch -d|branch --force|branch -f|switch -C|checkout -B|symbolic-ref|pull|merge|rebase|reset|push|update-ref|fetch)(\s|$).*LAUNCH_BRANCH/
          );
        }
      }
    });

    it("the fallback never names LAUNCH_BRANCH, and still deletes this run's branches", () => {
      // The fallback fires precisely when LAUNCH_BRANCH is empty or dangling, so
      // it must not hand the name to ANY command -- the empty-argument class of
      // bug this skill documents elsewhere. The existence probe that chooses
      // between the two arms now lives in the RESTORE block, above the decision,
      // so nothing legitimate is left to name it here.
      expect(
        fallback!,
        `references/ship.md's fallback block names LAUNCH_BRANCH. That value is empty or ` +
          `dangling on every path that reaches this block; the probe that reads it belongs ` +
          `in the restore block, before the arm is chosen.`
      ).not.toContain('LAUNCH_BRANCH');
      expect(fallback!, 'the fallback must still be the DETACH arm').toContain('--detach origin/main');
      expect(commandLines(fallback!), 'the fallback block is not its prescribed sequence').toEqual(
        PRESCRIBED_FALLBACK
      );
    });

    it('both blocks CHAIN their commands, so a failed step cannot run the next', () => {
      // Unchained, a FAILED switch still runs the -D. git refuses to delete only
      // the CHECKED-OUT branch, so every other branch this run created -- the
      // section 10-d retro branch among them -- is destroyed while the tree stays
      // on the lane branch it was supposed to leave: strictly worse than not
      // cleaning up, since the tree looks half-restored and the branch that would
      // let you retry is gone. The fallback carries a second instance: an
      // unchained `switch --detach` after a failed `fetch` detaches at a STALE
      // origin/main. Found on the go-to-k/cdk-local#651 sibling lane.
      for (const [name, block] of [['restore', restore!], ['fallback', fallback!]] as const) {
        const cmds = commandLines(block);
        const del = cmds.findIndex((l) => l.includes('git branch -D'));
        expect(del, `references/ship.md's ${name} block has no branch delete`).toBeGreaterThan(0);
        expect(
          // Must START with `&&`. A bare trailing `\` continuation was measured
          // as satisfying the old form while carrying NO `&&` at all.
          cmds[del]!.startsWith('&&'),
          `references/ship.md's ${name} block runs \`${cmds[del]}\` UNCHAINED. Chain it to the ` +
            `switch above with \`&&\`: on a failed switch the delete otherwise still destroys ` +
            `every branch that is not checked out.`
        ).toBe(true);
      }
    });

    it('the fallback states the CONDITION that selects it, not just that it exists', () => {
      // Measured on the go-to-k/cdk-local#651 sibling: deleting this gate left every
      // other assertion green, so the fallback read as an alternative a run could
      // take whenever it liked -- and detaching by preference is the end state
      // this whole section removes.
      expect(
        read(join('references', 'ship.md')),
        `references/ship.md no longer says WHEN the detach fallback applies. Without the ` +
          `"empty at probe time / branch is now gone" gate it reads as a free choice, and ` +
          `a run that takes it by preference leaves the outer tool's workspace detached.`
      ).toMatch(/empty at probe time[\s\S]{0,120}gone/);
    });

    it('the fallback is labelled mutually exclusive with the restore', () => {
      // Every other paired arm in ship.md carries this label; running both
      // leaves the tree detached, which is the end state this section removes.
      expect(
        read(join('references', 'ship.md')),
        `references/ship.md's detach fallback is missing the "never both" exclusivity label ` +
          `that its other paired MAIN-CHECKOUT / IN-PLACE blocks carry.`
      ).toMatch(/Fallback — run THIS block INSTEAD of the one above, never both/);
    });
  });

  it('section 5 branches in place UNCONDITIONALLY, with the old condition gone', () => {
    // Contract point (c): the lane never commits onto LAUNCH_BRANCH. Prose-only
    // until now. The condition this replaced is pinned NEGATIVELY because its
    // survival is the actual regression -- an agent reading "if the branch here
    // is detached, or its PR has already merged" branches only sometimes, and
    // the other times commits onto the outer tool's branch.
    const implement = read(join('references', 'implement.md'));
    expect(
      implement,
      `references/implement.md has reverted to branching CONDITIONALLY. The condition was ` +
        `withdrawn in go-to-k/cdkd#2417: gh pr merge --delete-branch deletes the remote of ` +
        `whatever branch the PR was opened from, so a lane that commits onto LAUNCH_BRANCH ` +
        `deletes the outer tool's branch on its way out.`
    ).not.toMatch(/If the branch here is detached, or its PR has already merged/);
    // The same condition RE-WORDED is the likelier regression than the exact
    // sentence returning; measured, "this only matters when the branch here is
    // detached or when its PR has already merged" passed the pin above.
    expect(
      implement,
      `references/implement.md re-introduces the withdrawn condition in different words. ` +
        `Branching in place is UNCONDITIONAL: a lane that branches only sometimes commits ` +
        `onto the outer tool's branch the rest of the time.`
    ).not.toMatch(/(only |just )?(matters|applies|needed|necessary)[^.\n]{0,60}(detached|already merged)/i);
    expect(implement).toMatch(/git fetch origin && git switch -c <branch> origin\/main/);
  });

  it('the restore is ordered LAST, and both files that own the ordering say so', () => {
    // Contract point (e). section 9 defers it and section 10-d performs it; if either
    // half drops its statement the run either restores too early (and 10-d
    // branches again in the same tree) or never restores at all.
    expect(read(join('references', 'ship.md'))).toMatch(/runs LAST, not per-lane/);
    expect(read(join('references', 'retro.md'))).toMatch(/LAST step of the whole run/);
  });

  describe('commandLines() -- the helper every block fence reads through', () => {
    // Direct tests, because until now this helper was exercised only INCIDENTALLY
    // by whatever the two fenced blocks happened to contain. That is enough to
    // notice it crashing and not enough to notice it mis-parsing: a helper that
    // silently keeps a trailing comment makes the ordered-equality fence above
    // report a mismatch for an edit that was correct, and the failure names the
    // BLOCK rather than the parser.
    it.each([
      ['git status --porcelain   # plain trailing comment', 'git status --porcelain'],
      // The regression: an apostrophe inside a word is not a string opener.
      ["echo the tool's name   # a real comment", "echo the tool's name"],
      // ...while a real single-quoted string still hides a `#`.
      ["git commit -m 'closes #651'", "git commit -m 'closes #651'"],
      ['git commit -m "closes #651"', 'git commit -m "closes #651"'],
      ["git branch --list '<your prefix>*'   # trailing", "git branch --list '<your prefix>*'"],
      ['git switch --no-guess <LAUNCH_BRANCH>', 'git switch --no-guess <LAUNCH_BRANCH>'],
      // `#` needs preceding whitespace to start a comment, or `refs/heads/#1`
      // style arguments would be truncated.
      ['git show-ref --verify refs/heads/x#y', 'git show-ref --verify refs/heads/x#y'],
    ])('parses %j', (line, expected) => {
      expect(commandLines(line)).toEqual([expected]);
    });

    it('drops blank lines and whole-line comments', () => {
      expect(commandLines('# a heading\n\ngit status --porcelain\n')).toEqual([
        'git status --porcelain',
      ]);
    });
  });

  describe('the withdrawn fast-forward cannot come back anywhere', () => {
    // The block-scoped fences above only see the ONE restore recipe. Measured,
    // four realistic re-introductions passed every one of them: the
    // fast-forward as its OWN fenced block; as a trailing COMMENT inside the
    // restore block (commandLines strips comments); as PROSE beside an intact
    // "AS-IS is the whole rule" paragraph, leaving the file self-contradicting;
    // and in retro.md's section 10-d command, which no block-level fence reads.
    // That matters more here than for ordinary code, because the consumer is an
    // agent that reads comments and prose AS INSTRUCTIONS. So this pair of
    // assertions is corpus-wide over the three files that own the contract.
    const OWNERS = [
      join('references', 'ship.md'),
      join('references', 'retro.md'),
      LAUNCH_MODE_DOC,
    ];

    /** Verbs that MOVE, DELETE or RE-CREATE a branch, as opposed to reading one. */
    const MOVING = new RegExp(
      GIT +
        String.raw`(?:branch\s+(?:--force|-f|-D|-d|-m|-M|--delete|--move)|switch\s+(?:-c|-C)|checkout\s+(?:-b|-B)|symbolic-ref|update-ref|pull|merge|rebase|reset|push|fetch\s+[^\n]*:)[^\n]*LAUNCH_BRANCH`
    );
    // DELETE and RENAME belong here, not just "move". Measured on the previous
    // revision: `git branch -D <LAUNCH_BRANCH>` -- the edit this contract exists
    // to prevent, and which the commit adding this fence called "the single
    // worst" -- passed, because the block-scoped blacklist sees only the two
    // selected blocks and this corpus fence covered only history-moving verbs.
    // A third fenced block carrying that one line was caught by NOTHING.

    it('NO doc in the skill aims a branch-moving verb at LAUNCH_BRANCH, in ANY context', () => {
      // Scanned over EVERY doc, not just the three that own the contract:
      // `gotchas.md` states the restore too, and scoping this to the owners let
      // an injected `git -C "<LANE_TREE>" branch -D <LAUNCH_BRANCH>` there pass
      // green (measured). The set of files that MENTION the command is wider
      // than the set that DEFINES it, and it is the mention that misleads.
      // TWO scans, because prose and code need opposite treatment -- and running
      // one scan over both was a LIVE GAP, not a tidiness issue.
      //
      // PROSE needs a carve-out: without it the scan forbids the skill from
      // documenting its own hazard ("Never `git reset --hard` while
      // `LAUNCH_BRANCH` is checked out" reads as a violation), and a fence that
      // blocks the correct edit is one the next person weakens. The carve-out is
      // scoped to a NEGATION in the same sentence, so an approving mention
      // cannot spend it.
      //
      // CODE must get NO carve-out, and must be read a LINE at a time. A command
      // is a command: nothing about a nearby sentence makes it safe. Measured
      // after the carve-out shipped in go-to-k/cdkd#2446 -- joining lines into
      // "sentences" makes a whole fenced block ONE sentence, so a block sitting
      // near a negation inherited its exemption, and
      // `git branch -f <LAUNCH_BRANCH> origin/main` added to a launch-mode.md
      // block was NOT caught. The restore and fallback blocks are covered by
      // their ordered equality; every OTHER block in every OTHER file was not.
      // The carve-out is a NEGATION IMMEDIATELY BEFORE the command, not a marker
      // loose in the surrounding text. Measured on the go-to-k/cdk-local#651
      // sibling, whose round-3 version allowed the marker anywhere in the clause:
      // eleven PRESCRIPTIVE sentences its previous form had flagged became exempt,
      // including the composite mutant's own
      // `git branch --force <LAUNCH_BRANCH> origin/main`. The same held here with a
      // narrower set -- "Clean up with `git branch -D <LAUNCH_BRANCH>` -- you
      // cannot leave it dangling" spent the exemption on a `cannot` that negated
      // something else entirely. A word in the neighbourhood is not a prohibition;
      // a word in FRONT of the verb is.
      const FORBIDS = /\b(never|do not|don't|must not|no verb may)\b[^.\n]{0,24}$/i;
      const fenced = /^[ \t]*```[\s\S]*?^[ \t]*```/gm;
      const hits = skillDocs().flatMap((doc) => {
        const text = read(doc);
        const inCode = (text.match(fenced) ?? [])
          .flatMap((block) => block.split('\n'))
          .filter((line) => MOVING.test(line))
          .map((line) => `${doc} [code]: ${MOVING.exec(line)?.[0]}`);
        // Windows are bounded by PARAGRAPHS and by TABLE ROWS as well as by
        // sentences. A markdown table contains no sentence-ending period, so
        // splitting on `.` alone makes an entire table one window and lets any
        // row's wording carve every other row -- the same over-joining that made
        // a whole fenced block inherit one exemption (go-to-k/cdkd#2448).
        const inProse = text
          .replace(fenced, '')
          .split(/\n{2,}|(?=^[ \t]*\|)|(?<=\|[ \t]*)$/m)
          .flatMap((para) => para.replace(/\s*\n\s*/g, ' ').split(/(?<=\.)\s+/))
          .flatMap((win) => {
            const hit = MOVING.exec(win);
            if (!hit) return [];
            // Adjacency: does a prohibition sit immediately in front of THIS match?
            return FORBIDS.test(win.slice(0, hit.index)) ? [] : [`${doc} [prose]: ${hit[0]}`];
          });
        return [...inCode, ...inProse];
      });
      expect(
        hits,
        `A skill doc aims a branch-moving verb at LAUNCH_BRANCH. That branch is the outer ` +
          `tool's and this run restores it AS-IS: no verb may move, delete, re-create or ` +
          `force it -- not in a fenced block, not in a comment, not in prose. The ` +
          `block-scoped fences cannot see this; they read one recipe.`
      ).toEqual([]);
    });

    for (const doc of OWNERS) {
      it(`${doc} still SAYS the restore is as-is (the polarity check needs a subject)`, () => {
        // Non-vacuity guard. The check below filters lines and asserts the
        // result is empty, so a file with NO mention of fast-forwarding passes
        // it trivially -- and that is not hypothetical: the commit that first
        // added the check also deleted retro.md's "no pull, no rebase, no
        // fast-forward", leaving the new fence with nothing to see, in the same
        // diff. Pin that the subject exists before judging its polarity.
        expect(
          read(doc),
          `${doc} no longer states the AS-IS rule at all, so the polarity assertion below ` +
            `has no subject and would pass vacuously. Every file that owns part of this ` +
            `contract must SAY the restore does not fast-forward.`
        ).toMatch(/no pull, no rebase, no fast-forward/);
      });

      it(`${doc} mentions fast-forwarding LAUNCH_BRANCH only to FORBID it`, () => {
        // The withdrawal narrative legitimately puts the two near each other, so
        // this asserts POLARITY rather than absence. Two things are load-bearing:
        //
        // SENTENCES, not lines -- these files are hard-wrapped at ~80 columns, so
        // a sentence's negation routinely sits on a different line from its verb.
        //
        // Explicit WITHDRAWAL markers, not any negation word. Measured: the
        // generic form passed `Fast-forward LAUNCH_BRANCH to origin/main so the
        // branch is not left stale.` -- a negation of staleness, not of the
        // fast-forward. The marker set below cannot be satisfied by an unrelated
        // "not" elsewhere in the sentence.
        const WITHDRAWN = /\b(withdrawn|forbid\w*|never|no pull, no rebase, no fast-forward)\b/i;
        const offenders = read(doc)
          .replace(/\s*\n\s*/g, ' ')
          .split(/(?<=\.)\s+/)
          .filter((sent) => /fast-forward/i.test(sent) && /LAUNCH_BRANCH/.test(sent))
          .filter((sent) => !WITHDRAWN.test(sent));
        expect(
          offenders,
          `${doc} pairs "fast-forward" with LAUNCH_BRANCH in a line that does not negate it. ` +
            `The clause was WITHDRAWN (go-to-k/cdkd#2417): restoring the branch is the point, ` +
            `and a fast-forward is an edit to somebody else's artifact.`
        ).toEqual([]);
      });
    }
  });

  it('no site anywhere in .claude/** switches to LAUNCH_BRANCH without --no-guess', () => {
    // Repo-wide, not per-file: the restore command is STATED in several places
    // (ship.md's recipe, retro.md's section 10-d which actually fires it, and
    // gotchas.md's Stop-hook entry), and a `--no-guess`-less copy at ANY of them
    // is a copy that re-creates the outer tool's branch from `origin` and
    // reports success. Measured on the go-to-k/cdk-local#651 sibling, whose port
    // of this fix caught exactly that at two sites the scope had missed --
    // including the one that executes.
    const offenders: string[] = [];
    for (const doc of skillDocs()) {
      read(doc)
        .replace(/\s*\n\s*/g, ' ')
        .split(/(?<=\.)\s+/)
        .filter((sent) =>
          new RegExp(GIT + String.raw`switch\s+(?!--no-guess|--detach)[^\n]{0,40}LAUNCH_BRANCH`).test(sent)
        )
        .forEach((sent) => offenders.push(`${doc}: ${sent.slice(0, 100)}`));
    }
    expect(
      offenders,
      `A copy of the restore command switches to LAUNCH_BRANCH without --no-guess. Plain ` +
        `\`git switch <name>\` DWIMs: with the branch gone locally but present on origin it ` +
        `CREATES it from the remote, exits 0 and sets tracking -- re-creating the outer ` +
        `tool's branch at origin's tip, on exactly the path that should have fallen through ` +
        `to the detach fallback.`
    ).toEqual([]);
  });

  describe('the probe, executed', () => {
    /**
     * Runs the doc's OWN fenced probe -- extracted, not re-typed -- against a
     * throwaway repo and a linked worktree of it. A copy re-typed here would
     * pass while the shipped one was broken, which is the whole failure this
     * test is for.
     */
    const block = firstBashBlock(read(LAUNCH_MODE_DOC));

    it('extracts a non-vacuous probe block from the doc', () => {
      expect(block, `no fenced bash block found in ${LAUNCH_MODE_DOC}`).not.toBeNull();
      expect(block!).toContain(PROBE_TOKEN);
      expect(block!).toContain('MAIN-CHECKOUT');
      expect(block!).toContain('IN-PLACE');
      expect(block!).toContain('LAUNCH_BRANCH');
    });

    it('answers MAIN-CHECKOUT in a main checkout and IN-PLACE in a linked worktree', () => {
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wi-launch-mode-')));
      try {
        const main = join(tmp, 'main');
        const lane = join(tmp, 'lane');
        const script = join(tmp, 'probe.sh');
        writeFileSync(script, `${block}\n`);
        // Hermetic: a user's global config (hooksPath, templates, signing) must
        // not decide whether this test passes.
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
        const git = (args: string[], cwd = tmp) =>
          execFileSync('git', args, { cwd, env, encoding: 'utf8' });
        // Explicit initial branch: the probe's LAUNCH_BRANCH assertion below must
        // not depend on whichever default this git build compiles in.
        git(['init', '-q', '-b', 'probe-main', main]);
        git(['-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
        git(['-C', main, 'worktree', 'add', '-q', lane, '-b', 'lane-branch']);

        const run = (cwd: string) =>
          Object.fromEntries(
            execFileSync('bash', [script], { cwd, env, encoding: 'utf8' })
              .trim()
              .split('\n')
              .map((l) => {
                const at = l.indexOf('=');
                return [l.slice(0, at), l.slice(at + 1)] as const;
              })
          );

        const fromMain = run(main);
        // The key SET, in order. Without this a stray line -- a debug echo, a
        // fifth value someone added -- parses into the map unnoticed, and a
        // non-`=` line becomes a garbage key while all four value assertions
        // below still pass. Order-pinning also fences the printf's field list
        // against being reordered out of step with its arguments.
        expect(Object.keys(fromMain)).toEqual(['MODE', 'LANE_TREE', 'MAIN_CHECKOUT', 'LAUNCH_BRANCH']);
        expect(fromMain.MODE).toBe('MAIN-CHECKOUT');
        expect(fromMain.LANE_TREE).toBe(main);
        expect(fromMain.MAIN_CHECKOUT).toBe(main);
        expect(fromMain.LAUNCH_BRANCH).toBe('probe-main');

        const fromLane = run(lane);
        expect(Object.keys(fromLane)).toEqual(['MODE', 'LANE_TREE', 'MAIN_CHECKOUT', 'LAUNCH_BRANCH']);
        expect(fromLane.MODE).toBe('IN-PLACE');
        // The value section 9 puts back. Read at probe time and NEVER re-derived:
        // section 5 switches this tree onto the lane's own branch, after which
        // `git branch --show-current` answers with that one instead.
        expect(fromLane.LAUNCH_BRANCH).toBe('lane-branch');
        // The two values differing IS the mode, and MAIN_CHECKOUT must point at
        // the OTHER tree -- that is the value section 2's collision scan needs
        // and the one a `pwd`- or `--show-toplevel`-derived probe gets wrong.
        expect(fromLane.LANE_TREE).toBe(lane);
        expect(fromLane.MAIN_CHECKOUT).toBe(main);

        // Launched DETACHED: LAUNCH_BRANCH is empty, and that is an ANSWER, not a
        // failure -- it is what selects section 9's detach fallback over the
        // restore. The mode verdict must be unaffected, since a detached worktree
        // is still a worktree.
        git(['-C', lane, 'switch', '--detach', 'HEAD']);
        const fromDetachedLane = run(lane);
        expect(Object.keys(fromDetachedLane)).toEqual(['MODE', 'LANE_TREE', 'MAIN_CHECKOUT', 'LAUNCH_BRANCH']);
        expect(fromDetachedLane.MODE).toBe('IN-PLACE');
        expect(fromDetachedLane.LANE_TREE).toBe(lane);
        expect(fromDetachedLane.LAUNCH_BRANCH).toBe('');
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('refuses to answer outside a work tree instead of printing a wrong verdict', () => {
      // The dangerous failure is not an error, it is a CONFIDENT MAIN-CHECKOUT:
      // with every `git rev-parse` failing, an unguarded compare tests "" against
      // "" and says "main checkout" while standing nowhere. Inside `.git` the
      // trap is subtler still -- `--is-inside-work-tree` prints `false` and exits
      // ZERO there, so an exit-status guard passes and yields an empty LANE_TREE.
      const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'wi-launch-mode-neg-')));
      try {
        const main = join(tmp, 'main');
        const script = join(tmp, 'probe.sh');
        writeFileSync(script, `${block}\n`);
        const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
        execFileSync('git', ['init', '-q', main], { cwd: tmp, env, encoding: 'utf8' });

        for (const cwd of [tmp, join(main, '.git')]) {
          let failed = false;
          let output = '';
          try {
            output = execFileSync('bash', [script], { cwd, env, encoding: 'utf8', stdio: 'pipe' });
          } catch (e) {
            failed = true;
            output = String((e as { stdout?: string }).stdout ?? '');
          }
          expect(failed, `the probe answered "${output.trim()}" from ${cwd} instead of failing`).toBe(true);
          expect(output).not.toContain('MODE=');
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});

/**
 * §2's per-worktree probe must range over the BRANCH, not one commit.
 *
 * WHY HERE. This file already owns "a withdrawn command cannot come back", and
 * that is exactly the failure mode: `show --stat HEAD` reads ONE commit, so a
 * lane several commits deep is under-reported and the collision scan calls a
 * held file free. Measured 2026-09-05 on a worktree ten commits ahead of
 * `origin/main` — `show --stat HEAD` reported 1 of the 5 files it held, hiding
 * `CLAUDE.md`, and a triage sub-agent reported "no collision" on that basis.
 * Nothing mechanical watched the probe, so a future edit could silently restore
 * the single-commit form and every suite would stay green (the same argument
 * this file's header makes for the launch-mode section).
 *
 * The fence is deliberately scoped to COMMAND LINES. The rationale prose beside
 * the block has to keep naming `show --stat HEAD` to say what was wrong with it,
 * and a blanket ban would forbid the explanation — so the two halves are pinned
 * in OPPOSITE directions: absent from the commands, PRESENT in the prose. A cap
 * with no floor rewards the inverse regression (deleting the rationale would
 * otherwise read as a pass), which is the rule this same run added to
 * `.claude/rules/testing.md`.
 */
describe('work-issues section 2 worktree probe', () => {
  const TRIAGE = join('references', 'triage.md');

  /**
   * ONE extraction feeds every case below, and getting it right took five
   * drafts -- each of which passed its own battery, because each battery varied
   * only what the PREVIOUS round had found. That is the whole lesson: a fence's
   * battery inherits the imagination of the round that wrote it.
   *
   * Draft 2 used `bashBlocks`, which sees only a column-0 ```bash fence, so the
   * withdrawn command survived as ```sh, bare ```, or indented. Draft 3 went
   * line-based and closed those while going blind to every command whose line
   * does not START with git (`cd … && git show`, a `for` body, an `env` prefix,
   * a `\`-continuation) -- and regressed the FLOOR with it. Draft 4 took the
   * union but still anchored the outside-fence half on a line-leading git, so a
   * list item, blockquote or table cell escaped. Draft 5 widened that to a
   * character class, which still let `**git …**`, `"git …"`, `[git …](#x)` and
   * `<code>git …</code>` through -- a class enumerating delimiters is the same
   * mistake one level down.
   *
   * So the matcher is now the weakest thing that cannot be evaded by
   * PUNCTUATION: the token itself. Measured across all 11 docs, that yields
   * zero false positives for the ban.
   *
   * `bashBlocks` is deliberately untouched -- the section 9 block fences depend
   * on its contract, and widening a shared recogniser to suit one caller is how
   * those change meaning silently.
   */
  const scanFences = (text: string): { fenced: boolean[]; unterminated: boolean } => {
    // Tracks the OPENING run's char and length. A plain toggle desyncs on a
    // nested or four-backtick fence -- the inner marker flips it CLOSED and
    // every later line reads inverted -- and ignores ~~~ entirely.
    let open: string | null = null;
    const fenced = text.split('\n').map((line) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(line);
      if (m) {
        const run = m[1]!;
        if (open === null) {
          open = run;
          return false;
        }
        if (run[0] === open[0] && run.length >= open.length) {
          open = null;
          return false;
        }
      }
      return open !== null;
    });
    return { fenced, unterminated: open !== null };
  };

  /** The git TOKEN, anywhere. Not a delimiter class -- see the note above. */
  const CONTAINS_GIT = /\bgit\b/;
  /** First token is a git call. Narrow, and used only to exclude prose from the floor. */
  const GIT_LINE = /^\s*\$?\s*git\b/;

  const commandUnits = (doc: string): string[] => {
    const text = read(doc);
    const { fenced } = scanFences(text);
    const picked: Array<{ i: number; line: string }> = [];
    text.split('\n').forEach((line, i) => {
      if (fenced[i] || CONTAINS_GIT.test(line)) picked.push({ i, line });
    });
    // Join `\` continuations, but only across ADJACENT source lines: `picked`
    // is filtered, so an index-blind join fuses a `\`-terminated line with the
    // next PICKED line anywhere later and fabricates a command that never
    // existed. (Outside a fence the continuation line usually carries no `git`
    // and so is never picked -- the join is effective inside fences, which is
    // where the skill's wrapped commands live.)
    const units: string[] = [];
    let previousIndex = -2;
    for (const { i, line } of picked) {
      const prev = units[units.length - 1];
      if (prev !== undefined && i === previousIndex + 1 && /\\\s*$/.test(prev)) {
        units[units.length - 1] = `${prev.replace(/\\\s*$/, ' ')}${line.trim()}`;
      } else {
        units.push(line);
      }
      previousIndex = i;
    }
    return units;
  };

  /**
   * `git … show … --stat`-family, either flag order. `show\s+` is what excludes
   * `--show-current`: a `-` follows the word, so `\s+` cannot match. Measured,
   * because an earlier revision credited the `(?<![-\w])` lookbehind for that
   * and the lookbehind is INERT here -- it only blocks a `show` glued to a
   * preceding word or dash (`--show `, `reshow `). Kept as belt-and-braces, and
   * described as that rather than as the thing doing the work.
   */
  const SINGLE_COMMIT =
    /\bgit\b.*(?<![-\w])show\s+.*--(?:[a-z-]*stat\b|name-only\b|name-status\b)/;

  /**
   * A peer-worktree probe addresses `<MAIN_CHECKOUT>`. That qualifier is what
   * lets ONE wide extraction serve both questions: `launch-mode.md` discusses
   * this probe in prose, and its bullet naming the WRONG relative form
   * (`.claude/worktrees/<w>`, no `<MAIN_CHECKOUT>`) was reported as a duplicate
   * when the predicate was the bare token. A doc talking about the probe is not
   * a second copy of it.
   */
  const peerProbes = (doc: string): string[] =>
    commandUnits(doc).filter((u) => /<MAIN_CHECKOUT>[^\n]*worktrees\/<w>/.test(u));

  it('every doc closes its fences, so the scan cannot read inverted', () => {
    // Asserts the STATE MACHINE, not marker parity. A parity count fails on a
    // legitimate nested fence (three markers, balanced) and passes on an
    // unterminated four-backtick one (two markers) -- both measured, and both
    // the wrong answer.
    const unterminated = skillDocs().filter((doc) => scanFences(read(doc)).unterminated);
    expect(unterminated, 'an unterminated fence makes every later line read as a command').toEqual(
      [],
    );
  });

  it('only section 2 probes a peer worktree', () => {
    expect(
      skillDocs().filter((doc) => peerProbes(doc).length > 0),
      'the per-worktree probe belongs to section 2 and nowhere else; a second copy drifts',
    ).toEqual([TRIAGE]);
  });

  it('ranges over origin/main...HEAD, and no doc still reads a single commit', () => {
    const probes = peerProbes(TRIAGE);
    expect(probes.length, 'the per-worktree probe is gone from section 2').toBeGreaterThan(0);
    expect(
      probes.some((u) => u.includes('diff --name-only origin/main...HEAD')),
      `the probe must range over the branch; its commands were:\n${probes.join('\n')}`,
    ).toBe(true);

    const singleCommit = skillDocs().flatMap((doc) =>
      commandUnits(doc)
        .filter((u) => SINGLE_COMMIT.test(u))
        .map((u) => `${doc}: ${u.trim()}`),
    );
    expect(
      singleCommit,
      'a `git show --stat` reads ONE commit and under-reports a multi-commit lane; that form ' +
        'was withdrawn on 2026-09-05. PROSE IS SCANNED TOO, so naming it in an explanation ' +
        'means writing the flags WITHOUT the literal `git` token, the way triage.md section 2 ' +
        'does -- which is also why the floor below looks for `show --stat HEAD` and not for ' +
        'the whole command',
    ).toEqual([]);
  });

  it('still explains WHY the range is load-bearing, in prose', () => {
    // The FLOOR, and the half that has broken twice. Prose means: outside every
    // fence, not a command, not a comment, not an indented code block, and not
    // inside an HTML comment -- a `<!-- … -->` carrier satisfied this while
    // rendering invisible.
    const text = read(TRIAGE).replace(/<!--[\s\S]*?-->/g, '');
    const { fenced } = scanFences(text);
    const prose = text
      .split('\n')
      .filter(
        (line, i) =>
          !fenced[i] && !GIT_LINE.test(line) && !/^\s*#/.test(line) && !/^ {4,}\S/.test(line),
      )
      .join('\n');
    expect(
      prose,
      'the paragraph naming what `show --stat HEAD` got wrong is the reason the range exists',
    ).toContain('show --stat HEAD');
  });
});
