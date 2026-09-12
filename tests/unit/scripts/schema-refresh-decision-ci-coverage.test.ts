/**
 * Issue [#3005](https://github.com/go-to-k/cdkd/issues/3005) — a schema-refresh
 * pull request carrying outstanding decisions must not be mergeable.
 *
 * WHAT THIS PINS, AND WHY IT IS NOT THE GATE THE ISSUE ASKED FOR.
 *
 * #3005 proposed a new CI job that fails while `countDecisions`'s number is
 * non-zero, on the grounds that nothing structural stopped a web-UI merge or an
 * auto-merge — only a REQUIRED status check binds there, and at filing time
 * (2026-09-11T10:01Z) the repository had none that a red fixture check reached.
 * go-to-k/cdkd#2999 landed the `ci-ok` aggregate less than two hours later and
 * made it the required check, which closes MOST of the hole by a different
 * mechanism: every term `countDecisions` can raise ALSO reds `check-build-test`,
 * and
 * `ci-ok` waits on that job. So a decision-carrying refresh PR is unmergeable
 * in BOTH of the states it is ever in — held at `action_required`, where a
 * required check that has not reported blocks the merge button, and approved
 * and run, where it reports red — and the decision-count job would be a second
 * required check answering the same question, the duplication #3005 itself
 * argued against.
 *
 * MOST, because the equivalence did NOT hold for `removed` when this was
 * written, and that was #3005's report being right about one term. A property
 * already in `_todo-backfill.json`'s `bogusTolerated` is settled — that is what
 * the entry's rationale says, and `classifyCoverage` reports it green — yet the
 * count subtracted only what the CURRENT cycle wrote, because
 * `writeAutoTolerated` SKIPS an already-tolerated property and so puts it in
 * neither `written` nor `escalated`. A removal of such a property was therefore
 * counted with nothing red: a decision class that merges cleanly, which is the
 * shape #3005 calls worse than the nested-key one. `partitionSettledRemovals`
 * now reads the same tolerance FILE both sides read, and the confluence case in
 * `diagnose-schema-refresh.test.ts` pins them to one definition of "settled".
 *
 * That closure is EMERGENT, not designed, and this file is what keeps it true.
 * Nothing else relates the two workflows: `cfn-schema-refresh.yml` grades a
 * refresh with its own check list, `ci.yml` grades the branch with its own, and
 * a check added to the first and forgotten in the second re-opens the hole
 * SILENTLY — the refresh would count a decision that reddens nothing, which is
 * exactly the class #3005 says is worse than the nested-key one (it merges
 * cleanly and drops a real finding on the floor).
 *
 * The three populations below are DERIVED rather than listed, so each of the
 * three ways the invariant can break fails here first:
 *
 *   1. a new decision TERM in `countDecisions` with no CI check behind it —
 *      the term names come out of the shipped function itself;
 *   2. a new `run_check` in the refresh that `ci.yml` does not run — the check
 *      names come out of the refresh workflow's own shell;
 *   3. a check dropped from `check-build-test`, or `check-build-test` dropped
 *      from `ci-ok`'s `needs:` — both read out of `ci.yml`.
 *
 * It does NOT claim the two gradings are numerically equal. `ci.yml` is allowed
 * to be red where the refresh counts zero (it runs far more checks); the
 * direction that matters — and the only one asserted — is that nothing the
 * refresh counts can leave CI green.
 *
 * ONE TERM IS HONESTLY NOT COVERED, and `UNCOVERED_TERMS` says so rather than
 * being folded into a tidy table. Writing a rationale for a term nothing
 * reddens would have been the same defect #3005 reports, one level up: a fence
 * asserting a coverage that does not exist. The residual is stated there and in
 * the issue, and a NEW term must be classified into one bucket or the other —
 * neither is a default.
 *
 * The sibling `cfn-schema-refresh-workflow.test.ts` owns the refresh workflow's
 * internal invariants (including `run_check` vs `CHECK_GUIDANCE`), and
 * `ci-ok-gate.test.ts` owns `ci-ok`'s own shape. Neither can see the relation
 * between the two files, which is this file's whole subject.
 */
import { describe, it, expect } from 'vite-plus/test';
import { countDecisions } from '../../../scripts/diagnose-schema-refresh.mjs';
// The real parser, for the reason `decisionTerms`'s docblock gives. `typescript-v6`
// is the npm alias of typescript@6 the sibling critics use — TS7 ships the stable
// compiler API only under `typescript/unstable/*`.
import ts from 'typescript-v6';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REFRESH_PATH = join(REPO_ROOT, '.github', 'workflows', 'cfn-schema-refresh.yml');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const refreshText = readFileSync(REFRESH_PATH, 'utf8');
const ciText = readFileSync(CI_PATH, 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const refresh: any = parseYaml(refreshText);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ci: any = parseYaml(ciText);

/** The `ci.yml` job every fixture-driven check runs in. */
const CI_CHECK_JOB = 'check-build-test';
/** The aggregate job that IS the required status check on `main`. */
const CI_GATE_JOB = 'ci-ok';
/** The refresh step that runs the nested-key critic and renders the count. */
const DIAGNOSE_STEP = 'Diagnose what needs a decision';

type Step = { name?: string; run?: string; uses?: string };

const stepsOf = (workflow: unknown, job: string): Step[] => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const steps = (workflow as any).jobs?.[job]?.steps;
  expect(Array.isArray(steps), `no job named ${JSON.stringify(job)} — renamed or deleted`).toBe(
    true
  );
  return steps as Step[];
};

