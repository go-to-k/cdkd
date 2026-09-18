/**
 * Issue [#2774](https://github.com/go-to-k/cdkd/issues/2774) — invariants of
 * `.github/workflows/backfill-umbrella-sync.yml`, the job that keeps the
 * backfill campaign's generated checklist equal to what `main` says.
 *
 * A workflow is the one artifact here with no local run to catch a mistake: it
 * fires unattended on a `main` push and holds `issues: write` over the
 * campaign's public page. A defect surfaces where nobody is watching. So the
 * properties that are load-bearing rather than cosmetic are pinned, and each
 * case below says which failure it is about.
 *
 * Its shape has moved three times, and each move deleted a way to be wrong.
 * go-to-k/cdkd#2774 took the write out of `cfn-schema-refresh.yml` (whose own
 * suite is `cfn-schema-refresh-workflow.test.ts`), because rendering from that
 * job's post-refresh workspace described a state that need never exist.
 * go-to-k/cdkd#2998 removed the parent-body splice while go-to-k/cdkd#2949's
 * per-type sub-issues carried the campaign. The fold-back then closed those ~44
 * generated issues — a bot-filed slice is indistinguishable from an unfixed
 * defect in a public issue count — and the body write returned in the one shape
 * that cannot destroy provenance: a DELIMITED block, with everything outside its
 * two markers carried through byte for byte. So the cases here assert what this
 * STEP does (look the umbrella up by label, hand its number to the reconciler,
 * write nothing itself); the reconciler's own refusals are
 * `sync-backfill-umbrella.test.ts`.
 *
 * The file is read BOTH ways, because each view is blind where the other sees.
 * TEXT is right for the literal shell and the literal `uses:` pins, which YAML
 * flattens into an opaque string. STRUCTURE is right for step wiring, triggers
 * and permissions: a text-only suite passes when a whole step is deleted, when
 * the render step gains the token it is separated from, and when the push
 * trigger's path list grows a second entry — all silent, all leaving the job
 * to write the wrong thing or nothing at all.
 */
import { describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'backfill-umbrella-sync.yml');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
/**
 * The same file as STRUCTURE. Both views are kept: the text one asserts the
 * literal shell (which YAML flattens into an opaque string), the parsed one
 * asserts triggers, permissions and step wiring (which text cannot see at all).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parsed: any = parseYaml(workflow);

const steps: Array<{
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}> = parsed.jobs.sync.steps;

const byName = (name: string) => {
  const step = steps.find((s) => s.name === name);
  expect(step, `no step named ${JSON.stringify(name)} — it was renamed or deleted`).toBeDefined();
  return step!;
};

/**
 * A step's shell with `#` comment lines removed. Load-bearing for the NEGATIVE
 * assertions below: this workflow's comments deliberately QUOTE the wrong
 * forms in order to explain why they are wrong (`|| true` is named twice, once
 * as the form the lookup NEEDS and once as the form the final write must NOT
 * have), so a naive `not.toContain` reads the explanation as the defect and
 * fails on correct code — or, worse, reads the explanation as the code and
 * passes on a defect.
 */
const shellOf = (name: string) =>
  byName(name)
    .run!.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The two steps, named as literals so a rename must be made deliberately. */
const RENDER_STEP = "Render the per-type plan from main's coverage map";
const RECONCILE_STEP = "Rewrite the umbrella's generated checklist block";

/**
 * The single file `renderUmbrellaChecklist` reads, and therefore the whole of
 * the push trigger's path filter.
 */
const COVERAGE_MAP = 'src/provisioning/property-coverage.generated.ts';

/**
 * The body of the guard arm introduced by `needle`, up to its closing `fi`.
 * The refusals in this workflow are early-`exit 0` guards rather than the
 * nested `if`s the sibling job used, so "the refusal does not fall through to
 * the write" is asserted as "this arm exits", not as "no write appears after
 * it" — the write legitimately appears after every one of them.
 */
