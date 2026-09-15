/**
 * marker-skill-mise-trust-sync — every skill that RECORDS a markgate marker
 * must also carry `mise trust`.
 *
 * `.claude/skills/check/SKILL.md` step 0 states the claim this fences:
 * `/check-docs`, `/verify-pr`, `/run-integ` and `/review-pr` all end in
 * `mise exec -- markgate set`, so each carries a pointer back to that
 * paragraph rather than a fifth copy of it. That is a multi-copy claim with
 * no mechanism behind it, which is the shape
 * `tests/unit/scripts/security-surface-list-sync.test.ts` exists for one
 * layer over: true when written, silently false the first time a sixth skill
 * starts writing markers.
 *
 * What goes wrong when it lapses is specifically bad. An untrusted
 * `.mise.toml` in a fresh worktree fails NO check — it fails the LAST step,
 * `markgate set`, with a config-parse error that names no file and never says
 * "trust" (issue go-to-k/cdkd#1853). For `/run-integ` that error arrives
 * after a real-AWS deploy + destroy, so the cost of the regression is a
 * burned run, not a retry.
 *
 * POPULATION IS DERIVED, NOT LISTED. A hand list is the thing that rots —
 * this walks every `.claude/skills/**\/*.md` and selects the files that
 * invoke `markgate set` in COMMAND position inside a fenced code block. Two
 * details are load-bearing and were both measured while writing this:
 *
 *   - the fence regex allows LEADING WHITESPACE (`^[ \t]*```), because
 *     `/run-integ` and `/review-pr` indent their blocks inside a numbered
 *     list. Without it the walk found three of the five files and would have
 *     passed while fencing nothing for the two that matter most.
 *   - only FENCED blocks count. Every one of these files also mentions
 *     `markgate set` in backticked prose, and several `.claude/skills/
 *     work-issues/references/*.md` files discuss it without recording
 *     anything — selecting on prose would put those in the population and
 *     demand `mise trust` from files that run no command.
 *
 * The floor is what stops the derivation collapsing: a regex that silently
 * stops matching yields an EMPTY population, and "every member satisfies the
 * rule" is vacuously true of the empty set.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const skillsDir = join(process.cwd(), '.claude', 'skills');

/** Every `.md` under `.claude/skills/`, recursively. */
function skillMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...skillMarkdownFiles(p));
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out.sort();
}

/** The fenced blocks of a markdown document, indented fences included. */
function fencedBlocks(text: string): string[] {
  return text.split(/^[ \t]*```/m).filter((_, i) => i % 2 === 1);
}

/** `markgate set <key>` in command position — after a line start, `&&` or `||`. */
const MARKGATE_SET = /(?:^|\n|&&|\|\|)[ \t]*(?:mise exec -- )?markgate set [a-z-]/;

/**
 * `mise trust` in COMMAND position, the same shape as `MARKGATE_SET`.
 *
 * A whole-file `includes('mise trust')` was the first cut and it was INERT
 * against the regression this file exists for: review probed it by deleting
 * the executable `mise trust` from `/run-integ`'s block and rewriting the
 * prose to "Do NOT run `mise trust` here", and all seven cases stayed green.
 * Three of the five selected files carried it only as prose or as a `#`
 * comment INSIDE the block, which is precisely the inadequacy the sibling
 * `/run-integ` edit in this same change argues against ("part of the pasted
 * block rather than a caveat above it"). A fence that would pass a straight
 * revert of the fix is not a fence.
 */
const MISE_TRUST = /(?:^|\n|&&|\|\|)[ \t]*mise trust\b/;

/**
 * Measured 2026-09-15: check, check-docs, review-pr, run-integ, verify-pr.
 * A floor rather than an equality so a SIXTH marker-setting skill is a new
 * obligation rather than a red test — but a drop to four means the selection
 * broke, and to zero means it collapsed.
 */
const MIN_MARKER_SETTING_SKILLS = 5;

describe('marker-setting skills carry mise trust', () => {
  const files = skillMarkdownFiles(skillsDir);
  const markerSetters = files.filter((f) =>
    fencedBlocks(readFileSync(f, 'utf8')).some((b) => MARKGATE_SET.test(b)),
  );

  it(`finds at least ${MIN_MARKER_SETTING_SKILLS} skill files that record a marker`, () => {
    expect(
      markerSetters.length,
      `Only ${markerSetters.length} skill file(s) were selected as recording a markgate ` +
        `marker, below the floor of ${MIN_MARKER_SETTING_SKILLS}. Either a skill stopped ` +
        `setting markers (update the floor deliberately) or the selection broke — check ` +
        `the fenced-block split first, which must tolerate an INDENTED \`\`\` fence. ` +
        `Selected: ${markerSetters.map((f) => f.replace(process.cwd() + '/', '')).join(', ') || '(none)'}`,
    ).toBeGreaterThanOrEqual(MIN_MARKER_SETTING_SKILLS);
  });

  it('walks the whole skills corpus, not a fragment', () => {
    // Independent of the floor above: moving `work-issues/references/` out
    // reds this at 16 while all five setters are still found and checked. It
    // says the WALK is intact, which the selection floor cannot.
    expect(
      files.length,
      `The skills walk returned ${files.length} markdown files, far below the corpus this ` +
        `repo carries — the walk, not the selection, has broken.`,
    ).toBeGreaterThan(20);
  });

  for (const file of markerSetters) {
    const rel = file.replace(process.cwd() + '/', '');
    it(`${rel} RUNS mise trust in a fenced block`, () => {
      expect(
        fencedBlocks(readFileSync(file, 'utf8')).some((b) => MISE_TRUST.test(b)),
        `${rel} records a markgate marker but never RUNS \`mise trust\` in a fenced ` +
          `block — a mention in prose or in a \`#\` comment does not count, because a ` +
          `session pastes the block. In a fresh worktree an untrusted .mise.toml makes ` +
          `\`markgate set\` fail with a config-parse error that names no file and never ` +
          `says "trust", so the session cannot commit and the error points at a dead end ` +
          `(go-to-k/cdkd#1853); for /run-integ it arrives after a real-AWS deploy and ` +
          `destroy. Put \`mise trust\` in the block, and keep the one-line pointer to ` +
          `/check step 0, which owns the full account.`,
      ).toBe(true);
    });
  }
});