/**
 * A refresh step's shell with `#` comment lines removed.
 *
 * Load-bearing rather than tidiness: this workflow's comments quote the very
 * task names its shell runs (the `run_check` block explains each check it
 * collects), so a comment-inclusive scan invents `run_check` names and the
 * derived population stops being the executed one. The sibling
 * `cfn-schema-refresh-workflow.test.ts` strips for the mirror-image reason —
 * there the comments quote WRONG forms that negative assertions would read as
 * defects.
 */
const stripComments = (run: string): string =>
  run
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const refreshShell = (name: string): string => {
  const step = stepsOf(refresh, 'refresh').find((s) => s.name === name);
  // `step?.run`, not `step`: a step converted to `uses:` passes a `toBeDefined`
  // on the step and then dies with "Cannot read properties of undefined" one
  // line later, which reads as a broken test rather than a renamed step.
  expect(
    step?.run,
    `no refresh step named ${JSON.stringify(name)} runs a shell — renamed, deleted, or now a \`uses:\``
  ).toBeDefined();
  return stripComments(step!.run!);
};

/** Every refresh step's shell, joined — the population `run_check` is read from. */
const allRefreshShells = (): string =>
  stepsOf(refresh, 'refresh')
    .map((s) => stripComments(s.run ?? ''))
    .join('\n');

/**
 * Every check the refresh GRADES a cycle with: the `run_check` names from
 * `Regenerate`, plus the critic `Diagnose` runs for itself.
 *
 * Both halves are needed and neither is the other's superset. `run_check`
 * populates `failedChecks`; the nested-key critic is invoked separately (its
 * non-zero exit is the expected hand-off, so it cannot ride the collector) and
 * populates `divergences`, `nestedKeyUnparsed` and `pendingSdkBump`.
 */
const gradedChecks = (): string[] => {
  // EVERY step, not the one `run_check` lives in today. Scoping this to
  // `Regenerate` made a `run_check` added in a NEW step invisible here; the
  // sibling cfn-schema-refresh-workflow.test.ts was widened with it, so the two
  // cannot disagree about the population and blame each other's table.
  const shells = allRefreshShells();
  const fromRunCheck = [...shells.matchAll(/^\s*run_check (\S+)/gm)].map((m) => m[1]!);
  // The anchored pattern only sees a call that OPENS its line. A `run_check`
  // behind a guard, inside an `if`, or second on a `;`-joined line would be
  // silently dropped — and dropping a NEW one leaves this population equal to
  // CI_COVERAGE's keys, so the set-equality case below stays green over exactly
  // the hole it exists to close. Counting the mentions turns that silence into
  // a failure: an unparsed spelling is reported rather than vanishing.
  const mentions = (shells.match(/\brun_check\s+\S/g) ?? []).length;
  expect(
    fromRunCheck.length,
    `${mentions} \`run_check\` invocation(s) in the refresh shell, but only ${fromRunCheck.length} ` +
      'parsed. A call that does not open its line is invisible to this fence — put it on its own ' +
      'line, or widen the pattern here.'
  ).toBe(mentions);

  // The Diagnose step stays SCOPED, and that is deliberate rather than an
  // oversight of the widening above: `run_check` is a marker that says "this is
  // graded", while a bare `vp run` is not — the refresh also runs generators
  // (`gen:all-matrices`, `format`) whose failure aborts the step under
  // `set -euo pipefail`, so no PR and no marking follow and they grade nothing.
  // What makes the scoping safe is that this is the step whose invocation
  // WRITES the count, asserted below, so it cannot quietly stop being the one
  // the count comes from.
  const diagnose = refreshShell(DIAGNOSE_STEP);
  expect(
    diagnose,
    `the ${JSON.stringify(DIAGNOSE_STEP)} step no longer writes the decision count, so scoping ` +
      'the graded-checker scan to it is no longer justified'
  ).toContain('--decision-count-out');
  const fromDiagnose = [...diagnose.matchAll(/^\s*vp run (\S+)/gm)].map((m) => m[1]!);
  return [...new Set([...fromRunCheck, ...fromDiagnose])];
};

/**
 * The command `ci.yml` covers each graded check with, and which decision terms
 * ride on it.
 *
 * Keyed by the refresh's OWN check name and asserted set-equal to the derived
 * population, so a `run_check` added to the refresh fails here until somebody
 * decides how CI reaches it. That forced decision is the entire mechanism —
 * the invariant cannot be preserved by a reviewer remembering it.
 *
 * `covers` names terms of `countDecisions`, not prose: the term list is derived
 * from the shipped function below, and every term must appear here at least
 * once.
 */
