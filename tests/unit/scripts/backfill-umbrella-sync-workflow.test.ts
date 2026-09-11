/**
 * Issue [#2774](https://github.com/go-to-k/cdkd/issues/2774) — invariants of
 * `.github/workflows/backfill-umbrella-sync.yml`, the job that keeps the
 * backfill umbrella issue's generated checklist equal to what `main` says.
 *
 * A workflow is the one artifact here with no local run to catch a mistake: it
 * fires unattended on a `main` push, holds `issues: write`, and rewrites a
 * standing issue whose other half is human-written provenance nobody can
 * recompute. A defect surfaces as a wrong checklist — or as no checklist at
 * all — on a page nobody is watching. So the properties that are load-bearing
 * rather than cosmetic are pinned, and each case below says which failure it
 * is about.
 *
 * The splice logic here MOVED out of `cfn-schema-refresh.yml` (whose own suite
 * is `cfn-schema-refresh-workflow.test.ts`): rendering the checklist from that
 * job's post-refresh workspace described a state that need never exist, and a
 * closed refresh PR left the umbrella asserting properties `main` does not
 * have. The cases those two files share are deliberately duplicated rather
 * than extracted — the sibling fences the OLD home only until it drops the
 * step, and a shared helper would let a deletion there silently empty this
 * file too.
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
import { UMBRELLA_EMPTY_SENTINEL } from '../../../scripts/diagnose-schema-refresh.mjs';

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
const RENDER_STEP = "Render the reconciliation plan from main's coverage map";
const SPLICE_STEP = 'Reconcile the per-type sub-issues, then index them in the umbrella';

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
      const splice = byName(SPLICE_STEP);
      expect(render.env, 'the render step must hold no token').toBeUndefined();
      expect(splice.env?.['GH_TOKEN']).toBe('${{ secrets.GITHUB_TOKEN }}');
      // SEPARATE steps in that order — a text-only view cannot see a merge.
      const order = steps.map((s) => s.name);
      expect(order.indexOf(RENDER_STEP)).toBeGreaterThan(-1);
      expect(order.indexOf(RENDER_STEP)).toBeLessThan(order.indexOf(SPLICE_STEP));
      expect(shellOf(SPLICE_STEP), 'the RENDER is back in the token-holding step').not.toContain(
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
      expect(render).toContain('node scripts/diagnose-schema-refresh.mjs --umbrella-subissues');
      expect(render).toContain('/tmp/plan.json');
      const splice = shellOf(SPLICE_STEP);
      expect(splice).toContain('cat /tmp/index.md');
      expect(splice).toContain('gh issue edit');
      // The index the splice writes is produced by the RECONCILER, not by the
      // render step — it carries sub-issue numbers, which do not exist until
      // the reconciliation has created them. A render-step `INDEX_OUT` would be
      // writing numbers it cannot know.
      expect(splice).toContain('INDEX_OUT=/tmp/index.md');
      expect(splice).toContain('node scripts/sync-backfill-subissues.ts /tmp/plan.json');
      expect(render, 'the index is being rendered before the numbers exist').not.toContain(
        'INDEX_OUT'
      );
      // The destination is the umbrella BODY, not a comment: a comment is
      // append-only by construction and reintroduces the model above.
      expect(splice, 'the split-destination comment is back').not.toContain('gh issue comment');
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
      // The empty-plan danger is caught in the RECONCILER, where the open
      // sub-issue count makes "finished" and "broken parse" separable.
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

    it('shape-fences the INDEX too, not only the plan it was rendered from', () => {
      // Two fences at two stages on two files. The `jq -e` above attests to the
      // reconciler's INPUT; this attests to its OUTPUT, which is the thing about
      // to be written into a public issue, and `INDEX_OUT` is produced by a code
      // path `jq` never sees.
      //
      // This case exists because the first cut of go-to-k/cdkd#2949 DELETED the
      // flat checklist's rows-or-sentinel guard on the reasoning that `jq` had
      // replaced it, and left a source comment and a sibling test both asserting
      // a fence that by then lived nowhere. Restoring it without a case left it
      // equally unwatched: both mutations below — deleting the grep, and
      // narrowing it to rows-only — survived the suite.
      const splice = shellOf(SPLICE_STEP);
      expect(splice, 'the index shape fence is gone').toMatch(
        /grep -qE '\^- \\\[ \\\] \|\^_No remaining silent-drop properties' \/tmp\/index\.md/
      );
      // Rows OR the sentinel. Accepting only rows makes a genuinely finished
      // campaign unrepresentable — the defect that once killed this step under
      // `set -e` with no annotation and left the umbrella's stale rows standing
      // permanently. Pinned against the CONSTANT so a reword on either side
      // cannot drift past this.
      const accepted = /grep -qE '\^- \\\[ \\\] \|\^(_No remaining silent-drop properties)'/.exec(
        splice
      );
      expect(accepted, 'the splice no longer accepts the finished-campaign sentinel').not.toBeNull();
      expect(UMBRELLA_EMPTY_SENTINEL.startsWith(accepted![1]!)).toBe(true);
      // Ordered: written by the reconciler, fenced, then spliced.
      const wroteAt = splice.indexOf('INDEX_OUT=/tmp/index.md');
      const fencedAt = splice.indexOf("grep -qE '^- \\[ \\] |^_No remaining");
      const splicedAt = splice.indexOf('cat /tmp/index.md');
      expect(wroteAt).toBeGreaterThan(-1);
      expect(fencedAt, 'the index is fenced before it is written').toBeGreaterThan(wroteAt);
      expect(splicedAt, 'the index is spliced before it is fenced').toBeGreaterThan(fencedAt);
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
      expect(script).toMatch(
        /RENDER_ONLY_FLAGS = new Set\(\[[^\]]*'--umbrella-subissues'[^\]]*\]\)/
      );
    });
  });

  describe('splicing', () => {
    it('writes only BETWEEN the markers, never the whole body', () => {
      // Everything outside them is human-written provenance — which PR closed
      // which slice — that cannot be recomputed. Rewriting the body wholesale
      // would destroy exactly what this design exists to preserve.
      const splice = shellOf(SPLICE_STEP);
      const step = byName(SPLICE_STEP);
      expect(step.env?.['MARKER_BEGIN']).toMatch(/^<!-- BEGIN generated/);
      expect(step.env?.['MARKER_END']).toBe('<!-- END generated -->');
      // The two halves of the splice: everything up to BEGIN, and everything
      // from END onward. Asserted as the sed ranges themselves rather than by
      // exact escaping, which differs between the YAML and the shell.
      expect(splice).toContain('${MARKER_BEGIN}');
      expect(splice).toContain('${MARKER_END}');
      // Spliced by LINE NUMBER, never by a `sed` address range. `sed -n
      // '1,/re/p'` begins searching for addr2 at line TWO, so a body whose
      // FIRST line is the BEGIN marker never closes the range: the head half
      // emitted the whole body, and the result grew by one copy of the human
      // provenance section on every push (measured under bash). The address
      // form also needed the marker text regex-escaped, a second quiet way to
      // get it wrong.
      expect(splice, 'the sed address range is back, with its line-1 hole').not.toMatch(
        /sed -n "1,/
      );
      expect(splice, 'the head half of the splice is gone').toMatch(
        /head -n "\$\{begin_line\}" "\$\{U\}" > "\$\{N\}"/
      );
      expect(splice, 'the tail half of the splice is gone').toMatch(
        /tail -n "\+\$\{end_line\}" "\$\{U\}" >> "\$\{N\}"/
      );
      // And the generated rows land BETWEEN the two halves, not appended after.
      const headAt = splice.indexOf('head -n "${begin_line}"');
      const rowsAt = splice.indexOf('cat /tmp/index.md >> "${N}"');
      const tailAt = splice.indexOf('tail -n "+${end_line}"');
      expect(headAt).toBeGreaterThan(-1);
      expect(rowsAt, 'the rows are not spliced between the halves').toBeGreaterThan(headAt);
      expect(tailAt).toBeGreaterThan(rowsAt);
    });

    it('refuses when the umbrella carries no marker pair', () => {
      // Without them there is nowhere to write without guessing which part of
      // the body is generated, and guessing means overwriting a human's notes.
      const splice = shellOf(SPLICE_STEP);
      // COUNTED, not merely present, and on WHOLE LINES. Presence alone is not
      // enough to splice safely, and each way it is not enough is a different
      // corruption: two BEGIN/END pairs leave a second generated block that
      // nothing ever updates, and a marker quoted inside a human's prose is
      // taken for the real one. `-Fxn` answers both, and gives the line numbers
      // the splice is cut on.
      expect(splice, 'the BEGIN marker is no longer located').toMatch(
        /grep -Fxn -- "\$\{MARKER_BEGIN\}" "\$\{U\}"/
      );
      expect(splice, 'the END marker is no longer located').toMatch(
        /grep -Fxn -- "\$\{MARKER_END\}" "\$\{U\}"/
      );
      expect(splice, 'the markers are no longer COUNTED').toContain(
        '[ "${begin_count}" != "1" ] || [ "${end_count}" != "1" ]'
      );
      // ORDER, separately. END before BEGIN passes a count check and then
      // duplicates the body on every run.
      expect(splice, 'the marker ORDER is unchecked').toContain(
        '[ "${end_line}" -le "${begin_line}" ]'
      );
      // And each refusal REFUSES: an early-exit guard whose `exit 0` is gone
      // announces the problem and then writes anyway.
      expect(
        guardArm(splice, 'must carry exactly one'),
        'the marker-count refusal falls through to the write'
      ).toContain('exit 0');
      expect(
        guardArm(splice, 'Splicing that order would duplicate'),
        'the marker-order refusal falls through to the write'
      ).toContain('exit 0');
    });

    it('never writes a body it could not first read', () => {
      // The redirect truncates the file BEFORE gh runs, so an unchained recipe
      // whose `view` fails would splice onto an EMPTY body — replacing the
      // umbrella's whole content with the generated block alone. Same shape
      // and reasoning as .claude/hooks/issue-dup-check-gate.sh's recipe.
      const splice = shellOf(SPLICE_STEP);
      expect(splice).toMatch(
        /gh issue view "\$\{umbrella\}" --json body -q \.body \| tr -d '\\r' > "\$\{U\}" && \[ -s "\$\{U\}" \]/
      );
      const arm = guardArm(splice, 'Could not read backfill umbrella');
      expect(arm, 'the unreadable-body refusal falls through to the write').toContain('exit 1');
      // `exit 1`, not the `exit 0` this asserted until go-to-k/cdkd#2949. Two
      // things moved it, and they point the same way. The umbrella's number was
      // just resolved from a SUCCESSFUL listing, so a read failure here is a
      // transport or permission error by construction rather than a state a
      // human has misconfigured — which is the distinction the label lookup's
      // own comment twenty lines above refuses to collapse, and this arm was
      // collapsing it. And since the reconciler now runs BEFORE this point, a
      // green exit here leaves the sub-issues current and the parent's index a
      // run behind, on a push-triggered workflow nothing re-runs.
      // Asserted against the whole shell rather than the arm: `guardArm` slices
      // FROM the needle, so the annotation level that precedes it on the same
      // line is outside what it returns.
      expect(splice, 'a transport failure is still reported as a warning').toMatch(
        /::error::Could not read backfill umbrella/
      );
      // The marker-SHAPE refusals keep `exit 0` — those are human-fixable and
      // reached before any mutation. Asserted here so the two classes cannot
      // quietly converge on one exit.
      expect(guardArm(splice, 'must carry exactly one')).toContain('exit 0');
    });

    it('does not rewrite an unchanged body', () => {
      // Regeneration is idempotent, so a run whose checklist is already
      // current must not touch the issue at all — an unconditional write
      // stamps a new edit and a fresh notification on every coverage-map move.
      const splice = shellOf(SPLICE_STEP);
      expect(splice).toMatch(/if cmp -s "\$\{U\}" "\$\{N\}"; then/);
      const arm = guardArm(splice, 'if cmp -s "${U}" "${N}"; then');
      expect(arm, 'the already-current arm writes anyway').toContain('exit 0');
    });

    it('resolves the backfill umbrella by LABEL, never by a hardcoded number', () => {
      // A number goes stale silently the moment the campaign moves, and it
      // did: the first destination carried months of design discussion and
      // participants beyond the maintainer, so a bot write notified all of
      // them. The label is the indirection that makes moving it a
      // `gh issue edit --add-label`, not a workflow edit.
      const step = byName(SPLICE_STEP);
      expect(step.env?.['BACKFILL_UMBRELLA_LABEL']).toBe('backfill-umbrella');
      expect(step.env?.['BACKFILL_UMBRELLA'], 'the hardcoded issue number is back').toBeUndefined();
      const splice = shellOf(SPLICE_STEP);
      expect(splice, 'an issue number is hardcoded in the shell').not.toMatch(
        /gh issue (edit|view|comment) "?\d+/
      );
    });

    it('refuses to guess when the label is not on exactly one open issue', () => {
      // Zero means the campaign has no home; two or more means nobody can say
      // which is the running list. Writing to an arbitrary one is the
      // silent-wrong-destination failure this job exists to avoid.
      const splice = shellOf(SPLICE_STEP);
      expect(splice).toMatch(/--label "\$\{BACKFILL_UMBRELLA_LABEL\}"/);
      expect(splice).toMatch(/--state open/);
      expect(splice).toMatch(/if \[ "\$\{umbrella_count\}" != "1" \]/);
      const arm = guardArm(splice, 'Expected exactly one OPEN issue');
      expect(arm, 'the ambiguous case picks one anyway').toContain('exit 0');
    });

    it('tells "GitHub did not answer" apart from "no issue carries the label"', () => {
      // A `|| true` on the lookup collapses the two into one exit: a transport
      // or permission failure renders as "found 0", warns, and exits GREEN —
      // and since this workflow fires on a push, nothing re-runs it, so the
      // umbrella silently stops tracking `main`. That is the same
      // green-run-that-changed-nothing this file refuses at the write, one
      // step earlier.
      const splice = shellOf(SPLICE_STEP);
      // SCOPED to the lookup's own statement. An unscoped
      // `not.toMatch(/gh issue list[\s\S]*?\|\| true\)/)` spans forward to the
      // NEXT `|| true)` anywhere below — and the marker `grep`s legitimately
      // carry one — so it failed on correct code, which is the same
      // wrong-span defect this suite keeps finding in the workflow.
      const lookup = splice.slice(
        splice.indexOf('gh issue list'),
        splice.indexOf('umbrella_count=')
      );
      expect(lookup.length, 'the lookup statement could not be located').toBeGreaterThan(0);
      expect(lookup, 'the lookup swallows its own failure again').not.toContain('|| true');
      expect(splice, 'the lookup status is no longer captured separately').toMatch(
        /if ! umbrella_json=\$\(gh issue list/
      );
      // And that arm FAILS the run rather than warning: it is not a state a
      // human can fix by editing the issue.
      const arm = guardArm(splice, 'Could not ask GitHub which issue carries');
      expect(arm, 'a transport failure exits green').toContain('exit 1');
      expect(arm).not.toContain('exit 0');
    });
  });

  describe('failure reporting', () => {
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

    it('lets the WRITE fail the run, unlike the refusals above it', () => {
      // The refusals are states a human has to fix, and each reports honestly
      // and exits 0. The final `gh issue edit` is the write itself: a
      // swallowed 403 there is the silent watch failure this repo exists to
      // avoid, because a red run on `main` is a notification and a green run
      // that changed nothing is not.
      const splice = shellOf(SPLICE_STEP);
      const writeAt = splice.lastIndexOf('gh issue edit');
      expect(writeAt, 'there is no write left to guard').toBeGreaterThan(-1);
      // Read through `shellOf`: the step's own comment SAYS `|| echo
      // "::warning::"` in order to explain why it is absent, so over the raw
      // `run` this assertion fails on correct code.
      expect(
        splice.slice(writeAt),
        'the write swallows its own failure — a 403 would now report green'
      ).not.toMatch(/\|\||\btrue\b/);
    });

    it('RUNS the splice: a CRLF body keeps its human half and gains no second block', () => {
      // EXECUTED, not matched. Every case above reads the shell as text, and
      // the defect this arm is about was invisible to all of them: tightening
      // the marker match to `grep -Fx` made it byte-exact on a whole line, and
      // a body edited in the GitHub WEB UI is stored with CRLF — so the marker
      // reads as `<!-- BEGIN … -->\r`, both counts come back 0, and the step
      // refuses forever over markers that are already correct. The recovery its
      // own warning names, hand-editing the issue, is what creates the CRLF.
      //
      // What is asserted is the CHAIN — strip, locate, splice — rather than the
      // spelling of any one link, which is what a regex on `tr -d` gives.
      const dir = mkdtempSync(join(tmpdir(), 'cdkd-splice-run-'));
      try {
        const bin = join(dir, 'bin');
        mkdirSync(bin, { recursive: true });
        const log = join(dir, 'gh.log');
        const bodyFile = join(dir, 'body');
        const listFile = join(dir, 'list');
        const written = join(dir, 'written');
        // A stub `gh` that answers the two reads and captures the write.
        writeFileSync(
          join(bin, 'gh'),
          `#!/bin/bash
echo "gh $*" >> "$GH_LOG"
case "$1 $2" in
  "issue list") cat "$GH_LIST" ;;
  "issue view") cat "$GH_BODY" ;;
  # Idempotent by --force, and modelled so the step's first write does not take
  # the fall-through below and abort before the splice this case is about.
  "label create") ;;
  "issue edit")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--body-file" ]; then cp "$2" "$GH_WRITTEN"; fi
      shift
    done ;;
  # FAILS CLOSED. A fall-through returning 0 with empty stdout models a gh
  # that answered nothing as SUCCESS -- the exact shape the step under test
  # exists to refuse -- so the stub would hand the step the very state its
  # guards are about and call it fine.
  *) echo "stub gh: unmodelled subcommand: $*" >&2; exit 1 ;;
esac
`,
          { mode: 0o755 }
        );
        writeFileSync(listFile, JSON.stringify([{ number: 2762 }]));
        const begin = byName(SPLICE_STEP).env!['MARKER_BEGIN']!;
        const end = byName(SPLICE_STEP).env!['MARKER_END']!;
        const PROVENANCE = 'PR #795 closed the first slice.';
        writeFileSync(
          bodyFile,
          `## How entries arrive here\r\n\r\n${begin}\r\n- [ ] \`AWS::Old::Type\`: \`Stale\`\r\n${end}\r\n\r\n## Where the history lives\r\n\r\n${PROVENANCE}\r\n`
        );
        writeFileSync(join(dir, 'index-src.md'), '- [ ] #900 — `AWS::New::Type` (1 remaining)\n');
        // The RECONCILER is stood in for by a stub `node` ON PATH rather than by
        // editing it out of the shell, and the difference is what the case then
        // covers. Substituting the command away would leave the step's
        // `PARENT=` / `INDEX_OUT=` prefix unexercised — and worse, a stand-in
        // spelled `cp src "$INDEX_OUT"` cannot even read it: the shell expands
        // `$INDEX_OUT` BEFORE the assignment prefix takes effect, so under
        // `set -u` it aborts on an unset variable. A stub binary receives the
        // prefix as its ENVIRONMENT, which is how the real reconciler receives
        // it, so a step that stopped passing either one fails here.
        writeFileSync(
          join(bin, 'node'),
          `#!/bin/bash
echo "node $*" >> "$GH_LOG"
: "\${INDEX_OUT:?the step did not pass INDEX_OUT}"
: "\${PARENT:?the step did not pass PARENT}"
cp "$NODE_INDEX_SRC" "$INDEX_OUT"
`,
          { mode: 0o755 }
        );
        // `/tmp/index.md` is absolute in the shell, so the sandbox takes it
        // over via TMPDIR-independent substitution rather than by writing to a
        // path other suites share.
        const shell = shellOf(SPLICE_STEP).split('/tmp/index.md').join(join(dir, 'index.md'));
        writeFileSync(join(dir, 'splice.sh'), shell);
        const res = spawnSync('bash', [join(dir, 'splice.sh')], {
          encoding: 'utf8',
          env: {
            PATH: `${bin}:${process.env['PATH'] ?? ''}`,
            HOME: dir,
            TMPDIR: dir,
            GH_LOG: log,
            GH_LIST: listFile,
            GH_BODY: bodyFile,
            GH_WRITTEN: written,
            BACKFILL_UMBRELLA_LABEL: byName(SPLICE_STEP).env!['BACKFILL_UMBRELLA_LABEL']!,
            SUBISSUE_LABEL: byName(SPLICE_STEP).env!['SUBISSUE_LABEL']!,
            NODE_INDEX_SRC: join(dir, 'index-src.md'),
            MARKER_BEGIN: begin,
            MARKER_END: end,
          },
        });
        expect(res.status, `the step exited ${res.status}: ${res.stdout}${res.stderr}`).toBe(0);
        expect(
          res.stdout,
          'a CRLF body was refused as if its markers were missing'
        ).not.toContain('must carry exactly one');
        const out = readFileSync(written, 'utf8');
        expect(out.split('\n').filter((l) => l === begin).length, 'a second block was spliced in').toBe(1);
        expect(out, 'the stale row survived').not.toContain('Stale');
        expect(out, 'the fresh rows were not written').toContain('AWS::New::Type');
        expect(out, 'the human provenance was lost').toContain(PROVENANCE);
        // The stub `node` and the stub `gh` each RAN. Without this the case
        // would still pass if the step stopped reconciling altogether — the
        // splice reads a file, and a file left over from a previous shape of
        // the step is indistinguishable from one the reconciler just wrote.
        const calls = readFileSync(log, 'utf8');
        expect(calls, 'the reconciler was never invoked').toContain(
          'node scripts/sync-backfill-subissues.ts /tmp/plan.json'
        );
        expect(calls, 'the sub-issue label is never ensured before a create').toContain(
          `gh label create ${byName(SPLICE_STEP).env!['SUBISSUE_LABEL']!}`
        );
        // Ordered: the label must exist before the reconciler can attach it.
        expect(calls.indexOf('gh label create')).toBeLessThan(
          calls.indexOf('node scripts/sync-backfill-subissues.ts')
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 60_000);
  });
});
