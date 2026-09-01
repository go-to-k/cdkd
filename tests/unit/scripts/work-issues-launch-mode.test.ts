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
        git(['init', '-q', main]);
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
        expect(fromMain.MODE).toBe('MAIN-CHECKOUT');
        expect(fromMain.LANE_TREE).toBe(main);
        expect(fromMain.MAIN_CHECKOUT).toBe(main);

        const fromLane = run(lane);
        expect(fromLane.MODE).toBe('IN-PLACE');
        // The two values differing IS the mode, and MAIN_CHECKOUT must point at
        // the OTHER tree -- that is the value section 2's collision scan needs
        // and the one a `pwd`- or `--show-toplevel`-derived probe gets wrong.
        expect(fromLane.LANE_TREE).toBe(lane);
        expect(fromLane.MAIN_CHECKOUT).toBe(main);
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