const CI_COVERAGE: Record<string, { command: string; covers: string[]; why: string }> = {
  'property-coverage': {
    command: 'vp run test',
    covers: ['removed', 'failedChecks'],
    why:
      'An UNSETTLED removal leaves a provider declaring a property the schema no longer has, and ' +
      'tests/unit/provisioning/property-coverage.test.ts fails that classification unless the ' +
      "property is in _todo-backfill.json's bogusTolerated. It reaches CI through the whole unit " +
      'suite rather than a task of its own. The link holds only because `partitionSettledRemovals` ' +
      'decides SETTLED from the same tolerance FILE that `classifyCoverage` reads: subtracting ' +
      'only the current cycle\'s `written` list left an already-tolerated removal counted while ' +
      'property-coverage was green (go-to-k/cdkd#3005), and the confluence case in ' +
      'diagnose-schema-refresh.test.ts is what pins the two readers to one definition.',
  },
  'audit:sdk-attr-coverage:check': {
    command: 'vp run audit:sdk-attr-coverage:check',
    covers: ['failedChecks'],
    why: 'Same task, run as its own step.',
  },
  'audit:enrichment-coverage:check': {
    command: 'vp run audit:enrichment-coverage:check',
    covers: ['failedChecks'],
    why: 'Same task, run as its own step.',
  },
  'fixture-consumer-tests': {
    command: 'vp run test',
    covers: ['failedChecks'],
    why:
      'The refresh names seven fixture-reading suites explicitly because it has no whole-suite ' +
      'run; CI has one, so every member is reached without naming any of them. The sibling suite ' +
      'fences the refresh-side list against the silentDrop family.',
  },
  'audit:nested-key-coverage:check': {
    command: 'vp run audit:nested-key-coverage:check',
    covers: ['divergences', 'nestedKeyUnparsed', 'pendingSdkBump'],
    why:
      'The critic exits 1 on any divergence outside NESTED_KEY_ALLOW_LIST. pendingSdkBump rides ' +
      'it too: partitionPendingSdkBump moves such a finding out of `divergences` inside the ' +
      'DIAGNOSIS only, so the critic itself is still red for it. nestedKeyUnparsed has two ' +
      'disjuncts. The parser-shortfall one compares a strict against a loose parse of the SAME ' +
      'log, so it can only fire over finding-shaped lines the critic PRINTED — which it does on ' +
      'its failing path, its --check clean path emitting one summary line and no finding. The ' +
      'zero-divergence one requires a non-zero rc, and that is the REFRESH run\'s rc, not CI\'s: ' +
      'ci.yml runs the task itself, so an ENVIRONMENTAL failure of the refresh invocation (an ' +
      'empty log, a missing task, an OOM kill — the three that disjunct exists for) counts a ' +
      'decision while CI is green. That is the OVER-count direction, which blocks a merge rather ' +
      'than allowing one, so it does not reopen go-to-k/cdkd#3005 — but it is stated because this ' +
      'file refuses over-claims, and \'both disjuncts need the critic to be red\' was one.',
  },
};

/**
 * Terms nothing in `ci.yml` reddens, each with the reason it is accepted.
 *
 * Asserted to be EXACTLY this set, so a new uncovered term is a decision
 * somebody made rather than a gap that accumulated — and asserted disjoint from
 * everything `CI_COVERAGE` claims, so a term cannot be both excused here and
 * counted as protected there.
 */
const UNCOVERED_TERMS: Record<string, string> = {
  unreadable: [
    'Not a schema decision — it is the DIAGNOSIS failing to read its own input, and it has TWO',
    'producers which differ in exactly the way that matters here. `committedVersion` sets it when',
    '`git show HEAD:<fixture>` fails for a reason that is NOT "path not in HEAD"; there the',
    'working-tree copy CI parses is fine, so every fixture-driven check stays green and the term is',
    'genuinely uncovered. The `catch` around `comparePropertySets` sets it too, and that arm is',
    'NOT confined to the safe direction: the call parses BOTH sides, so an unparseable COMMITTED',
    'fixture reaches it with the working-tree copy fine and CI green, exactly like the first',
    'producer. Only an unparseable WORKING-TREE fixture reddens CI, since every fixture-reading',
    'check fails to load it. So the exemption is needed for both producers. Accepted rather',
    'than mechanised because its arms break the refresh run as a whole rather than describing',
    'anything about a schema: git absent, a broken repository, or the 32 MB `maxBuffer` — which the',
    'corpus is three orders of magnitude short of (largest fixture 68,594 B over the 134 files the diagnosis reads,',
    'measured 2026-09-12). It is also loud where it happens: the diagnosis renders the unreadable',
    'fixtures by name in the PR body it is counted in. Recorded on go-to-k/cdkd#3005 as the',
    'residual of closing it.',
  ].join(' '),
};

