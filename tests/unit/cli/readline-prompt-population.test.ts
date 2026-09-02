import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275) was a DUPLICATION
 * defect, not nine independent oversights: six of the nine prompt helpers were
 * byte-identical, `drift`'s differed only by taking an output stream, and
 * `rollback` / `state orphan` differed only in prompt suffix. Issue #2259
 * guarded ONE copy and nine survived it, because nothing stopped copy #10.
 *
 * This is what stops copy #10. It enumerates every place in `src/` that
 * constructs a readline interface and requires each one to be listed here with
 * a reason. A new prompt written as its own `readline.createInterface` — in a
 * new file, or as a second one inside a file already on this list — reds this
 * test with a diff naming the file, and the way to make it green is to route
 * through `confirmOrRefuse` (`src/cli/commands/confirm-prompt.ts`), which
 * carries the non-interactive guard.
 *
 * WHAT THIS DOES NOT PROVE: that a listed site is correctly guarded. The
 * per-site behaviour is fenced in
 * `tests/unit/cli/non-interactive-confirm-guards.test.ts` (the nine folded
 * sites), `destroy-runner-sigint.test.ts` + `state-destroy.test.ts` (the two
 * that keep their own inline guard), and each guarded command's own suite.
 * This file only fences the POPULATION.
 *
 * CALIBRATION, measured 2026-09-02 against the pre-fix tree (`origin/main`
 * @ 4f34f8c1) with the same regex: **19 sites across 17 files** — exactly the
 * 19 `createInterface` calls a `grep -rn createInterface src/` finds there,
 * including all nine unguarded ones the issue enumerates. After the fold:
 * **11 sites across 10 files**, i.e. the nine removed and one added
 * (`confirm-prompt.ts` grew its second export). The regex is
 * CONSTRUCTION-SHAPED rather than a bare `createInterface` needle, which is
 * what keeps `drift.ts`'s JSDoc prose about `readline.createInterface` from
 * counting as a site without this file having to strip comments — a stripper
 * being the fragile part of every scanner fence this repo has written.
 *
 * The three alternatives were probed against the spellings a future
 * contributor would plausibly write, not just against the one that was
 * removed (2026-09-02). CAUGHT: `const rl = readline.createInterface(`,
 * `const rl = createInterface(` (bare named import), `let rl = ...`,
 * `const rl = await ...` (`migrate-command.ts`'s `await import` two-step),
 * `const rl=...` with no spaces, `const { question, close } = ...`
 * (destructured), and a bare statement-position `readline.createInterface(...)`
 * with no assignment at all. MISSED, deliberately: the two JSDoc prose lines
 * in `drift.ts` and a `//` comment naming `createInterface(...)`. The
 * destructured and bare-call arms were added BECAUSE the first cut missed
 * them — an assignment-only pattern is the spelling the defect happened to
 * use, not the spelling the next one will.
 *
 * Widening it changed neither count (19 pre-fix, 11 post-fix), which is the
 * check that the extra arms did not buy false positives.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * The shape a readline interface is CONSTRUCTED in: an assignment to a name, a
 * destructuring assignment, or a bare call in statement position. See the
 * calibration note above for the spellings each arm was probed against.
 */
const CREATE_INTERFACE =
  /(?:\b(?:const|let|var)\s+(?:\w+|\{[^}]*\})\s*=\s*|^[ \t]*)(?:await\s+)?(?:\w+\.)?createInterface\s*\(/gm;

/**
 * `path -> { sites, why }`. The COUNT is part of the contract, not just the
 * file: a second prompt added inside an already-listed file is exactly how
 * `state.ts` came to hold one guarded and two unguarded interfaces at once,
 * and a file-level allow-list cannot see it.
 */
const EXPECTED: Readonly<Record<string, { readonly sites: number; readonly why: string }>> = {
  'src/cli/commands/confirm-prompt.ts': {
    sites: 2,
    why:
      'THE shared helpers. `confirmOrRefuse` carries issue #2275\'s guard; ' +
      '`promptYesNo` is the deliberate default-YES carve-out whose only caller ' +
      '(`deploy.ts`) short-circuits on a non-TTY before reaching it.',
  },
  'src/cli/commands/destroy-runner.ts': {
    sites: 1,
    why:
      'The issue #2259 per-stack destroy prompt. Keeps its own inline guard: it ' +
      'has a default-YES bare form alongside a default-NO --remove-protection ' +
      'form, and it sits in the integ-destroy AND integ-broad gate scopes, so ' +
      'folding it would buy a real-AWS run for a pure refactor.',
  },
  'src/cli/commands/state.ts': {
    sites: 1,
    why:
      "The issue #2247 `state destroy --all` batch prompt. Keeps its own inline " +
      'guard: it passes an abort `signal` for the issue #2117 Ctrl-C handling, ' +
      'which `confirmOrRefuse` does not model.',
  },
  'src/cli/commands/gc.ts': {
    sites: 1,
    why: 'Pre-existing guarded prompt (`process.stdin.isTTY` + NON_INTERACTIVE_CONFIRM).',
  },
  'src/cli/commands/bootstrap-destroy.ts': {
    sites: 1,
    why: 'Pre-existing guarded prompt (`process.stdin.isTTY` + NON_INTERACTIVE_CONFIRM).',
  },
  'src/cli/commands/recreate-confirm-prompt.ts': {
    sites: 1,
    why: 'Pre-existing guarded prompt (`process.stdin.isTTY`, throws a bare Error).',
  },
  'src/cli/commands/prefix-migration-check.ts': {
    sites: 1,
    why: 'Pre-existing guarded prompt (`process.stdin.isTTY`, throws a bare Error).',
  },
  'src/cli/commands/migrate-command.ts': {
    sites: 1,
    why: 'Pre-existing guarded prompt (`process.stdin.isTTY`, throws LocalMigrateError).',
  },
  'src/cli/commands/events.ts': {
    sites: 1,
    why:
      'Guarded by its SOLE caller, which tests `process.stdin.isTTY` before ' +
      'calling it (`events.ts` prune confirmation).',
  },
  'src/cli/commands/local-invoke-agentcore.ts': {
    sites: 1,
    why:
      'NOT a confirmation prompt: a line reader over stdin for the interactive ' +
      'AgentCore session, entered only when `process.stdin.isTTY === true`.',
  },
};

/**
 * The SEVEN files that lost their whole readline interface to the fold. The
 * nine folded SITES are these seven plus two inside `state.ts` (`state orphan`
 * and `state refresh-observed`), which keeps a third, deliberately unfolded
 * one — so `state.ts` is asserted by count below rather than by absence.
 *
 * Written out so a regression at any one of them names that file rather than
 * showing up as an anonymous change in the total.
 */
const FOLDED_FILES: readonly string[] = [
  'src/cli/commands/rollback.ts',
  'src/cli/commands/orphan.ts',
  'src/cli/commands/import.ts',
  'src/cli/commands/export.ts',
  'src/cli/commands/drift.ts',
  'src/cli/commands/retire-cfn-stack.ts',
  'src/cli/commands/state-migrate.ts',
];

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function scanPopulation(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walkTsFiles(SRC_ROOT)) {
    const matches = readFileSync(file, 'utf-8').match(CREATE_INTERFACE);
    if (matches && matches.length > 0) {
      // POSIX-normalised so the keys read the same on any host.
      found[relative(REPO_ROOT, file).split(sep).join('/')] = matches.length;
    }
  }
  return found;
}