const guardArm = (shell: string, needle: string) => {
  const at = shell.indexOf(needle);
  expect(at, `the guard announcing ${JSON.stringify(needle)} is gone`).toBeGreaterThan(-1);
  const rest = shell.slice(at);
  const end = rest.search(/\n\s*fi\b/);
  expect(end, `the guard announcing ${JSON.stringify(needle)} is never closed`).toBeGreaterThan(-1);
  return rest.slice(0, end);
};

describe('backfill-umbrella-sync workflow (issue #2774)', () => {
  it('is not vacuous — the file exists and has real content', () => {
    expect(workflow.length).toBeGreaterThan(2000);
  });

  describe('triggering', () => {
    it('fires on main pushes that move the coverage map, and on nothing else', () => {
      // Both halves matter and each fails in the opposite direction. Without
      // the branch filter the job runs on every feature-branch push and writes
      // the umbrella from code that is not `main` — the exact staleness this
      // workflow was extracted to remove. Without the path filter it runs on
      // every push to `main`, i.e. dozens of no-op `gh` writes a day.
      expect(parsed.on.push.branches).toEqual(['main']);
      // EXACTLY that one path. `renderUmbrellaChecklist` reads
      // `property-coverage.generated.ts` and nothing else, so a second entry
      // triggers runs that cannot change the answer, and a different entry
      // means the map can move with the umbrella left standing.
      expect(parsed.on.push.paths).toEqual([COVERAGE_MAP]);
      // And the claim above is checked against the script rather than trusted:
      // if the renderer's input moves, this path filter is silently wrong.
      expect(
        readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8'),
        `the renderer no longer reads ${COVERAGE_MAP} — the path filter is now wrong`
      ).toContain(COVERAGE_MAP);
    });

    it('is manually dispatchable — the documented recovery path', () => {
      // Every refusal below leaves the issue untouched and asks a human to fix
      // the label or the markers. Without `workflow_dispatch` the retry waits
      // for the next coverage-map change, which on a quiet week may not come.
      expect(parsed.on).toHaveProperty('workflow_dispatch');
      expect(workflow).toMatch(/^\s*workflow_dispatch:$/m);
    });
  });

  describe('blast radius', () => {
    it('denies permissions at the top level and grants the job exactly two', () => {
      // Asserted as an EXACT object, not as a set of `toContain`s. A widened
      // scope on an unattended job is the thing worth pinning, and every
      // presence-only form stays green when `contents: write` or
      // `pull-requests: write` is added beside the ones it names.
      expect(parsed.permissions).toEqual({});
      expect(workflow).toMatch(/^permissions: \{\}$/m);
      expect(parsed.jobs.sync.permissions).toEqual({
        contents: 'read',
        issues: 'write',
      });
    });

    it('checks out WITHOUT persisting the token into .git/config', () => {
      // Nothing here pushes, so a persisted credential is reach with no use:
      // the render step spawns node, and a subprocess can read `.git/config`.
      const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'));
      expect(checkout, 'no checkout step found').toBeDefined();
      expect(checkout!.with?.['persist-credentials']).toBe(false);
    });

    it('pins every action to a full commit SHA', () => {
      // The repo pins as `uses: owner/action@<sha> # v6`, so the ref is
      // followed by a version comment rather than the end of the line — a
      // `(\S+)$` pattern matches nothing here.
      const uses = [...workflow.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)].map((m) => m[1]!);
      expect(
        uses.length,
        'no `uses:` lines found — the parser stopped seeing the file'
      ).toBeGreaterThanOrEqual(2);
      for (const ref of uses) {
        expect(ref, `${ref} is not pinned to a 40-character commit SHA`).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    it('keeps the RENDER out of the token-holding step', () => {
      // The repo's standing split, restated for the shape go-to-k/cdkd#2949
      // left behind. It is no longer "the token-holding step spawns nothing":
      // the reconciler is a subprocess that must hold `GH_TOKEN`, because
      // calling `gh` is its entire job. What survives — and is the half that
      // was ever load-bearing — is that the step reading the REPOSITORY's own
      // files to decide what the campaign says holds no token at all, so a
      // defect in the parser cannot reach a write.
      const render = byName(RENDER_STEP);
      const reconcile = byName(RECONCILE_STEP);
      expect(render.env, 'the render step must hold no token').toBeUndefined();
      expect(reconcile.env?.['GH_TOKEN']).toBe('${{ secrets.GITHUB_TOKEN }}');
      // SEPARATE steps in that order — a text-only view cannot see a merge.
      const order = steps.map((s) => s.name);
      expect(order.indexOf(RENDER_STEP)).toBeGreaterThan(-1);
      expect(order.indexOf(RENDER_STEP)).toBeLessThan(order.indexOf(RECONCILE_STEP));
      expect(shellOf(RECONCILE_STEP), 'the RENDER is back in the token-holding step').not.toContain(
        'diagnose-schema-refresh.mjs'
      );
      // And the converse: the render step must not have grown a `gh` call,
      // which is the other way the two halves merge.
      expect(shellOf(RENDER_STEP), 'the render step now calls gh').not.toMatch(/(^|\s)gh\s/);
    });
  });

  describe('rendering', () => {
    it('REGENERATES the umbrella checklist from the coverage map', () => {
      // Appending cannot express a type that was ticked off and later regained
      // a property: the `[x]` row stays checked and a second row appears for
      // the same type, so the reader sees one entry saying "done" and another
      // saying "not". Dedup does not fix that — the append model is what is
      // wrong. The map is the umbrella's own stated completion criterion, so
      // rendering FROM it means a type reappears or disappears on its own.
      const render = shellOf(RENDER_STEP);
      expect(render).toContain('node scripts/diagnose-schema-refresh.mjs --umbrella-types');
      expect(render).toContain('/tmp/plan.json');
      const step = shellOf(RECONCILE_STEP);
      expect(step).toContain('node scripts/sync-backfill-umbrella.ts /tmp/plan.json');
      // The body write belongs to the RECONCILER, which splices one delimited
      // block and copies everything else. A `gh` write in the SHELL would be a
      // second writer, outside every refusal that script makes and outside the
      // markers that keep human provenance intact — and `gh issue edit --body`
      // from here would replace the whole page. What replaces the finer
      // assertions is the executed case further down: a text scan alone cannot
      // say the step never reaches a write through some path.
      for (const verb of ['gh issue edit', 'gh issue comment', 'gh issue close', 'gh label create']) {
        expect(step, `the step writes on its own via '${verb}'`).not.toContain(verb);
      }
    });

    it('refuses a render that is not a plan, rather than reconciling against one', () => {
      // The redirect creates `/tmp/plan.json` whatever happens, so a renderer
      // that threw leaves a file the reconciler would then read as the
      // campaign's state.
      const render = shellOf(RENDER_STEP);
      // SHAPE, not size, and the distinction is the whole case. A `-s` test
      // looked like it covered a broken render and did not:
      // `diagnose-schema-refresh.mjs` used to swallow every failure, writing
      // `_The automated diagnosis failed to run (…)_` to STDOUT at exit 0, so
      // the redirect produced a NON-EMPTY file holding one error sentence and
      // `-s` passed.
      expect(render, 'the render guard accepts a file that is merely non-empty').not.toMatch(
        /\[ -s \/tmp\/plan\.json \]/
      );
      // On the TYPE of `.types`, never on its length. A finished campaign
      // renders `{"types": []}` legally, and a length test here would make that
      // state unrepresentable — the same defect that once made the flat
      // checklist's rows-only guard kill the step under `set -e` with no
      // annotation, leaving the umbrella's stale rows standing permanently.
      // The empty-plan danger is caught in the RECONCILER, where the rows the
      // published block still holds make "finished" and "broken parse"
      // separable.
      expect(render, 'the shape guard is gone').toMatch(
        /jq -e '\.types \| type == "array"' \/tmp\/plan\.json/
      );
      expect(render, 'a length test makes a finished campaign unrepresentable').not.toMatch(
        /\.types \| length/
      );
      // Under `set -e`, and AFTER the redirect it inspects.
      expect(render).toContain('set -euo pipefail');
      expect(render.indexOf('> /tmp/plan.json')).toBeLessThan(
        render.indexOf('jq -e \'.types | type == "array"\'')
      );
    });

    it('is backed by the script exiting non-zero, not by the guard alone', () => {
      // The guard above is the SECOND of two independent stops, and the first
      // one lives in the script: a render-only mode re-throws instead of
      // printing the fallback sentence, because its reader is a workflow that
      // cannot read a sentence. Pinned here because the two files are the
      // producer and the consumer of one contract with nothing joining them.
      //
      // Matched by MEMBERSHIP rather than by an equality against one flag. The
      // test used to pin `a === '--umbrella-checklist'`, which missed
      // `--umbrella-checklist=x` (go-to-k/cdkd#2858); pinning the single
      // successor flag would repeat the shape one level up, passing while a
      // SECOND render-only mode printed its refusal to STDOUT at exit 0.
      const script = readFileSync(join(REPO_ROOT, 'scripts/diagnose-schema-refresh.mjs'), 'utf8');
      expect(script).toContain('RENDER_ONLY_FLAGS.has(flag)');
      expect(script).toContain('process.exitCode = 1');
      // And the mode this workflow actually consumes is IN that set — the
      // membership test above is satisfied by a set that does not contain it.
      expect(script).toMatch(/RENDER_ONLY_FLAGS = new Set\(\[[^\]]*'--umbrella-types'[^\]]*\]\)/);
    });
  });

  describe('locating the parent', () => {
    it('resolves the backfill umbrella by LABEL, never by a hardcoded number', () => {
      // A number goes stale silently the moment the campaign moves, and it
      // did: the first destination carried months of design discussion and
      // participants beyond the maintainer, so a bot write notified all of
      // them. The label is the indirection that makes moving it a
      // `gh issue edit --add-label`, not a workflow edit.
      const reconcile = byName(RECONCILE_STEP);
      expect(reconcile.env?.['BACKFILL_UMBRELLA_LABEL']).toBe('backfill-umbrella');
      expect(
        reconcile.env?.['BACKFILL_UMBRELLA'],
        'the hardcoded issue number is back'
      ).toBeUndefined();
      const step = shellOf(RECONCILE_STEP);
      expect(step, 'an issue number is hardcoded in the shell').not.toMatch(
        /gh issue (edit|view|comment|list) "?\d+/
      );
      // The number is READ and handed to the reconciler, never written to.
      expect(step).toContain('PARENT="${umbrella}"');
    });

    it('refuses to guess when the label is not on exactly one open issue', () => {
      // Zero means the campaign has no home; two or more means nobody can say
      // which is the running list. Writing to an arbitrary one is the
      // silent-wrong-destination failure this job exists to avoid.
      const step = shellOf(RECONCILE_STEP);
      expect(step).toMatch(/--label "\$\{BACKFILL_UMBRELLA_LABEL\}"/);
      expect(step).toMatch(/--state open/);
      expect(step).toMatch(/if \[ "\$\{umbrella_count\}" != "1" \]/);
      const arm = guardArm(step, 'Expected exactly one OPEN issue');
      expect(arm, 'the ambiguous case picks one anyway').toContain('exit 0');
    });

    it('tells "GitHub did not answer" apart from "no issue carries the label"', () => {
      // A `|| true` on the lookup collapses the two into one exit: a transport
      // or permission failure renders as "found 0", warns, and exits GREEN —
      // and since this workflow fires on a push, nothing re-runs it, so the
      // umbrella silently stops tracking `main`. That is the same
      // green-run-that-changed-nothing this file refuses at the write, one
      // step earlier.
      const step = shellOf(RECONCILE_STEP);
      // SCOPED to the lookup's own statement. An unscoped
      // `not.toMatch(/gh issue list[\s\S]*?\|\| true\)/)` spans forward to the
      // NEXT `|| true)` anywhere below — and the marker `grep`s legitimately
      // carry one — so it failed on correct code, which is the same
      // wrong-span defect this suite keeps finding in the workflow.
      const lookup = step.slice(
        step.indexOf('gh issue list'),
        step.indexOf('umbrella_count=')
      );
      expect(lookup.length, 'the lookup statement could not be located').toBeGreaterThan(0);
      expect(lookup, 'the lookup swallows its own failure again').not.toContain('|| true');
      expect(step, 'the lookup status is no longer captured separately').toMatch(
        /if ! umbrella_json=\$\(gh issue list/
      );
      // And that arm FAILS the run rather than warning: it is not a state a
      // human can fix by editing the issue.
      const arm = guardArm(step, 'Could not ask GitHub which issue carries');
      expect(arm, 'a transport failure exits green').toContain('exit 1');
      expect(arm).not.toContain('exit 0');
    });

    it('RUNS the step: the umbrella is READ for its number, and the STEP writes nothing', () => {
      // EXECUTED, not matched. Every case above reads the shell as text, and the
      // property this one is about is that the job's `issues: write` is spent by
      // the RECONCILER alone — which splices one delimited block — and never by
      // a `gh` call in this shell, which no refusal and no marker would bound. A
      // text scan can say `gh issue edit` is absent today; only a run can say
      // the step does not reach it through some path.
      //
      // The stub `gh` fails CLOSED on anything unmodelled, so a write added here
      // shows up as a failing step rather than as silence.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-sync-run-'));
      try {
        const bin = join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        const log = join(dir, 'gh.log');
        writeFileSync(join(dir, 'list'), JSON.stringify([{ number: 2762 }]));
        writeFileSync(
          join(bin, 'gh'),
          `#!/bin/bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_LIST" ;;
  "label create") ;;
  *) echo "stub gh: unmodelled subcommand: $*" >&2; exit 1 ;;
esac
`,
          { mode: 0o755 }
        );
        // The reconciler is stood in for by a stub `node` on PATH, which also
        // asserts the one environment value the step must hand it.
        writeFileSync(
          join(bin, 'node'),
          `#!/bin/bash
echo "node $*" >> "$GH_LOG"
: "\${PARENT:?the step did not pass PARENT}"
`,
          { mode: 0o755 }
        );
        writeFileSync(join(dir, 'step.sh'), shellOf(RECONCILE_STEP));
        const res = spawnSync('bash', [join(dir, 'step.sh')], {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env['PATH'] ?? ''}`,
            HOME: dir,
            TMPDIR: dir,
            GH_LOG: log,
            GH_LIST: join(dir, 'list'),
            BACKFILL_UMBRELLA_LABEL: byName(RECONCILE_STEP).env!['BACKFILL_UMBRELLA_LABEL']!,
          },
        });
        expect(res.status, `the step exited ${res.status}: ${res.stdout}${res.stderr}`).toBe(0);
        const calls = readFileSync(log, 'utf8');
        expect(calls, 'the umbrella was never looked up').toContain('gh issue list');
        expect(calls, 'the reconciler was never invoked').toContain(
          'node scripts/sync-backfill-umbrella.ts /tmp/plan.json'
        );
        // The whole point: no path through this step reaches GitHub itself,
        // beyond the one read that finds the umbrella's number.
        for (const verb of ['issue edit', 'issue view', 'issue comment', 'label create']) {
          expect(calls, `the step reached '${verb}' — writing is the reconciler's job`)
            .not.toContain(verb);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });

  describe('failure reporting', () => {
    it('lets the RECONCILER fail the run — it is the only write left', () => {
      // The deleted `lets the WRITE fail the run` case pinned this against the
      // old `gh issue edit`. That write is gone and the reconciler invocation
      // inherited its job, and for one round NOTHING pinned it: review measured
      // that appending `|| true` to the node call left the whole suite green —
      // including the executed case, whose stub `node` exits 0 either way —
      // while this workflow AND `sync-backfill-umbrella.ts`'s header both go
      // on claiming every refusal exits non-zero. That would green-wash every
      // refusal guarding the campaign's public page.
      const step = shellOf(RECONCILE_STEP);
      const at = step.lastIndexOf('node scripts/sync-backfill-umbrella.ts');
      expect(at, 'there is no reconciler invocation left to guard').toBeGreaterThan(-1);
      // UNSCOPED over the tail, unlike the lookup's scan. That one is sliced to
      // one statement because the marker `grep`s legitimately carried `|| true`
      // — and those greps are gone, so nothing after this point may swallow.
      expect(
        step.slice(at),
        'the reconciler invocation swallows its own failure — every refusal would report green'
      ).not.toMatch(/\|\||\btrue\b/);
      // The `if ! node …; then :; fi` shape sits BEFORE the anchor, so the tail
      // scan above cannot see it.
      expect(step, 'the reconciler is wrapped in an if that swallows its status').not.toMatch(
        /if !\s*(\S+=\S+\s+)*node scripts\/sync-backfill-umbrella\.ts/
      );
      // And `continue-on-error` is a YAML KEY — invisible to every text scan of
      // `run:`, and it green-washes the same refusals from outside the shell
      // entirely. Read off the parsed step (review round 2).
      expect(
        byName(RECONCILE_STEP),
        'the step continues on error — its refusals report green'
      ).not.toHaveProperty('continue-on-error');
      expect(parsed.jobs.sync, 'the JOB continues on error').not.toHaveProperty('continue-on-error');
    });

    it('looks the umbrella up BEFORE it can hand a number to the reconciler', () => {
      // The ordering the deleted label case used to carry. `PARENT` is the only
      // thing this step computes, and a reconciler invoked before the lookup
      // gets an empty one — which its own usage guard turns into exit 2 rather
      // than a write, but as a red run nobody can act on from the runbook.
      const step = shellOf(RECONCILE_STEP);
      const lookupAt = step.indexOf('gh issue list');
      const nodeAt = step.indexOf('node scripts/sync-backfill-umbrella.ts');
      expect(lookupAt, 'the umbrella is never looked up').toBeGreaterThan(-1);
      expect(nodeAt).toBeGreaterThan(-1);
      expect(lookupAt, 'the reconciler runs before the number it needs exists').toBeLessThan(nodeAt);
    });

    it('gives every step that runs a pipeline a pipefail before it', () => {
      // `run:` with no `shell:` is `bash -e {0}` — NOT pipefail, so a pipeline
      // reports its LAST stage's status and a `gh` failure upstream of a `jq`
      // reads as an empty answer. Through `shellOf`, not raw `run`: a comment
      // naming `pipefail` would otherwise satisfy the position check while the
      // real `set -o pipefail` is deleted.
      for (const step of steps) {
        if (!step.name || !step.run) continue;
        const shell = shellOf(step.name);
        const pipeAt = shell.search(/\S \| \S|\|\s*\n/);
        if (pipeAt === -1) continue;
        const at = shell.indexOf('pipefail');
        expect(at, `${step.name}: runs a pipeline with no pipefail`).toBeGreaterThan(-1);
        expect(at, `${step.name}: pipefail is set after its first pipeline`).toBeLessThan(pipeAt);
      }
    });

  });
});