// THREE THINGS ARE NOT ASSERTABLE HERE, named so they are not
// mistaken for things this file covers. An unassertable link left unstated is
// worse than an uncovered term, because the header's argument then reads as
// fully fenced.
//
// 1. `ci-ok` is a REQUIRED status check on `main`. That is repository branch
//    protection (a ruleset, not a file), so no test can see it. Confirmed live
//    2026-09-12 — `gh api repos/go-to-k/cdkd/rules/branches/main` returns
//    `ci-ok` among six required contexts — and were it removed, every case
//    below would still pass while nothing blocked the merge button.
// 2. The refresh grades `property-coverage` under `CDKD_GENERATE_BACKFILL=true`
//    and `ci.yml` does not. The writer mode regenerates `types` before
//    asserting, so its `unaccounted` arm cannot fail — a strictly WEAKER
//    predicate than CI's. That is the safe direction for the claim (it can only
//    make the refresh count LOWER than CI's redness), but the command-prefix
//    match cannot see an env difference, so the two runs are not pinned to one
//    predicate here.
// 3. The two sides derive `handled` from different places. The count reads the
//    GENERATED module, whose `handled` set `gen-property-coverage.ts` builds as
//    a UNION across provider FILES, while `property-coverage.test.ts` reads the
//    ONE registered provider's runtime map. A type declared in two provider
//    files would therefore give the count a strict superset, and a removal of a
//    property contributed by the UNREGISTERED file would be counted with CI
//    green — the #3005 shape again, one layer down. Measured 2026-09-12: no
//    type is declared in two files, so it is latent, not live. Left as a
//    residual rather than fenced here because the right subject is the
//    generator, not this relation.

/**
 * The ONE extraction. `decisionTerms` and the probe cases below both call it,
 * so the corpus that justifies the parser exercises the code that ships — a
 * hand-written second copy would be a seventh spelling to get wrong, and round
 * 9 measured exactly that: with the walk duplicated, five arms of the real one
 * could each be deleted with every case still green.
 *
 * The reasoning for parsing at all, and what each refusal is for, lives on
 * `decisionTerms` below — ONE copy, because a duplicated paragraph is what this
 * commit is about. (The duplicate that stood here was already stale: it named
 * two refusals after a third had been added.)
 *
 * Returns names AND refusals rather than throwing, so the caller decides what a
 * refusal means: fatal for the shipped signature, expected for a probe.
 */
/**
 * The ONE extraction. `decisionTerms` and the probe cases below both call it,
 * so the corpus that justifies the parser actually exercises the code that
 * ships — a hand-written second copy would be a seventh spelling to get wrong,
 * and round 9 measured exactly that: with the walk duplicated, five arms of the
 * real one (both refusals, the quoted/numeric key arms and `propertyName`)
 * could each be deleted with every case still green.
 *
 * Returns names AND refusals rather than throwing, so the caller decides what a
 * refusal means: fatal for the shipped signature, expected for a probe.
 */