describe('readline interface population (issue #2275)', () => {
  it('every construction site in src/ is listed here with a reason', () => {
    const actual = scanPopulation();
    const expectedCounts = Object.fromEntries(
      Object.entries(EXPECTED).map(([path, entry]) => [path, entry.sites])
    );

    // `toEqual` in BOTH directions on purpose: an unlisted site is a new
    // unguarded prompt, and a listed site that vanished means this table is
    // now documenting something that no longer exists.
    expect(actual).toEqual(expectedCounts);
  });

  it('holds a LITERAL total, so the table shrinking is visible on its own', () => {
    // The floor is written as a literal rather than derived from `EXPECTED`,
    // because a floor computed from the pool it guards moves with the pool:
    // deleting rows from the table would keep a derived comparison green.
    // 11 = the post-fold measurement in the file header.
    const actual = scanPopulation();
    expect(Object.values(actual).reduce((a, b) => a + b, 0)).toBe(11);
    expect(Object.keys(EXPECTED)).toHaveLength(10);
  });

  it('none of the seven fully-folded files constructs an interface any more', () => {
    const actual = scanPopulation();
    for (const path of FOLDED_FILES) {
      expect(actual[path], `${path} constructs a readline interface again`).toBeUndefined();
    }
    // `state.ts` held THREE before the fold and keeps exactly the one guarded
    // `state destroy --all` prompt, so it is asserted by count rather than by
    // absence — the two `state` sites (`state orphan`, `state
    // refresh-observed`) are folded while the third is not.
    expect(actual['src/cli/commands/state.ts']).toBe(1);
  });

  it('every folded site imports the shared guarded helper instead', () => {
    // The complement of the count assertion above: a site could stop
    // constructing an interface by having its prompt DELETED rather than
    // routed, which the counts alone read as an improvement.
    for (const path of [...FOLDED_FILES, 'src/cli/commands/state.ts']) {
      const text = readFileSync(join(REPO_ROOT, path), 'utf-8');
      expect(text, `${path} no longer routes through confirmOrRefuse`).toContain(
        "import { confirmOrRefuse } from './confirm-prompt.js';"
      );
    }
  });
});
