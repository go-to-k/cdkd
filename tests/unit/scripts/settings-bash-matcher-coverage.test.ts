import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Fences the shape that keeps cdkd's PreToolUse gates reachable for EVERY
 * spelling of a gated command, including the `cd <worktree> && ...` form a lane
 * driving commands at its own worktree naturally writes.
 *
 * The load-bearing field is `if:`, not `matcher:` -- and that correction is the
 * whole reason this file says what it says. go-to-k/cdkd#2016 asked whether cdkd
 * carries the gate BYPASS fixed in go-to-k/cdk-real-drift#1788, and described it
 * as an asymmetry between gates. The first pass of this test attributed the
 * sibling's immunity gap to narrowed `Bash(...)` MATCHERS and fenced that.
 * Measured 2026-08-19 against the sibling's own pre-fix settings
 * (`git show b6a4213^:.claude/settings.json` in cdk-real-drift), that was wrong:
 * its matcher is the coarse `"Bash"`, identical to cdkd's. The `cd * && ...`
 * alternatives lived in each hook's per-hook `if:` condition, and the asymmetry
 * was between hooks that spelled the `cd` twin there and hooks that did not --
 * `branch-gate` and `bughunt-clean-gate` carried `Bash(cd * && git commit*)`
 * while `check-gate` carried only `Bash(git commit*) or Bash(git -C * commit*)`.
 *
 * cdkd is immune for a different reason than "coarse matchers": it carries ZERO
 * `if:` fields (0 of 32, measured the same day). They were removed under
 * go-to-k/cdkd#1455 / go-to-k/cdkd#1476 after being measured to never fire at
 * all from project settings -- so every gate in the Bash entry runs on every
 * Bash call and parses the command itself, which is why several of them can
 * advertise that they also catch the `cd <path> && ...` and `gh -C <path>`
 * spellings.
 *
 * `.claude/rules/hooks.md` already says "Do NOT reintroduce `if:`". That is a
 * sentence, and per the repo's own rule a sentence that can be violated silently
 * should be a test: re-adding an `if:` would BOTH make those gates inert again
 * (the go-to-k/cdkd#1476 defect) and reopen the sibling's `cd`-form bypass, and
 * an ungated command is indistinguishable from one that passed.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS = join(repoRoot, '.claude', 'settings.json');

interface HookSpec {
  command?: string;
  if?: unknown;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookSpec[];
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

function gateName(spec: HookSpec): string | undefined {
  return /([a-z0-9-]+)\.sh/.exec(spec.command ?? '')?.[1];
}

describe('.claude/settings.json PreToolUse gate reachability', () => {
  it('parses the file and finds the Bash-targeting gates (floor)', () => {
    // Floor for every assertion below. Without it a renamed key or a changed
    // file shape would make this suite pass by asserting over an empty list --
    // the "a lint must prove it sees its input" trap. These are FLOORS with
    // headroom, not pins on today's exact numbers: entries are routinely added.
    const entries = preToolUseEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);

    const bash = bashEntries(entries);
    expect(bash.length).toBeGreaterThanOrEqual(1);

    const gateCount = bash.reduce((n, e) => n + (e.hooks?.length ?? 0), 0);
    // 32 gates registered against Bash as of 2026-08-19.
    expect(gateCount).toBeGreaterThanOrEqual(20);
  });

  it('never reintroduces a per-hook `if:` condition', () => {
    // THE primary assertion. An `if:` in project settings was measured to make
    // its hook never fire at all (go-to-k/cdkd#1476), and it is also where the
    // sibling repo's `cd <wt> && ...` bypass lived (a gate whose `if:` spelled
    // the bare command form but not its `cd` twin ran ungated for that form).
    const offenders: string[] = [];
    for (const entry of preToolUseEntries()) {
      for (const spec of entry.hooks ?? []) {
        if ('if' in spec) offenders.push(`${gateName(spec) ?? spec.command} -> ${String(spec.if)}`);
      }
    }

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : [
            'A PreToolUse hook carries an `if:` condition:',
            ...offenders.map((o) => `  ${o}`),
            '',
            'Two separate failures follow, both silent:',
            '  1. Project-settings hooks carrying `if:` were measured never to fire',
            '     at all (go-to-k/cdkd#1455 / go-to-k/cdkd#1476) -- the gate goes',
            '     inert while still looking registered.',
            '  2. An `if:` enumerating command forms is exactly where the sibling',
            '     bypass lived (go-to-k/cdk-real-drift#1788): a condition naming',
            '     `Bash(git commit*)` but not `Bash(cd * && git commit*)` lets the',
            '     `cd`-prefixed spelling -- the form a lane driving commands at',
            '     its own worktree naturally writes -- run UNGATED.',
            '',
            'See the "The `if:` layer is GONE" section of .claude/rules/hooks.md.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('never narrows a Bash matcher to a command-specific form', () => {
    // Secondary, defence in depth. cdkd has never had a narrowed matcher and the
    // sibling's bypass did not come from one -- but a narrowed `Bash(git commit:*)`
    // would reopen the same hole by a second route, since its `cd` twin would then
    // have to be spelled out separately too.
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
            'Keep the coarse `Bash` matcher: it hands every Bash call to every gate,',
            'so each gate parses the command itself and sees every spelling.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('registers the gates that must see both command spellings', () => {
    // Catches gate REMOVAL, which neither assertion above would notice.
    // These three are the ones go-to-k/cdkd#2016 named as lacking a `cd` twin in
    // the sibling repo.
    const mustBeCoarse = ['check-gate', 'verify-pr-gate', 'non-english-text-gate'];

    const coarseGates = new Set<string>();
    for (const entry of preToolUseEntries()) {
      if (!alternatives(entry.matcher ?? '').includes('Bash')) continue;
      for (const spec of entry.hooks ?? []) {
        const name = gateName(spec);
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