const extractTerms = (functionSource: string): { names: string[]; refusals: string[] } => {
  const sourceFile = ts.createSourceFile(
    'count-decisions.js',
    `const __countDecisions = ${functionSource};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if ((diagnostics?.length ?? 0) > 0) return { names: [], refusals: ['the source did not parse'] };

  let parameters: ts.NodeArray<ts.ParameterDeclaration> | undefined;
  const walk = (node: ts.Node): void => {
    if (
      parameters === undefined &&
      (ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isArrowFunction(node))
    ) {
      parameters = node.parameters;
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  if (parameters === undefined || parameters.length === 0) {
    return { names: [], refusals: ['no parameters'] };
  }
  // A SECOND parameter is an unnameable term class by the same argument the two
  // refusals below rest on: `countDecisions({...}, schemaGaps = [])` counts a
  // seventh decision and this walk reads only the bag. Measured silent before
  // this check existed.
  if (parameters.length > 1) {
    return { names: [], refusals: [`${parameters.length} parameters — only the first is read`] };
  }
  const binding = parameters[0]!.name;
  if (!ts.isObjectBindingPattern(binding)) {
    return { names: [], refusals: ['the parameter is not an object binding pattern'] };
  }

  const names: string[] = [];
  const refusals: string[] = [];
  for (const element of binding.elements) {
    if (element.dotDotDotToken) {
      refusals.push('a rest element');
      continue;
    }
    const key = element.propertyName ?? element.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)) {
      names.push(key.text);
    } else {
      refusals.push(`a computed key (${key.getText(sourceFile)})`);
    }
  }
  return { names, refusals };
};

/**
 * The decision terms, parsed out of the SHIPPED `countDecisions`.
 *
 * `countDecisions` destructures its input, so the parameter names ARE the
 * terms. A seventh term added there lands in this set with no entry in
 * `CI_COVERAGE`'s `covers` and fails — which is the point: a decision class
 * nothing reddens is the exact defect #3005 reports.
 *
 * WHY A PARSER, and why that is not over-engineering. This derivation was a
 * regex over the destructuring text, and it was wrong SIX times: counting
 * commas (false red on a default holding one, false green on `a, b`); a
 * position pattern that consumed its own separator; one that missed a rest
 * element and a key position; one that missed a computed key carrying its own
 * `]`; a whole-line refusal on surviving brackets that still missed a
 * surviving QUOTE, where the strip had swallowed the separating comma. Each
 * fix was correct on the shape the previous one got wrong, which is the
 * signature `.claude/skills/work-issues/references/implement.md` names: three
 * spellings in three rounds means change instrument, parse for real, and
 * REFUSE what the model does not cover.
 *
 * Every refusal `extractTerms` can return is FATAL here. A rest element, a
 * computed key and a second parameter all mean a decision term can exist that
 * this fence cannot name — a rest element lets one arrive with no signature
 * change at all — and a fence that silently classifies a subset is the defect
 * this file is about, one level up.
 */
const termsOrFail = (functionSource: string): string[] => {
  const { names, refusals } = extractTerms(functionSource);
  // Factored out of `decisionTerms` so a CASE can drive it. Left inline, this
  // was the one arm with no red: today's `countDecisions` yields no refusals,
  // so neutering the assertion restored silent-subset classification — the
  // defect this file exists to refuse — with every case green.
  expect(
    refusals,
    `countDecisions is shaped so this fence cannot name every term (${JSON.stringify(refusals)}). ` +
      'A term it cannot NAME is one it cannot classify. Name the term, or widen the extraction ' +
      'deliberately.'
  ).toEqual([]);
  return names;
};

const decisionTerms = (): string[] => termsOrFail(countDecisions.toString());

/**
 * The commands a `ci.yml` job runs, one per line, comments stripped.
 *
 * Lines rather than whole `run:` blocks: most checks are a single-line step,
 * but `vp run test` sits inside a multi-line block with a pipefail guard around
 * it, and a whole-block `includes` would also match a task named only in that
 * block's error message.
 */
/**
 * The same lines, each paired with the SHELL of the step it came from — a
 * neutralising tail can be armed or disarmed by something earlier in the step
 * (`set -o pipefail`), which a flattened line list cannot see.
 */
const ciCommandsWithStep = (job: string): Array<{ line: string; body: string }> =>
  stepsOf(ci, job).flatMap((s) => {
    const body = s.run ?? '';
    return body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .map((line) => ({ line, body }));
  });

/**
 * Whether a matched command line can still FAIL its job.
 *
 * Module scope so a CASE can drive it: the pipe arm below has no line in
 * ci.yml today, so left as a closure it was the one arm with no red.
 */
// A matched line must also be able to FAIL the job. `vp run x || true` and
// `vp run x || echo …` satisfy a plain prefix match while the step exits 0,
// as does backgrounding with a trailing `&`. Step-level `if:` and
// `continue-on-error` are the same lever one level up and are fenced by
// ci-ok-gate.test.ts; the shell tail is the half nothing else watches.
//
// `&&` and `;` are deliberately NOT here, and an earlier revision of this
// comment claimed they were neutralisers, which is false: under `bash -e`
// (the GitHub default) `a && b` propagates `a`'s status and `a; b` aborts
// at `a`. Rejecting them would fire on correct lines, and a fence that reds
// correct code teaches the next author to work around it.
const neutralised = (line: string, command: string, stepBody: string): boolean => {
  const tail = line.slice(command.length);
  // `&&$` is a line continuation, not backgrounding — the comment above
  // says `&&` is deliberately not a neutraliser, so the pattern must not
  // catch it through the backgrounding arm. The `^&` alternative an earlier
  // revision carried was DEAD: `matches` accepts only `l === command` or
  // `command + ' '`, so a tail is either empty or starts with a space.
  //
  // A PIPE is the arm that was missing, and it is not theoretical: under
  // `bash -e` a pipeline reports its LAST stage, so `vp run <check> | tee x`
  // exits 0 on failure. The one real pipeline in check-build-test is armed
  // by `set -o pipefail`, which the ordering case below asserts — for THAT
  // step. A piped check in any other step would pass here and redden
  // nothing, so the pipe is rejected unless the same step sets pipefail.
  // A SINGLE pipe, not `||`: `/\|/` matches both, so the pipe arm swallowed the
  // `||` arm and that one stopped discriminating — measured.
  if (/(^|[^|])\|($|[^|])/.test(tail) && !/^\s*set -o pipefail/m.test(stepBody)) return true;
  return /(\|\||[^&]&\s*$)/.test(tail);
};

const ciCommandLines = (job: string): string[] =>
  stepsOf(ci, job)
    .flatMap((s) => (s.run ?? '').split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

describe('a refresh PR carrying decisions cannot pass ci-ok (issue #3005)', () => {
  it('is not vacuous — both workflows exist and parse', () => {
    expect(refreshText.length).toBeGreaterThan(5000);
    expect(ciText.length).toBeGreaterThan(5000);
    expect(Object.keys(ci.jobs ?? {})).toContain(CI_CHECK_JOB);
    expect(Object.keys(ci.jobs ?? {})).toContain(CI_GATE_JOB);
    expect(Object.keys(refresh.jobs ?? {})).toContain('refresh');
  });

  it('derives a real graded-check population from the refresh workflow', () => {
    const graded = gradedChecks();
    // Four `run_check` names plus the separately-invoked nested-key critic. A
    // literal, not a relation to CI_COVERAGE's size — a floor computed from the
    // thing it guards is satisfied by the collapse it exists to catch.
    expect(graded.length, `graded checks derived: ${JSON.stringify(graded)}`).toBeGreaterThanOrEqual(
      5
    );
    expect(graded).toContain('audit:nested-key-coverage:check');
  });

  it('reads every destructuring shape, and REFUSES the two it cannot name', () => {
    // The derivation's own cases, against the parser rather than the shipped
    // `countDecisions` — six regex spellings each got a different shape wrong,
    // and an end-to-end mutation could not tell them apart because each was
    // correct on the shape the previous one missed. These are those shapes.
    //
    // The helper re-runs `decisionTerms`'s extraction over a synthetic function
    // rather than restating it: a second copy of the walk would be a seventh
    // spelling to get wrong.
    // The SHIPPED extraction, not a copy of it: `extractTerms` is what
    // `decisionTerms` calls, so deleting one of its arms reds these cases.
    // Round 9 measured the alternative — with the walk duplicated here, five
    // arms of the real one could each be deleted with every case green, under
    // a comment claiming that could not happen.
    const extract = (destructuring: string) =>
      extractTerms(`function countDecisions({ ${destructuring} }) { return 1; }`);

    // Shapes every regex spelling had to be taught one at a time, each read
    // correctly here with no rule of its own.
    const reads: Array<[string, string[]]> = [
      ['removed, divergences', ['removed', 'divergences']],
      ['removed, nestedKeyUnparsed = false', ['removed', 'nestedKeyUnparsed']],
      // Defaults that carry a separator — the false reds the comma count and
      // the bracket refusal produced.
      ["removed, failedChecks = ['a', 'b']", ['removed', 'failedChecks']],
      ['removed, opts = { a: { b: 1 }, c: 2 }', ['removed', 'opts']],
      ['removed, fn = (a, b) => a', ['removed', 'fn']],
      ['removed, tag = `a, b`', ['removed', 'tag']],
      ['removed, nested = [[1], [2]]', ['removed', 'nested']],
      // An ODD quote inside a default: the strip swallowed the separating
      // comma and the second term vanished from every arm.
      ["removed, sepChar = 'it\\'s', schemaGaps = 'x'", ['removed', 'sepChar', 'schemaGaps']],
      // A quoted key names a term; a rename names the PROPERTY, not the local.
      ["removed, 'schema-gaps': schemaGaps", ['removed', 'schema-gaps']],
      ['removed: r, divergences', ['removed', 'divergences']],
    ];
    for (const [destructuring, expected] of reads) {
      const { names, refusals } = extract(destructuring);
      expect(names, `misread: ${destructuring}`).toEqual(expected);
      expect(refusals, `wrongly refused: ${destructuring}`).toEqual([]);
    }

    // ...and the two shapes it must REFUSE rather than silently classify a
    // subset of. A computed key was the shape that escaped every position
    // pattern; a rest element lets a term arrive with no signature change.
    expect(extract('removed, [K[0]]: schemaGaps').refusals).toEqual(['a computed key ([K[0]])']);
    expect(extract('removed, [f(a[0])]: schemaGaps').refusals).toEqual([
      'a computed key ([f(a[0])])',
    ]);
    expect(extract('removed, ...rest').refusals).toEqual(['a rest element']);
    // A SECOND parameter is the same class one level out: the walk reads the
    // bag, so a term declared beside it is unnameable here.
    expect(
      extractTerms('function countDecisions({ removed }, schemaGaps = []) { return 1; }').refusals
    ).toEqual(['2 parameters — only the first is read']);
    // ...and source that does not parse at all. Without a case here the
    // diagnostics refusal could be neutered with every other one green, since
    // every shape above is valid JS by construction.
    expect(extractTerms('function countDecisions({ removed ) { }').refusals).toEqual([
      'the source did not parse',
    ]);
    // Shapes that are refused LOUDLY rather than read as a subset. Each was
    // measured un-probed before this list existed.
    expect(extractTerms('42').refusals).toEqual(['no parameters']);
    expect(extractTerms('function countDecisions(bag) { return 1; }').refusals).toEqual([
      'the parameter is not an object binding pattern',
    ]);
    // ...and the shapes a rewritten `countDecisions` could legitimately take.
    expect(extract('removed, 0: zero').names).toEqual(['removed', '0']);
    expect(extractTerms('({ removed, divergences }) => 1').names).toEqual([
      'removed',
      'divergences',
    ]);
    // Every refusal `extractTerms` can return must be FATAL where the shipped
    // signature is read. Without this the assertion could be neutered and a
    // rest element, a computed key or a second parameter would be silently
    // dropped from the term set with every other case green.
    for (const refusing of [
      'function countDecisions({ removed, ...rest }) { return 1; }',
      'function countDecisions({ removed, [k]: schemaGaps }) { return 1; }',
      'function countDecisions({ removed }, schemaGaps = []) { return 1; }',
      'function countDecisions(bag) { return 1; }',
      '42',
      'function countDecisions({ removed ) { }',
    ]) {
      expect(() => termsOrFail(refusing), `a refusal was not fatal: ${refusing}`).toThrow();
    }
  });

  it('derives a real decision-term population from the shipped countDecisions', () => {
    const terms = decisionTerms();
    expect(terms.length, `terms derived: ${JSON.stringify(terms)}`).toBeGreaterThanOrEqual(6);
    // Named anchors, so a destructuring that parses into plausible-but-wrong
    // identifiers (the shape a regex change produces) fails rather than
    // yielding a set that happens to clear the floor.
    for (const anchor of ['removed', 'divergences', 'failedChecks']) {
      expect(terms, `countDecisions no longer counts ${anchor}`).toContain(anchor);
    }
  });

  it('maps EVERY check the refresh grades to a command ci.yml runs', () => {
    // Set equality in both directions. A `run_check` added to the refresh has
    // no entry here and fails; an entry left behind after its check is retired
    // fails too, so the table cannot rot into a claim about checks that no
    // longer exist.
    expect(new Set(Object.keys(CI_COVERAGE))).toEqual(new Set(gradedChecks()));
  });

  it('runs every mapped command inside check-build-test', () => {
    const lines = ciCommandsWithStep(CI_CHECK_JOB);
    for (const [check, { command }] of Object.entries(CI_COVERAGE)) {
      const matches = lines.filter((e) => e.line === command || e.line.startsWith(`${command} `));
      expect(
        matches.length,
        `${CI_CHECK_JOB} no longer runs ${JSON.stringify(command)}, so the refresh's ` +
          `${JSON.stringify(check)} grading has nothing behind it in CI — a decision of that class ` +
          'would leave ci-ok green and the merge button live'
      ).toBeGreaterThan(0);
      expect(
        matches.some((e) => !neutralised(e.line, command, e.body)),
        `every ${JSON.stringify(command)} invocation in ${CI_CHECK_JOB} has a tail that swallows ` +
          `its failure (${JSON.stringify(matches.map((e) => e.line))}), so the refresh's ` +
          `${JSON.stringify(check)} grading is present but cannot redden the job`
      ).toBe(true);
    }
  });

  it('reads a neutralising tail in both directions — the guard itself', () => {
    // `neutralised`'s own cases, because ci.yml exercises only ONE of its arms:
    // there is a single tailed line in check-build-test and no piped check, so
    // the pipe arm had no red until this existed.
    const CMD = 'vp run audit:x:check';
    const plain = `${CMD}\n`;
    // Can still fail the job.
    expect(neutralised(CMD, CMD, plain)).toBe(false);
    expect(neutralised(`${CMD} --flag`, CMD, plain)).toBe(false);
    // `&&` and `;` propagate under `bash -e`; rejecting them would red correct
    // code, which is the trap this guard has already fallen into once.
    expect(neutralised(`${CMD} && echo ok`, CMD, plain)).toBe(false);
    expect(neutralised(`${CMD} ; echo ok`, CMD, plain)).toBe(false);
    // Cannot.
    // `||` is decided by its OWN arm: the pipe arm used to match `||` too and
    // masked it, so these say nothing unless the two are separable.
    expect(neutralised(`${CMD} || true`, CMD, plain)).toBe(true);
    expect(neutralised(`${CMD} || echo skipped`, CMD, plain)).toBe(true);
    expect(neutralised(`${CMD} || true`, CMD, `set -o pipefail\n${CMD} || true\n`)).toBe(true);
    expect(neutralised(`${CMD} &`, CMD, plain)).toBe(true);
    // A PIPE reports its LAST stage under `bash -e`, so it swallows the check
    // unless the same step armed pipefail.
    expect(neutralised(`${CMD} | tee /tmp/x.log`, CMD, `${CMD} | tee /tmp/x.log\n`)).toBe(true);
    expect(
      neutralised(`${CMD} | tee /tmp/x.log`, CMD, `set -o pipefail\n${CMD} | tee /tmp/x.log\n`)
    ).toBe(false);
  });

  it('runs the unit suite UNFILTERED, which is what reaches the unnamed suites', () => {
    // Two entries lean on `vp run test` covering suites CI never names. That is
    // only true while the invocation carries no filter: `vp run test <name>`
    // would still match a bare `startsWith` and cover nothing.
    const invocations = ciCommandLines(CI_CHECK_JOB)
      // `(\s|$)`, not `\b`: a word boundary fires before `:`, so a legitimate
      // `vp run test:coverage` step would be selected and then red as "a
      // filtered run", which is both wrong and misleading about why.
      .filter((l) => /^vp run test(\s|$)/.test(l))
      // Everything up to the first pipe is the command. Redirections are not
      // arguments to it, and are dropped token-wise rather than by a regex over
      // the whole line: a pattern with a trailing `\S*` also eats the token
      // AFTER a redirection, which is a filter name whenever one follows — the
      // fence would then read a filtered run as unfiltered, the one direction
      // it must never be wrong in.
      .map((line) => {
        const tokens = line.split('|')[0]!.trim().split(/\s+/);
        const kept: string[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const token = tokens[i]!;
          if (!/[<>]/.test(token)) {
            kept.push(token);
            continue;
          }
          // A bare operator (`>`, `2>`) takes its target from the NEXT token;
          // an attached one (`2>&1`, `>out.log`) carries it already.
          if (/[<>]&?$/.test(token)) i++;
        }
        return kept.join(' ');
      });
    expect(
      invocations,
      'check-build-test has no `vp run test` invocation, so the suites CI never names by ' +
        'filename are not run at all'
    ).not.toHaveLength(0);
    expect(
      invocations,
      `every \`vp run test\` in ${CI_CHECK_JOB} must be the whole suite; a filtered one covers ` +
        'only what it names'
    ).toEqual(invocations.map(() => 'vp run test'));
  });

  it('arms pipefail BEFORE the piped unit-suite run, which is what makes it red', () => {
    // The `vp run test` invocation is a PIPELINE (`… | tee`), and a `run:` with
    // no `shell:` is `bash -e {0}`, which does NOT set pipefail — so without
    // `set -o pipefail` the step reports `tee`'s status and a failing suite
    // exits 0. Two CI_COVERAGE entries ride that one line (`property-coverage`
    // and `fixture-consumer-tests`, i.e. the `removed` and `failedChecks`
    // terms), so its redness is load-bearing for this file's whole claim.
    //
    // ORDER, not mere presence: `set -o pipefail` after the pipeline arms
    // nothing. The sibling refresh-workflow suite asserts the same shape for
    // its own tee'd step; the ci.yml side had presence asserted elsewhere and
    // ordering nowhere.
    const step = stepsOf(ci, CI_CHECK_JOB).find((s) => /^\s*vp run test(\s|$)/m.test(s.run ?? ''));
    expect(step, `no step in ${CI_CHECK_JOB} runs the unit suite`).toBeDefined();
    // Comment-stripped: a line such as `# we do not set -o pipefail here`
    // satisfies both assertions below while arming nothing.
    const body = stripComments(step!.run!);
    // Anchored: `stripComments` drops only whole-line comments, so a substring
    // search is satisfied by a trailing `# no set -o pipefail here` or a quoted
    // echo.
    const pipefail = body.search(/^\s*set -o pipefail/m);
    const invocation = body.search(/^\s*vp run test(\s|$)/m);
    expect(pipefail, 'the tee’d unit-suite step no longer sets pipefail').toBeGreaterThan(-1);
    expect(
      pipefail,
      'pipefail is set AFTER the piped `vp run test`, so a failing suite still exits 0 and every ' +
        'check this file maps through the unit suite is unable to redden the job'
    ).toBeLessThan(invocation);
  });

  it('classifies EVERY decision term as CI-covered or knowingly uncovered', () => {
    const covered = new Set(Object.values(CI_COVERAGE).flatMap((e) => e.covers));
    for (const term of decisionTerms()) {
      expect(
        covered.has(term) || term in UNCOVERED_TERMS,
        `countDecisions counts ${JSON.stringify(term)} and nothing here accounts for it. Either ` +
          'name the CI check that reddens for it in CI_COVERAGE, or add it to UNCOVERED_TERMS ' +
          'with the reason — leaving it unclassified means a refresh PR carrying that decision ' +
          'class merges on a green ci-ok, which is issue #3005.'
      ).toBe(true);
    }
  });

  it('keeps the uncovered set exactly what was decided, with a real reason each', () => {
    // Pinned by NAME, not by size: a second uncovered term slipping in under a
    // count is the accumulation this bucket exists to prevent.
    expect(Object.keys(UNCOVERED_TERMS)).toEqual(['unreadable']);
    for (const [term, reason] of Object.entries(UNCOVERED_TERMS)) {
      expect(reason.length, `${term}'s exemption reason is a placeholder`).toBeGreaterThan(200);
    }
  });

  it('never excuses a term it also claims to cover', () => {
    // The two buckets answer the same question, so an overlap means one of them
    // is wrong and the reader cannot tell which.
    const covered = new Set(Object.values(CI_COVERAGE).flatMap((e) => e.covers));
    for (const term of Object.keys(UNCOVERED_TERMS)) {
      expect(
        covered.has(term),
        `${JSON.stringify(term)} is both excused in UNCOVERED_TERMS and claimed as covered in ` +
          'CI_COVERAGE'
      ).toBe(false);
    }
  });

  it('does not claim coverage for a term countDecisions stopped counting', () => {
    // The stale direction. A `covers` entry naming a retired term reads as
    // protection and is inert; it also silently weakens the previous case,
    // whose population is the live term list.
    const terms = new Set(decisionTerms());
    for (const [check, { covers }] of Object.entries(CI_COVERAGE)) {
      for (const term of covers) {
        expect(
          terms.has(term),
          `CI_COVERAGE[${JSON.stringify(check)}] claims to cover ${JSON.stringify(term)}, which ` +
            'countDecisions no longer counts'
        ).toBe(true);
      }
    }
    for (const term of Object.keys(UNCOVERED_TERMS)) {
      expect(
        terms.has(term),
        `UNCOVERED_TERMS excuses ${JSON.stringify(term)}, which countDecisions no longer counts — ` +
          'a standing exemption for a term that does not exist reads as a residual and is inert'
      ).toBe(true);
    }
  });

  it('keeps check-build-test in ci-ok’s needs, which is the link to the merge button', () => {
    // The last link in the chain, and the cheapest to break: a red
    // check-build-test only blocks a merge because ci-ok waits on it and ci-ok
    // is the required status check on `main`. `ci-ok-gate.test.ts` asserts the
    // needs list covers every job; this asserts the one membership THIS
    // invariant rests on, so the relation is stated where it is relied upon.
    const needs: string[] = ci.jobs[CI_GATE_JOB].needs;
    expect(Array.isArray(needs), `${CI_GATE_JOB} declares no needs list`).toBe(true);
    expect(needs).toContain(CI_CHECK_JOB);
  });
});
