import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Fences the shape that keeps cdkd's PreToolUse gates immune to the
 * `cd <worktree> && <command>` bypass.
 *
 * The bypass is real, and it was measured in a sibling repo. In
 * go-to-k/cdk-real-drift, PreToolUse entries matched narrowed command forms
 * (`Bash(git commit:*)`), and four gates carried a `Bash(cd * && ...)`
 * alternative while three did not -- so `cd <wt> && git commit` ran UNGATED
 * and `cd <wt> && gh pr create` skipped both the verify-pr and English-only
 * gates. That was fixed there in go-to-k/cdk-real-drift#1788, and
 * go-to-k/cdkd#2016 asked whether cdkd carries the same asymmetry, since the
 * hooks were ported between the repos and `/work-issues` now instructs agents
 * to write commands in exactly that `cd <worktree> && ...` form.
 *
 * cdkd does NOT carry it, and the reason is structural rather than lucky: its
 * Bash-targeting PreToolUse entries use the COARSE `Bash` matcher, so every
 * Bash call reaches every gate and each gate parses the command itself.
 * Measured 2026-08-19 by feeding both spellings to the gates directly:
 *
 *   check-gate.sh     bare `git commit -m ...`               -> rc=2
 *   check-gate.sh     `cd <wt> && git commit -m ...`         -> rc=2
 *   verify-pr-gate.sh bare `gh pr create ...`                -> rc=2
 *   verify-pr-gate.sh `cd <wt> && gh pr create ...`          -> rc=2
 *
 * The danger is therefore not a bug to fix but a regression to prevent:
 * narrowing any of these matchers to a command-specific form would silently
 * reopen the bypass, and an ungated command is indistinguishable from one that
 * passed. Hence a test rather than a comment.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS = join(repoRoot, '.claude', 'settings.json');

interface HookEntry {
  matcher?: string;
  hooks?: { command?: string }[];
}

function preToolUseEntries(): HookEntry[] {
  const raw = JSON.parse(readFileSync(SETTINGS, 'utf8')) as {
    hooks?: { PreToolUse?: HookEntry[] };
  };
  return raw.hooks?.PreToolUse ?? [];
}

/** Alternatives of a `A|B|C` matcher, trimmed. */
function alternatives(matcher: string): string[] {
  return matcher
    .split('|')
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Entries whose matcher targets the Bash tool at all. */
function bashEntries(entries: HookEntry[]): HookEntry[] {
  return entries.filter((e) =>
    alternatives(e.matcher ?? '').some((a) => a === 'Bash' || a.startsWith('Bash(')),
  );
}

describe('.claude/settings.json PreToolUse Bash matchers', () => {
  it('parses the file and finds Bash-targeting entries (floor)', () => {
    // Floor for every assertion below. Without it a renamed key or a changed
    // file shape would make this suite pass by asserting over an empty list --
    // the "a lint must prove it sees its input" trap.
    const entries = preToolUseEntries();
    expect(entries.length).toBeGreaterThanOrEqual(3);

    const bash = bashEntries(entries);
    expect(bash.length).toBeGreaterThanOrEqual(2);

    const gateCount = bash.reduce((n, e) => n + (e.hooks?.length ?? 0), 0);
    // 31 gates registered against Bash as of 2026-08-19. A floor, not a pin:
    // adding gates is routine, losing most of them is the regression.
    expect(gateCount).toBeGreaterThanOrEqual(20);
  });

  it('never narrows a Bash matcher to a command-specific form', () => {
    // This is the whole point. `Bash` reaches every gate for every command,
    // including the `cd <worktree> && ...` form. `Bash(git commit:*)` does
    // not, and its `cd` twin has to be spelled out separately -- which is the
    // asymmetry that produced a live, silent gate bypass in the sibling repo.
    const narrowed: string[] = [];
    for (const entry of bashEntries(preToolUseEntries())) {
      for (const alt of alternatives(entry.matcher ?? '')) {
        if (alt.startsWith('Bash(')) narrowed.push(alt);
      }
    }

    expect(
      narrowed,
      narrowed.length === 0
        ? ''
        : [
            'A PreToolUse matcher was narrowed to a command-specific Bash form:',
            ...narrowed.map((n) => `  ${n}`),
            '',
            'That reopens the `cd <worktree> && <command>` bypass fixed in',
            'go-to-k/cdk-real-drift#1788: the narrowed form matches only the bare',
            'spelling, so the same command written with a `cd` prefix -- the form',
            '/work-issues section 9 tells agents to use -- runs UNGATED, and an',
            'ungated command is indistinguishable from one that passed.',
            '',
            'Either keep the coarse `Bash` matcher, or add a `Bash(cd * && ...)`',
            'twin for every narrowed form and update this test to check the pairing.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('registers the gates that must see both command spellings', () => {
    // These three are the ones go-to-k/cdkd#2016 named as lacking a `cd` twin
    // in the sibling repo. Here they must be registered under a coarse `Bash`
    // matcher, which is what makes both spellings reach them.
    const mustBeCoarse = ['check-gate', 'verify-pr-gate', 'non-english-text-gate'];

    const coarseGates = new Set<string>();
    for (const entry of preToolUseEntries()) {
      if (!alternatives(entry.matcher ?? '').includes('Bash')) continue;
      for (const hook of entry.hooks ?? []) {
        const name = /([a-z0-9-]+)\.sh/.exec(hook.command ?? '')?.[1];
        if (name) coarseGates.add(name);
      }
    }

    for (const gate of mustBeCoarse) {
      expect(coarseGates, `${gate} must be registered under a coarse Bash matcher`).toContain(
        gate,
      );
    }
  });
});
