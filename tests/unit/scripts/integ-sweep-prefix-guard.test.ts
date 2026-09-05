import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DESTRUCTIVE_LITERALS,
  DESTRUCTIVE_VERBS,
  blankHeredocs,
  collapsibleFilters,
  findNamespaceAnchoredSweeps,
  findSweeps,
  findUnguardedSweeps,
  functionRanges,
  hasDelegatedGuard,
  hasEmptinessGuard,
  hasScopeGuard,
  matchesEmptyString,
  scopeSites,
  structuralLines,
  uncommented,
} from '../../../scripts/check-integ-sweep-prefix-guard.js';

/**
 * Fence for the destructive prefix-sweep guard convention (issue #2621).
 *
 * A fixture teardown that LISTS resources under a variable prefix and DELETES
 * every name it gets back is one empty variable away from an account-wide
 * delete, and it runs under `set +eu` — which disables the only thing that
 * would have caught the empty value. #2621 was filed because two fixtures had
 * grown the shape and only one had the guard; the point of this file is that
 * the next one cannot ship without it.
 *
 * Two halves, deliberately split the way the `s3-versions.sh` pair is
 * (`docs/integ-fixture-conventions.md`):
 *
 *  - STATIC: `scripts/check-integ-sweep-prefix-guard.ts` classifies every shell
 *    script under `tests/integration/`, and the tree must carry zero unguarded
 *    sweeps. The file list is derived by walking the tree, not hand-listed.
 *  - EXECUTABLE: each guarded sweep is RUN against a fake `aws` that records
 *    its argv, proving the refusal happens before any AWS call rather than only
 *    that the source text contains a `case`.
 *
 * Every ACCEPT arm of the classifier carries a probe PAIR — a case that dies
 * when the arm is deleted, and one that dies when the arm degrades to "always
 * true". The first revision shipped three arms with only the first half, and
 * each was silently weakenable.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const INTEG_ROOT = join(REPO_ROOT, 'tests/integration');

/** Bound for a case that spawns `/bin/bash` (`.claude/rules/testing.md`). */
const SPAWN_TIMEOUT_MS = 60_000;

/** Every `*.sh` under tests/integration, recursively. */
function shellScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'cdk.out') continue;
      out.push(...shellScripts(full));
    } else if (entry.isFile() && entry.name.endsWith('.sh')) {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Destructive prefix sweeps the classifier must still SEE, PER FIXTURE and by
 * COUNT. A presence-only floor was the first revision's, and it was satisfied
 * by a classifier that reported only the first finding in each file — measured
 * green with `iam-oidc-provider`'s second sweep silently dropped. Counts make
 * that a failure.
 */
const KNOWN_SWEEP_COUNTS: Readonly<Record<string, number>> = {
  // The shared helper, and the reason cross-function flow exists: it lists in
  // `_s3v_rows` and deletes in `_s3v_delete_rows`. An enclosing-function window
  // reported ZERO sweeps for the whole file.
  's3-versions.sh': 2,
  'eventsourcemapping-race': 1,
  'cc-api-fallback-transitions': 1,
  'cc-getatt-readback': 1,
  'cc-protection-flip-eks': 1,
  'iam-oidc-provider': 2,
  'lambda-snapstart': 1,
  'loggroup-class-guard': 1,
  'loggroup-never-expire-guard': 1,
  'recreate-mixed-direction': 1,
  'recreate-nested-logical-id-collision': 1,
  'recreate-via-cc-api': 1,
  'recreate-via-sdk-provider': 1,
  'secrets-array-nested': 1,
};

/** Measured 2026-09-06 on this branch; the map above is asserted to sum to it. */
const KNOWN_SWEEP_TOTAL = 16;

describe('DESTRUCTIVE_VERBS', () => {
  it('is the exact set, pinned by name', () => {
    // `deregister` is not decorative: `secrets-array-nested` retires ECS task
    // definitions with `deregister-task-definition`, and a sweep built on one
    // is exactly as unbounded as a `delete-` sweep. It was missing from the
    // first revision and that sweep was invisible.
    expect([...DESTRUCTIVE_VERBS]).toEqual([
      'delete',
      'remove',
      'deregister',
      'terminate',
      'purge',
      'revoke',
      'detach',
      'disassociate',
      'disable',
    ]);
    expect([...DESTRUCTIVE_LITERALS]).toEqual(['schedule-key-deletion', 'release-address']);
  });

  it.each([
    ['ecr batch-delete-image', 'aws ecr batch-delete-image --repository-name "${name}"'],
    ['kms schedule-key-deletion', 'aws kms schedule-key-deletion --key-id "${name}"'],
    ['ec2 release-address', 'aws ec2 release-address --allocation-id "${name}"'],
    ['iam detach-role-policy', 'aws iam detach-role-policy --role-name "${name}"'],
  ])('anchors the compound verb: %s', (_label, deleteLine) => {
    // The anchor required WHITESPACE before the verb, so a compound spelling
    // never matched and eight live sites read as harmless.
    expect(
      findSweeps(
        [
          'cleanup() {',
          '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
          `    ${deleteLine}`,
          '  done',
          '}',
        ].join('\n'),
      ),
    ).toHaveLength(1);
  });
});

describe('positional parameters are scope variables', () => {
  const helper = (filter: string) =>
    [
      'sweep_for() {',
      `  for n in $(aws logs describe-log-groups ${filter}); do`,
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
      '}',
      'cleanup() {',
      '  sweep_for "${LG_PREFIX}"',
      '}',
    ].join('\n');

  it.each([
    ['bare $1', '--log-group-name-prefix "$1"'],
    ['braced ${1}', '--log-group-name-prefix "${1}"'],
    ['inside starts_with', `--query "R[?starts_with(N, '\$1')]"`],
  ])('sees a helper sweeping its own argument: %s', (_label, filter) => {
    // `literalPart` did not strip `$1`, so the filter read as literally
    // anchored and the sweep was invisible — the fence failing open on the very
    // idiom the convention tells fixtures to use.
    expect(findSweeps(helper(filter))).toHaveLength(1);
  });

  it('resolves the guard to the CALLER argument', () => {
    const guardedCaller = [
      'sweep_for() {',
      '  for n in $(aws logs describe-log-groups --log-group-name-prefix "$1"); do',
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
      '}',
      'cleanup() {',
      '  case "${LG_PREFIX}" in',
      '    /cdkd-integ/*/) ;;',
      '    *) return 0 ;;',
      '  esac',
      '  sweep_for "${LG_PREFIX}"',
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(guardedCaller)).toHaveLength(0);
    expect(findUnguardedSweeps(helper('--log-group-name-prefix "$1"'))).toHaveLength(1);
  });

  it('requires EVERY call site to be guarded', () => {
    const twoCallers = [
      'sweep_for() {',
      '  for n in $(aws logs describe-log-groups --log-group-name-prefix "$1"); do',
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
      '}',
      'guarded_caller() {',
      '  case "${A}" in /cdkd-integ/*/) ;; *) return 0 ;; esac',
      '  sweep_for "${A}"',
      '}',
      'unguarded_caller() {',
      '  sweep_for "${B}"',
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(twoCallers)).toHaveLength(1);
  });

  it('accepts a LITERAL argument as unable to collapse', () => {
    const literalCaller = [
      'sweep_for() {',
      '  for n in $(aws logs describe-log-groups --log-group-name-prefix "$1"); do',
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
      '}',
      'cleanup() {',
      '  sweep_for "/cdkd-integ/fixed/"',
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(literalCaller)).toHaveLength(0);
  });

  it('maps the parameter POSITION, not just the first', () => {
    const sites = scopeSites(
      uncommented(
        [
          'f() {',
          '  local a="$1" scope="$2"',
          '  aws logs describe-log-groups --log-group-name-prefix "${scope}"',
          '}',
          'g() {',
          '  f "${ONE}" "${TWO}"',
          '}',
        ].join('\n').split('\n'),
      ),
      2,
      'scope',
    );
    expect(sites.viaParameter).toEqual([[{ line: 5, variable: 'TWO' }]]);
  });
});

describe('collapsibleFilters', () => {
  it.each([
    ['bare prefix flag', '--log-group-name-prefix "${LG_PREFIX}"'],
    ['single-quoted value', "--queue-name-prefix '${STACK}'"],
    ['unquoted value', '--queue-name-prefix ${STACK}'],
    ['equals form', '--name-prefix="${STACK}"'],
    ['bare $VAR', '--log-group-name-prefix "$LG_PREFIX"'],
    ['default-expansion', '--log-group-name-prefix "${LG_PREFIX:-}"'],
    ['ECS family prefix', '--family-prefix "${FAMILY}"'],
    ['two variables', '--prefix "${A}${B}"'],
    ['starts_with', `--query "Roles[?starts_with(RoleName, '\${STACK}')].RoleName"`],
    ['starts_with, double quotes', '--query "Fns[?starts_with(Name, \\"${STACK}\\")]"'],
    ['starts_with, backtick literal', '--query "R[?starts_with(N, \\`${STACK}\\`)]"'],
    ['contains', `--query "Roles[?contains(RoleName, '\${STACK}')].RoleName"`],
    ['contains, backtick literal', '--query "R[?contains(N, \\`${STACK}\\`)]"'],
    ['ends_with', `--query "R[?ends_with(N, '\${STACK}')]"`],
    ['starts_with on an indexed field', `--query "X[?starts_with(a.b[0], '\${S}')]"`],
  ])('flags a filter that collapses to match-everything: %s', (_label, fragment) => {
    expect(collapsibleFilters(`aws logs describe-log-groups ${fragment}`)).toHaveLength(1);
  });

  it.each([
    ['literal anchor before the variable', '--log-group-name-prefix "/aws/lambda/${STACK}"'],
    ['literal anchor after the variable', `--query "R[?starts_with(N, '\${STACK}-PipeRole')]"`],
    ['literal anchor, contains', `--query "R[?contains(N, '\${STACK}-Role')]"`],
    ['fully literal prefix', '--log-group-name-prefix "/cdkd-integ/x/"'],
    ['no prefix argument at all', '--log-group-name "${LG}"'],
    ['a non-prefix flag', '--region "${REGION}"'],
    ['a predicate that is FALSE on empty', `--query "R[?N=='\${STACK}']"`],
  ])('leaves a filter that cannot collapse: %s', (_label, fragment) => {
    expect(collapsibleFilters(`aws logs describe-log-groups ${fragment}`)).toHaveLength(0);
  });

  it('reports the variables that drive the collapse', () => {
    const [f] = collapsibleFilters('aws s3api list-objects-v2 --prefix "${A}${B}"');
    expect(f?.variables).toEqual(['A', 'B']);
  });
});

describe('structuralLines / uncommented', () => {
  it('keeps a command substitution readable inside a double-quoted word', () => {
    // The tree's commonest listing idiom is `names="$(aws ... )"`. Blanking
    // through it made EVERY log-group sweep invisible (measured: 13 -> 11).
    const [line] = structuralLines(['  names="$(aws logs describe-log-groups --prefix "${P}")"']);
    expect(line).toContain('aws logs describe-log-groups');
    expect(line).not.toContain('${P}');
  });

  it('blanks a quoted string that merely NAMES an aws command', () => {
    const [line] = structuralLines(['  echo "  aws s3api list-object-versions --prefix ${KEY}"']);
    expect(line).not.toContain('list-object-versions');
  });

  it('blanks the word `done` inside a message but not a real `done`', () => {
    const [msg, real] = structuralLines(['    echo "sweep is done"', '  done']);
    expect(msg).not.toMatch(/\bdone\b/);
    expect(real).toMatch(/\bdone\b/);
  });

  it('uncommented keeps quoted content but drops comments', () => {
    const [line] = uncommented(['  case "${STACK}" in   # the guard']);
    expect(line).toContain('${STACK}');
    expect(line).not.toContain('the guard');
  });

  it('functionRanges sees both declaration spellings', () => {
    const src = ['a() {', '  :', '}', 'function b {', '  :', '}'];
    expect(functionRanges(uncommented(src))).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });
});

describe('matchesEmptyString', () => {
  it.each(['*', '**', '""', "''", '* | x'])('%s matches the empty string', (p) => {
    expect(matchesEmptyString(p)).toBe(true);
  });
  it.each(['?*', 'Cdkd?*', '/cdkd-integ/*/', 'a|b'])('%s does not', (p) => {
    expect(matchesEmptyString(p)).toBe(false);
  });
});

describe('findSweeps — how a listing reaches a delete', () => {
  const DELETE = '    aws logs delete-log-group --log-group-name "${name}"';

  const wrap = (body: string[]) => ['cleanup() {', '  set +eu', ...body, '}'].join('\n');

  it('sees the loop-word-source shape', () => {
    expect(
      findSweeps(
        wrap([
          '  for name in $(aws logs describe-log-groups \\',
          '      --log-group-name-prefix "${LG_PREFIX}" \\',
          "      --query 'logGroups[].logGroupName' --output text); do",
          DELETE,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('sees the captured-then-iterated shape', () => {
    expect(
      findSweeps(
        wrap([
          '  names="$(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}")"',
          '  for name in ${names}; do',
          DELETE,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('sees a capture whose loop is FAR below it', () => {
    // The first revision looked 12 lines ahead and passed silently past that.
    const filler = Array.from({ length: 25 }, (_, i) => `  echo "step ${i}"`);
    expect(
      findSweeps(
        wrap([
          '  names="$(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}")"',
          ...filler,
          '  for name in ${names}; do',
          DELETE,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('sees a pipe into `while read`', () => {
    expect(
      findSweeps(
        wrap([
          '  aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" | while read -r name; do',
          DELETE,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('sees a pipe into `xargs`', () => {
    expect(
      findSweeps(
        wrap([
          '  aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" \\',
          '    | xargs -I{} aws logs delete-log-group --log-group-name {}',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('FAILS CLOSED on a shape it cannot follow', () => {
    // Output goes nowhere this scanner can track, and the function deletes.
    // The first revision answered "not a sweep" here — a silent pass.
    expect(
      findSweeps(
        wrap([
          '  aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}" > "${TMP}"',
          '  aws logs delete-log-group --log-group-name "$(head -1 "${TMP}")"',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('is not fooled by a `done` inside a message in the loop body', () => {
    expect(
      findSweeps(
        wrap([
          '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}"); do',
          '    echo "sweep is done"',
          DELETE,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('ignores a collapsible listing whose output is only READ', () => {
    expect(
      findSweeps(
        wrap([
          '  rows="$(aws logs describe-log-groups --log-group-name-prefix "${LG}")"',
          '  [ -z "${rows}" ] || return 1',
          '  aws logs delete-log-group --log-group-name "/a/literal/name"',
        ]),
      ),
    ).toHaveLength(0);
  });

  it('ignores an `echo` that merely PRINTS an aws command', () => {
    expect(
      findSweeps(
        wrap([
          '  echo "  aws s3api list-object-versions --bucket b --prefix ${LOCK_KEY}" >&2',
          '  aws s3 rm "s3://b/a/literal/key"',
        ]),
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['delete-log-group', 'aws logs delete-log-group --log-group-name "${name}"'],
    ['delete-role', 'aws iam delete-role --role-name "${name}"'],
    ['deregister-task-definition', 'aws ecs deregister-task-definition --task-definition "${name}"'],
    ['terminate-instances', 'aws ec2 terminate-instances --instance-ids "${name}"'],
    ['revoke-security-group-ingress', 'aws ec2 revoke-security-group-ingress --group-id "${name}"'],
    ['s3 rb', 'aws s3 rb "s3://${name}" --force'],
    ['s3 rm', 'aws s3 rm "s3://${name}" --recursive'],
  ])('recognizes %s as destructive', (_label, deleteLine) => {
    expect(
      findSweeps(
        wrap([
          '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}"); do',
          `    ${deleteLine}`,
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('does not treat a read-only call inside the loop as destructive', () => {
    expect(
      findSweeps(
        wrap([
          '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}"); do',
          '    aws logs describe-log-streams --log-group-name "${name}"',
          '  done',
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe('the guard must DOMINATE the sweep', () => {
  const SWEEP = [
    '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${LG_PREFIX}"); do',
    '    aws logs delete-log-group --log-group-name "${name}"',
    '  done',
  ];

  const script = (before: string[], after: string[] = []) =>
    ['cleanup() {', '  set +eu', ...before, ...after, '}'].join('\n');

  it('accepts the WRAPPING form (sweep inside a non-catch-all arm)', () => {
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    /cdkd-integ/*/)',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '    *)',
          '      echo "    WARN: refused (empty scope)" >&2',
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(0);
  });

  it('accepts the REFUSING form (catch-all exits, sweep after esac)', () => {
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/) ;;',
            '    *) echo "refused" >&2; exit 0 ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(0);
  });

  it('accepts the one-line REFUSING spelling', () => {
    expect(
      findUnguardedSweeps(
        script(['  case "${LG_PREFIX}" in /cdkd-integ/*/) ;; *) exit 0 ;; esac'], SWEEP),
      ),
    ).toHaveLength(0);
  });

  it('REFUSES a sweep moved below the esac when the catch-all does not exit', () => {
    // The defect the first revision shipped: it looked only for "a case on this
    // variable appears above", so moving the sweep out of the arm left it
    // running for every value while the fence stayed green (measured on the
    // real `iam-oidc-provider`).
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/) echo "ok" ;;',
            '    *) echo "warned but continued" >&2 ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a sweep in the CATCH-ALL arm even when a guarding arm exists', () => {
    // The inverted wrapping guard: it sweeps exactly when the scope is wrong.
    // Widening the position bound from `arm.end` to `esac` accepts this.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    /cdkd-integ/*/)',
          '      echo "ok"',
          '      ;;',
          '    *)',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES the REFUSING form when the case has NO catch-all at all', () => {
    // bash falls straight THROUGH a `case` no arm matches, so a statement with
    // only a guarding arm stops nothing. Dropping the `empties.length > 0`
    // requirement accepts it.
    expect(
      findUnguardedSweeps(
        script(['  case "${LG_PREFIX}" in', '    /cdkd-integ/*/) ;;', '  esac'], SWEEP),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a catch-all that only NAMES exit in a message', () => {
    // `escapes` was tested against text with quotes intact, so a body of
    // `echo "will return the caller's status"` read as escaping.
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/) ;;',
            '    *) echo "no scope; will return the caller exit status" >&2 ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES when a NESTED case supplies the escaping arm', () => {
    // Taking the first `esac` binds the INNER statement's arms to the outer
    // one, so the outer fall-through catch-all is never seen and the sweep
    // reads as guarded. Written multi-line on purpose: with the nested `case`
    // on ONE line both parsers answer UNGUARDED (a first-esac parser finds no
    // arms at all), so the compact spelling cannot tell them apart.
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/)',
            '      case "${MODE}" in',
            '        x) ;;',
            '        *) exit 1 ;;',
            '      esac',
            '      ;;',
            '    *)',
            '      echo "no scope, but keep going" >&2',
            '      ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a ONE-LINE nested case supplying arms to the outer statement', () => {
    // The multi-line twin is caught by the nesting-depth check. This one is
    // ALSO caught by it plus the `;;` termination — measured, so do not claim
    // the one-line masking is what saves it. The two cases below are the ones
    // that actually distinguish masking, and they fail in the false-POSITIVE
    // direction.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    *) case "${REGION}" in us-east-1) ;; *) echo skip ;; esac',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a `-n` emptiness test that merely REPORTS', () => {
    // The wrapping form is only a guard while the sweep is INSIDE the branch.
    // After `fi`, an `if [ -n ... ]` that just echoes stops nothing.
    expect(
      findUnguardedSweeps(
        script(['  if [ -n "${LG_PREFIX}" ]; then', '    echo "scope ok"', '  fi'], SWEEP),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a `-z` block that does not leave the function', () => {
    expect(
      findUnguardedSweeps(
        script(['  if [ -z "${LG_PREFIX}" ]; then', '    echo "no scope" >&2', '  fi'], SWEEP),
      ),
    ).toHaveLength(1);
  });

  it('ACCEPTS a guarding arm that contains a one-line nested case', () => {
    // Masking's real job, direction one: without it the INNER `;;` ends the
    // outer guarding arm before the sweep, and correct code is flagged.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    /cdkd-integ/*/) case "${REGION}" in x) ;; y) ;; esac',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '    *) exit 0 ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(0);
  });

  it('ACCEPTS a catch-all that exits after a one-line nested case', () => {
    // Direction two: without masking the `exit 0` lands outside the `*)` arm's
    // body, so a correct REFUSING guard reads as falling through.
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/) ;;',
            '    *) case "${REGION}" in x) ;; esac ; exit 0 ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(0);
  });

  it('REFUSES a `case` using `;&` fall-through', () => {
    // `;&` falls INTO the next arm, so "the sweep is inside a guarding arm" no
    // longer implies the scope matched that arm. Refused rather than modelled.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    *) echo warn >&2 ;&',
          '    /cdkd-integ/*/)',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a sweep inside an arm whose pattern MATCHES the empty string', () => {
    // The inverted guard: it runs the sweep exactly when the scope is empty.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    "")',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES an arm whose pattern is itself an expansion', () => {
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    ${ANY_PATTERN})',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a case whose only arm is the catch-all, even with a paren in its body', () => {
    // The narrow arm-shape regex exists for this: a permissive `[^)]+\)` also
    // matches the `)` inside the refusal branch's own message, which would make
    // a catch-all-only `case` read as guarding.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    *)',
          '      echo "refused (empty scope)" >&2',
          ...SWEEP.map((l) => `    ${l}`),
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a case on a DIFFERENT variable', () => {
    expect(
      findUnguardedSweeps(
        script(
          ['  case "${REGION}" in', '    us-east-1) ;;', '    *) exit 0 ;;', '  esac'],
          SWEEP,
        ),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a guard that appears only AFTER the sweep', () => {
    expect(
      findUnguardedSweeps(
        script(SWEEP, [
          '  case "${LG_PREFIX}" in /cdkd-integ/*/) ;; *) exit 0 ;; esac',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('does not carry a guard across into a LATER function', () => {
    expect(
      findUnguardedSweeps(
        [
          'guarded() {',
          '  case "${LG_PREFIX}" in /cdkd-integ/*/) ;; *) return 0 ;; esac',
          '}',
          'unguarded() {',
          ...SWEEP,
          '}',
        ].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it.each([
    ['|| return', '  [ -n "${LG_PREFIX}" ] || return 1'],
    ['&& return', '  [ -z "${LG_PREFIX}" ] && return 1'],
    ['|| exit', '  [ -n "${LG_PREFIX}" ] || exit 0'],
  ])('accepts a dominating emptiness test: %s', (_label, guard) => {
    expect(findUnguardedSweeps(script([guard], SWEEP))).toHaveLength(0);
  });

  it('accepts the block emptiness form with the sweep AFTER `fi`', () => {
    expect(
      findUnguardedSweeps(
        script(
          ['  if [ -z "${LG_PREFIX}" ]; then', '    echo "no scope" >&2', '    return 1', '  fi'],
          SWEEP,
        ),
      ),
    ).toHaveLength(0);
  });

  it('REFUSES the INVERTED -z branch even when it also returns', () => {
    // Only the POSITION bound separates this from the accepted refusing form:
    // the block tests the same thing and does return, but the sweep runs
    // BEFORE that, exactly when the scope is empty.
    expect(
      findUnguardedSweeps(
        script([
          '  if [ -z "${LG_PREFIX}" ]; then',
          ...SWEEP.map((l) => `  ${l}`),
          '    return 1',
          '  fi',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES the INVERTED emptiness form (sweep INSIDE the -z branch)', () => {
    // This is why the form was withdrawn in an earlier round: without a
    // dominance check it reads as a guard while doing the opposite. The fix is
    // the dominance check, not the withdrawal — `s3-versions.sh` guards its
    // key-scoped entry points with this shape and nothing else.
    expect(
      findUnguardedSweeps(
        script(['  if [ -z "${LG_PREFIX}" ]; then', ...SWEEP.map((l) => `  ${l}`), '  fi']),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES an emptiness test that does not refuse', () => {
    expect(
      findUnguardedSweeps(
        script(['  if [ -z "${LG_PREFIX}" ]; then', '    echo "empty, continuing" >&2', '  fi'], SWEEP),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES an emptiness test on a DIFFERENT variable', () => {
    expect(findUnguardedSweeps(script(['  [ -n "${REGION}" ] || return 1'], SWEEP))).toHaveLength(1);
  });

  it('exposes hasEmptinessGuard directly, both directions', () => {
    const src = ['f() {', '  [ -n "${P}" ] || return 1', '  echo later', '}'];
    expect(hasEmptinessGuard(src, 2, 'P')).toBe(true);
    expect(hasEmptinessGuard(src, 2, 'Q')).toBe(false);
  });

  it('REFUSES a conditional exit in the catch-all', () => {
    // `escapes` was set by the WORD `exit` anywhere in the arm, so a
    // conditional one counted although control reaches the sweep whenever the
    // condition is false.
    expect(
      findUnguardedSweeps(
        script(
          [
            '  case "${LG_PREFIX}" in',
            '    /cdkd-integ/*/) ;;',
            '    *) if [ "${FORCE:-}" = "1" ]; then exit 0; fi ;;',
            '  esac',
          ],
          SWEEP,
        ),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a guarding arm of a NESTED case covering the outer catch-all', () => {
    // An arm's `end` ran past its own `;;` to the next ARM line, and an inner
    // `case`'s lines joined the OUTER arm list — so an inner guarding arm
    // covered a sweep sitting in the outer catch-all, which runs for EVERY
    // value.
    expect(
      findUnguardedSweeps(
        script([
          '  case "${LG_PREFIX}" in',
          '    /cdkd-integ/*/)',
          '      echo ok',
          '      ;;',
          '    *)',
          '      case "${REGION}" in',
          '        us-east-1)',
          ...SWEEP.map((l) => `      ${l}`),
          '          ;;',
          '      esac',
          '      ;;',
          '  esac',
        ]),
      ),
    ).toHaveLength(1);
  });
});

describe('function scope isolation', () => {
  const SWEEP = [
    '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
    '    aws logs delete-log-group --log-group-name "${name}"',
    '  done',
  ];

  it('does not credit a guard across a `) }` function terminator', () => {
    // `functionRanges` ended a range at the next column-0 `}`, so a function
    // closed by `) }` -- the subshell-bodied spelling this tree uses -- ran on
    // into the NEXT function and lent it its guard. Six files have that shape.
    const src = [
      'guarded() { (',
      '  case "${P}" in cdkd/*) ;; *) exit 0 ;; esac',
      '  echo swept',
      ') }',
      'unguarded() {',
      ...SWEEP,
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });

  it('does not swallow FILE-SCOPE code after a trailing `) }` function', () => {
    // The next-opener clamp cannot help here — there is no next opener — so
    // this is the case that makes the `) }` terminator load-bearing. Without
    // it the function's range runs to EOF, the file-scope sweep looks enclosed
    // by it, and the function's own guard is credited to the sweep.
    const src = [
      'guarded() { (',
      '  case "${P}" in cdkd/*) ;; *) exit 0 ;; esac',
      '  echo swept',
      ') }',
      'for name in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
      '  aws logs delete-log-group --log-group-name "${name}"',
      'done',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });

  it('reports a `) }` function as its own range', () => {
    const ranges = functionRanges(uncommented(['a() { (', '  :', ') }', 'b() {', '  :', '}']));
    expect(ranges).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it('clamps a range at the next declaration when the close is unrecognized', () => {
    const ranges = functionRanges(uncommented(['a() {', '  :', 'b() {', '  :', '}']));
    expect(ranges[0]).toEqual({ start: 0, end: 1 });
  });
});

describe('a captured listing that ESCAPES tracking fails closed', () => {
  const wrap = (body: string[]) => ['cleanup() {', '  set +eu', ...body, '}'].join('\n');
  const LISTING = '  names="$(aws logs describe-log-groups --log-group-name-prefix "${P}")"';
  const HELPER = ['del() {', '  aws logs delete-log-group --log-group-name "$1"', '}'];

  it.each([
    ['written to a file', ['  echo "${names}" > /tmp/l', '  xargs -a /tmp/l aws logs delete-log-group']],
    ['re-bound by set --', ['  set -- ${names}', '  aws logs delete-log-group --log-group-name "$1"']],
    ['piped onward', ['  echo "${names}" | xargs aws logs delete-log-group --log-group-name']],
  ])('flags a capture %s', (_label, tail) => {
    expect(findSweeps(wrap([LISTING, ...tail]))).toHaveLength(1);
  });

  it('flags a capture handed to one of the script own functions', () => {
    expect(findSweeps([...HELPER, 'cleanup() {', '  set +eu', LISTING, '  del "${names}"', '}'].join('\n'))).toHaveLength(
      1,
    );
  });

  it('flags a capture that is never used at all', () => {
    expect(
      findSweeps(wrap([LISTING, '  aws logs delete-log-group --log-group-name "/a/literal"'])),
    ).toHaveLength(1);
  });

  it.each([
    ['reports to stderr with >&2', '  echo "leftover: ${names}" >&2'],
    ['discards to /dev/null', '  echo "${names}" > /dev/null'],
    ['uses the || operator', '  [ -z "${names}" ] || echo "still there"'],
  ])('leaves a read-only capture that %s', (_label, use) => {
    // Each of these read as an "escape" in a first cut and flagged every
    // read-only assertion in a function that deletes anything at all.
    expect(
      findSweeps(wrap([LISTING, use, '  aws logs delete-log-group --log-group-name "/a/literal"'])),
    ).toHaveLength(0);
  });

  it('sees a BACKTICK substitution listing', () => {
    // The tree writes `\`${STACK}\`` JMESPath literals, and older shells write
    // the whole substitution in backticks; blanking through it hid the command.
    expect(
      findSweeps(
        wrap([
          '  names=`aws logs describe-log-groups --log-group-name-prefix "${P}"`',
          '  for n in ${names}; do',
          '    aws logs delete-log-group --log-group-name "${n}"',
          '  done',
        ]),
      ),
    ).toHaveLength(1);
  });

  it('does not blank the rest of a line after an escaped quote', () => {
    const [line] = structuralLines(['  x="a\\" ; names="$(aws logs describe-log-groups)"']);
    expect(line).toContain('aws logs describe-log-groups');
  });

  it('leaves a pipe into a READ-ONLY while-read, in a function that deletes', () => {
    // The negative that makes the pipe branch load-bearing: without it the
    // fail-closed widening would flag this.
    expect(
      findSweeps(
        wrap([
          '  aws logs describe-log-groups --log-group-name-prefix "${P}" | while read -r n; do',
          '    echo "found ${n}"',
          '  done',
          '  aws logs delete-log-group --log-group-name "/a/literal"',
        ]),
      ),
    ).toHaveLength(0);
  });
});

describe('delegated and opted-out guards', () => {
  const SWEEP = [
    '  rows="$(aws s3api list-object-versions --bucket b --prefix "${prefix}")"',
    '  for r in ${rows}; do',
    '    aws s3api delete-object --bucket b --key "${r}"',
    '  done',
  ];

  const HELPER = [
    '_check_prefix() {',
    '  case "$1" in',
    '    cdkd/*) ;;',
    '    *) echo "FAIL" >&2; return 1 ;;',
    '  esac',
    '  return 0',
    '}',
  ];

  it('accepts a guard delegated to a helper that can refuse', () => {
    expect(
      findUnguardedSweeps(
        [...HELPER, 'purge() {', '  _check_prefix "${prefix}" || return 1', ...SWEEP, '}'].join(
          '\n',
        ),
      ),
    ).toHaveLength(0);
  });

  it('REFUSES a helper call that cannot refuse', () => {
    const inert = ['_note_prefix() {', '  echo "$1"', '}'];
    expect(
      findUnguardedSweeps(
        [...inert, 'purge() {', '  _note_prefix "${prefix}" || return 1', ...SWEEP, '}'].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('accepts the `if ! helper` spelling', () => {
    expect(
      findUnguardedSweeps(
        [
          ...HELPER,
          'purge() {',
          '  if ! _check_prefix "${prefix}"; then return 1; fi',
          ...SWEEP,
          '}',
        ].join('\n'),
      ),
    ).toHaveLength(0);
  });

  it('a delegated guard does not reach from a function to FILE scope', () => {
    // The enclosing-range bound alone does not cover this: a file-scope sweep
    // takes the whole-file fallback range, so the `sameScope` check is the only
    // thing stopping a guard inside an earlier function from being credited.
    const src = [
      '_check() {',
      '  case "$1" in cdkd/*) ;; *) return 1 ;; esac',
      '  return 0',
      '}',
      'other() {',
      '  _check "${prefix}" || return 1',
      '}',
      'rows="$(aws s3api list-object-versions --bucket b --prefix "${prefix}")"',
      'for r in ${rows}; do',
      '  aws s3api delete-object --bucket b --key "${r}"',
      'done',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });

  it('REFUSES a helper NEUTERED by a leading unconditional return', () => {
    // Measured on the real `s3-versions.sh`: prepending `return 0` to
    // `_s3v_check_prefix` left every check here satisfied, so the archetype's
    // guard could be disarmed without reddening anything.
    const neutered = [
      '_check_prefix() {',
      '  return 0',
      '  case "$1" in cdkd/*) ;; *) return 1 ;; esac',
      '}',
    ];
    expect(
      findUnguardedSweeps(
        [...neutered, 'purge() {', '  _check_prefix "${prefix}" || return 1', ...SWEEP, '}'].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a helper that never BRANCHES on its argument', () => {
    // `note "${P}" || return 1` where `note` only echoes and returns non-zero
    // elsewhere was credited as a guard.
    const echoOnly = ['note() {', '  echo "$1"', '  return 1', '}'];
    expect(
      findUnguardedSweeps(
        [...echoOnly, 'purge() {', '  note "${prefix}" || return 1', ...SWEEP, '}'].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('REFUSES a helper call whose failure is not acted on', () => {
    expect(
      findUnguardedSweeps(
        [...HELPER, 'purge() {', '  _check_prefix "${prefix}"', ...SWEEP, '}'].join('\n'),
      ),
    ).toHaveLength(1);
  });

  it('accepts the escape hatch only with a real reason', () => {
    const withReason = [
      'purge() {',
      '  # allow-unguarded-sweep: scope is validated by the caller, see #1234',
      ...SWEEP,
      '}',
    ].join('\n');
    const bare = ['purge() {', '  # allow-unguarded-sweep: x', ...SWEEP, '}'].join('\n');
    expect(findUnguardedSweeps(withReason)).toHaveLength(0);
    expect(findUnguardedSweeps(bare)).toHaveLength(1);
  });
});

describe('heredoc bodies are data, not code', () => {
  const SWEEP = [
    '  for name in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
    '    aws logs delete-log-group --log-group-name "${name}"',
    '  done',
  ];

  it('does not let a `case` inside a heredoc fabricate a guard', () => {
    // Four fixtures print remediation hints this way. Parsed as code, the
    // template's own `case ... esac` guarded the sweep below it.
    const src = [
      'cleanup() {',
      "  cat <<'EOF' >&2",
      'To clean up by hand:',
      '  case "${P}" in',
      '    /cdkd-integ/*/) ;;',
      '    *) exit 0 ;;',
      '  esac',
      'EOF',
      ...SWEEP,
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });

  it('still sees a REAL guard after a heredoc', () => {
    const src = [
      'cleanup() {',
      "  cat <<'EOF' >&2",
      'some text',
      'EOF',
      '  case "${P}" in /cdkd-integ/*/) ;; *) return 0 ;; esac',
      ...SWEEP,
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(0);
  });

  it('blankHeredocs keeps the line count and the opener', () => {
    const out = blankHeredocs(['cat <<EOF', 'body', 'EOF', 'after']);
    expect(out).toHaveLength(4);
    expect(out[0]).toContain('<<EOF');
    expect(out[1]!.trim()).toBe('');
    expect(out[3]).toBe('after');
  });
});

describe('the remaining accept arms, each with its reject', () => {
  const SWEEP = [
    '  names="$(aws logs describe-log-groups --log-group-name-prefix "${P}")"',
    '  for n in ${names}; do',
    '    aws logs delete-log-group --log-group-name "${n}"',
    '  done',
  ];
  const wrap = (body: string[]) => ['cleanup() {', ...body, '}'].join('\n');

  it('the allow marker must be ADJACENT to the sweep', () => {
    const adjacent = wrap(['  # allow-unguarded-sweep: validated by the caller, see #1234', ...SWEEP]);
    const distant = wrap([
      '  # allow-unguarded-sweep: validated by the caller, see #1234',
      '  echo one',
      '  echo two',
      '  echo three',
      ...SWEEP,
    ]);
    expect(findUnguardedSweeps(adjacent)).toHaveLength(0);
    // A marker anywhere in the function would be a blanket suppressor.
    expect(findUnguardedSweeps(distant)).toHaveLength(1);
  });

  it('a delegated guard does not reach ACROSS scopes', () => {
    const helper = [
      '_check() {',
      '  case "$1" in cdkd/*) ;; *) return 1 ;; esac',
      '  return 0',
      '}',
    ];
    const sameScope = [...helper, 'purge() {', '  _check "${P}" || return 1', ...SWEEP, '}'].join('\n');
    const crossScope = [
      ...helper,
      'other() {',
      '  _check "${P}" || return 1',
      '}',
      'purge() {',
      ...SWEEP,
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(sameScope)).toHaveLength(0);
    expect(findUnguardedSweeps(crossScope)).toHaveLength(1);
  });

  it('`eval` on the captured value is an escape', () => {
    // Read-only twin first, so the flag below is about `eval` and nothing else.
    const readOnly = wrap([
      '  names="$(aws logs describe-log-groups --log-group-name-prefix "${P}")"',
      '  [ -n "${names}" ] || return 0',
      '  aws logs delete-log-group --log-group-name "/a/literal"',
    ]);
    const evaled = wrap([
      '  names="$(aws logs describe-log-groups --log-group-name-prefix "${P}")"',
      '  eval "handle ${names}"',
      '  aws logs delete-log-group --log-group-name "/a/literal"',
    ]);
    expect(findSweeps(readOnly)).toHaveLength(0);
    expect(findSweeps(evaled)).toHaveLength(1);
  });

  it('joins a listing wrapped across continuation lines', () => {
    const wrapped = wrap([
      '  for n in $(aws logs describe-log-groups \\',
      '      --region "${REGION}" \\',
      '      --log-group-name-prefix "${P}" \\',
      "      --query 'logGroups[].logGroupName' \\",
      '      --output text); do',
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
    ]);
    expect(findSweeps(wrapped)).toHaveLength(1);
  });

  it('parses an arm whose body contains a quoted `;;`', () => {
    // Piece boundaries come from the blanked text, so a `;;` inside a message
    // cannot split an arm. There is no fallback branch to fence any more.
    const src = wrap([
      '  case "${P}" in',
      '    /cdkd-integ/*/) ;;',
      '    *) echo "use a;; b" >&2 ; exit 0 ;;',
      '  esac',
      ...SWEEP,
    ]);
    expect(findUnguardedSweeps(src)).toHaveLength(0);
  });
});

describe('control flow that only LOOKS like a refusal', () => {
  const SWEEP = [
    '  for n in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
    '    aws logs delete-log-group --log-group-name "${n}"',
    '  done',
  ];
  const w = (b: string[]) => ['cleanup() {', ...b, '}'].join('\n');
  const arm = (body: string) =>
    w(['  case "${P}" in', '    /cdkd-integ/*/) ;;', `    *) ${body} ;;`, '  esac', ...SWEEP]);

  it.each([
    ['a conditional && exit in an arm', arm('[ -n "${FORCE:-}" ] && exit 0')],
    ['a subshell return in an arm', arm('( echo bad; return 1 )')],
    [
      'a nested conditional return in a -z block',
      w(['  if [ -z "${P}" ]; then if [ "${FORCE:-}" = 1 ]; then return 1; fi; fi', ...SWEEP]),
    ],
    [
      'a subshell return in a -z block',
      w(['  if [ -z "${P}" ]; then ( echo bad; return 1 ); fi', ...SWEEP]),
    ],
    [
      'an inverted -n guard whose ELSE holds the sweep',
      w([
        '  if [ -n "${P}" ]; then',
        '    echo "have a prefix"',
        '  else',
        ...SWEEP.map((l) => `  ${l}`),
        '  fi',
      ]),
    ],
  ])('REFUSES %s', (_label, src) => {
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });

  it.each([
    ['a brace group that exits', arm('{ echo bad; exit 0; }')],
    ['a one-line -z block that returns', w(['  if [ -z "${P}" ]; then echo bad >&2; return 1; fi', ...SWEEP])],
    [
      'a multi-line -z block that returns',
      w(['  if [ -z "${P}" ]; then', '    echo bad >&2', '    return 1', '  fi', ...SWEEP]),
    ],
    ['a `[ ! -z ]` wrapping guard', w(['  if [ ! -z "${P}" ]; then', ...SWEEP.map((l) => `  ${l}`), '  fi'])],
  ])('ACCEPTS %s', (_label, src) => {
    expect(findUnguardedSweeps(src)).toHaveLength(0);
  });
});

describe('a consumer the scan cannot resolve', () => {
  const L = '  NAMES="$(aws logs describe-log-groups --log-group-name-prefix "${P}")"';
  const w = (b: string[]) => ['cleanup() {', ...b, '}'].join('\n');
  const DEL = '  aws logs delete-log-group --log-group-name "/a/literal"';

  it.each([
    ['a helper defined in another file', '  delete_them "${NAMES}"'],
    ['an indirect command', '  "${CMD}" "${NAMES}"'],
    ['bash -c', '  bash -c "handle ${NAMES}"'],
  ])('FAILS CLOSED on %s', (_label, use) => {
    // Leaving `escapes` false here returned a non-destructive window even with
    // a delete on a later line of the SAME function -- a sourced helper doing
    // the delete is this repo's own convention.
    expect(findSweeps(w([L, use, DEL]))).toHaveLength(1);
  });

  it.each([
    ['a test', '  [ -n "${NAMES}" ] || return 0'],
    ['an echo to stderr', '  echo "leftover: ${NAMES}" >&2'],
    ['a continuation flag line', '  aws logs describe-log-streams \\\n    --log-group-name "${NAMES}"'],
  ])('leaves a read-only consumer alone: %s', (_label, use) => {
    expect(findSweeps(w([L, ...use.split('\n'), DEL]))).toHaveLength(0);
  });

});

describe('scope names the scan cannot bind a guard to', () => {
  const sweep = (filter: string) =>
    [
      'f() {',
      `  for n in $(aws s3api list-objects-v2 --bucket b ${filter}); do`,
      '    aws s3api delete-object --bucket b --key "${n}"',
      '  done',
      '}',
    ].join('\n');

  it.each([
    ['$*', '--prefix "$*"'],
    ['$@', '--prefix "$@"'],
  ])('reports %s as unguarded instead of CRASHING', (_label, filter) => {
    // These were interpolated into `new RegExp` unescaped, which threw
    // `SyntaxError: Nothing to repeat` -- an uncaught exception, not a verdict.
    expect(() => findUnguardedSweeps(sweep(filter))).not.toThrow();
    expect(findUnguardedSweeps(sweep(filter))).toHaveLength(1);
  });


  it.each([
    ['${10}', '--prefix "${10}"'],
    ['${1:-}', '--prefix "${1:-}"'],
  ])('still SEES a filter written as %s', (_label, filter) => {
    // The braced positional regex anchored a closing brace, so these yielded
    // zero variables and the filter was dropped entirely -- fail-open.
    expect(findSweeps(sweep(filter))).toHaveLength(1);
  });
});

describe('heredoc openers are read where the shell reads them', () => {
  const SWEEP = [
    '  for n in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
    '    aws logs delete-log-group --log-group-name "${n}"',
    '  done',
  ];

  it('an `echo` MENTIONING a heredoc does not open one', () => {
    const src = [
      'cleanup() {',
      '  echo "to rebuild, use <<EOF in the Dockerfile"',
      ...SWEEP,
      'EOF',
      '}',
    ].join('\n');
    expect(findSweeps(src)).toHaveLength(1);
  });

  it('a QUOTED delimiter still opens one', () => {
    // `<<'EOF'` is the commonest spelling, and the quote pass blanks what is
    // inside the quotes -- so the delimiter has to be read before that.
    const src = [
      'cleanup() {',
      "  cat <<'EOF' >&2",
      '  case "${P}" in',
      '    /cdkd-integ/*/) ;;',
      '    *) exit 0 ;;',
      '  esac',
      'EOF',
      ...SWEEP,
      '}',
    ].join('\n');
    expect(findUnguardedSweeps(src)).toHaveLength(1);
  });
});

describe('the namespace-anchored residual (issue 2682)', () => {
  const files = shellScripts(INTEG_ROOT);

  /**
   * Measured on this branch by `findNamespaceAnchoredSweeps` itself, so the
   * number and the tool cannot disagree. These are NOT failures — guarding them
   * is issue #2682's job — but a checker that reports them CLEAN while the
   * prose calls it a known gap is the worse failure. A 26th unguarded site
   * fails HERE, and has to be either guarded or consciously added to the tally.
   */
  const NAMESPACE_ANCHORED_TOTAL = 26;
  const NAMESPACE_ANCHORED_UNGUARDED = 25;

  it('holds exactly the known namespace-anchored sweeps', () => {
    let total = 0;
    let unguarded = 0;
    for (const f of files) {
      const raw = readFileSync(f, 'utf8');
      const lines = raw.split('\n');
      for (const hit of findNamespaceAnchoredSweeps(raw)) {
        total++;
        const guarded = hit.variables.every(
          (v) =>
            hasScopeGuard(lines, hit.line - 1, v) ||
            hasEmptinessGuard(lines, hit.line - 1, v) ||
            hasDelegatedGuard(lines, hit.line - 1, v),
        );
        if (!guarded) unguarded++;
      }
    }
    // An empty scope leaves `--log-group-name-prefix "/aws/lambda/"`, deleting
    // every Lambda log group in the REGION. See
    // https://github.com/go-to-k/cdkd/issues/2682 before changing these.
    expect(total).toBe(NAMESPACE_ANCHORED_TOTAL);
    expect(unguarded).toBe(NAMESPACE_ANCHORED_UNGUARDED);
  });

  it('recognizes the shape at all (floor)', () => {
    const src = [
      'cleanup() {',
      '  for lg in $(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}"); do',
      '    aws logs delete-log-group --log-group-name "${lg}"',
      '  done',
      '}',
    ].join('\n');
    expect(findNamespaceAnchoredSweeps(src)).toHaveLength(1);
    // ...and it does NOT claim the fully collapsible ones, which are
    // `findUnguardedSweeps`' business.
    expect(findNamespaceAnchoredSweeps(src.replace('/aws/lambda/', ''))).toHaveLength(0);
  });
});

describe('real-code fail probes', () => {
  /**
   * `.claude/rules/testing.md` requires a checker to prove it FAILS against
   * REAL code, not only synthetic fixtures — the two can share a blind spot.
   * Each row mutates a shipped fixture IN MEMORY (no scratch copy, no writes)
   * and asserts the classifier turns red.
   */
  const PROBES = [
    {
      fixture: 'iam-oidc-provider/verify.sh',
      label: 'guarding arm widened to the catch-all',
      mutate: (s: string) => s.replace('    Cdkd?*)', '    *)'),
      expected: 2,
    },
    {
      fixture: 'cc-getatt-readback/verify.sh',
      label: 'guarding arm widened to the catch-all',
      mutate: (s: string) => s.replace('    Cdkd?*)', '    *)'),
      expected: 1,
    },
    {
      fixture: 'loggroup-never-expire-guard/verify.sh',
      label: 'guard block deleted',
      mutate: (s: string) => s.replace(/    case "\$\{LG_PREFIX\}" in[\s\S]*?    esac\n/, ''),
      expected: 1,
    },
    {
      fixture: 'secrets-array-nested/verify.sh',
      label: 'guard block deleted',
      mutate: (s: string) => s.replace(/  case "\$\{FAMILY\}" in[\s\S]*?  esac\n/, ''),
      expected: 1,
    },
    {
      fixture: 's3-versions.sh',
      label: 'the delegated guard call removed',
      mutate: (s: string) => s.replace(/^\s*_s3v_check_prefix "\$\{prefix\}" \|\| return 1\n/gm, ''),
      expected: 2,
    },
  ] as const;

  for (const probe of PROBES) {
    it(`${probe.fixture}: ${probe.label}`, () => {
      const path = join(INTEG_ROOT, probe.fixture);
      const original = readFileSync(path, 'utf8');
      expect(findUnguardedSweeps(original), 'clean before the mutation').toHaveLength(0);
      const mutated = probe.mutate(original);
      // The mutation must have LANDED; a no-op edit would make the assertion
      // below hold vacuously.
      expect(mutated, 'mutation changed nothing').not.toBe(original);
      expect(findUnguardedSweeps(mutated)).toHaveLength(probe.expected);
    });
  }

  it('a heredoc named in a COMMENT does not blind the walk', () => {
    // Openers were matched on RAW text, so the comment "4. Heredocs (`RUN
    // <<EOF`)" opened a fake one and blanked 127 of the file's 153 non-empty
    // lines. Any sweep in that region was invisible while the walk still
    // claimed to cover the file.
    const raw = readFileSync(join(INTEG_ROOT, 'local-invoke-buildkit/verify.sh'), 'utf8').split('\n');
    const sweep = [
      'sweep_probe() {',
      '  for n in $(aws logs describe-log-groups --log-group-name-prefix "${P}"); do',
      '    aws logs delete-log-group --log-group-name "${n}"',
      '  done',
      '}',
    ];
    const late = [...raw.slice(0, 40), ...sweep, ...raw.slice(40)].join('\n');
    expect(findSweeps(late)).toHaveLength(1);
    // ...and a REAL heredoc body is still blanked.
    const globaltable = readFileSync(join(INTEG_ROOT, 'dynamodb-globaltable/verify.sh'), 'utf8');
    const needle = 'path, prefix = sys.argv[1], sys.argv[2]';
    expect(globaltable, 'needle must exist in the raw file').toContain(needle);
    expect(uncommented(globaltable.split('\n')).join('\n')).not.toContain(needle);
  });
});

describe('the integ tree', () => {
  const files = shellScripts(INTEG_ROOT);

  it('walks a plausible population, recursively', () => {
    // Floors against the walk silently collapsing: a wrong root, a predicate
    // matching only `<dir>/verify.sh`, or a non-recursive readdir would each
    // pass every assertion below while examining almost nothing.
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(join(INTEG_ROOT, 's3-versions.sh'));
    expect(files.some((f) => f.endsWith('/verify.sh'))).toBe(true);
    expect(files.some((f) => !f.endsWith('/verify.sh'))).toBe(true);
  });

  it('still RECOGNIZES every known destructive prefix sweep, by COUNT', () => {
    const seen: Record<string, number> = {};
    let total = 0;
    for (const f of files) {
      const n = findSweeps(readFileSync(f, 'utf8')).length;
      if (n === 0) continue;
      total += n;
      const fixture = relative(INTEG_ROOT, f).split('/')[0]!;
      seen[fixture] = (seen[fixture] ?? 0) + n;
    }
    // A presence-only floor was satisfied by a classifier reporting one finding
    // per file; `iam-oidc-provider` has two and the second went missing.
    for (const [fixture, count] of Object.entries(KNOWN_SWEEP_COUNTS)) {
      expect(seen[fixture], `${fixture} sweeps`).toBe(count);
    }
    // `toBe`, not `>=` after the per-fixture loop: as a `>=` this line was a
    // restatement of the map above and setting the constant to 0 changed
    // nothing. As an equality it also catches a sweep appearing in a fixture
    // the map does not mention.
    expect(total).toBe(KNOWN_SWEEP_TOTAL);
    expect(Object.values(KNOWN_SWEEP_COUNTS).reduce((a, b) => a + b, 0)).toBe(KNOWN_SWEEP_TOTAL);
  });

  it('has no unguarded destructive prefix sweep', () => {
    const offenders = files.flatMap((f) =>
      findUnguardedSweeps(readFileSync(f, 'utf8')).map(
        (s) => `${relative(REPO_ROOT, f)}:${s.line}  ${s.filter}`,
      ),
    );
    // An empty/unset scope variable would make each of these delete every
    // matching resource in the ACCOUNT. Add the guard next to the sweep; see
    // docs/integ-fixture-conventions.md.
    expect(offenders).toEqual([]);
  });
});

/**
 * The executable half. Each guarded sweep is run for real against a fake `aws`
 * so the assertion is about behaviour, not source text.
 */
describe('guarded sweeps refuse a widened scope at runtime', () => {
  let sandbox: string;
  let fakeBin: string;
  let argvLog: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'cdkd-sweep-guard-'));
    fakeBin = join(sandbox, 'bin');
    argvLog = join(sandbox, 'aws-argv.txt');
    mkdirSync(fakeBin, { recursive: true });
    // Records its argv, and answers every listing with two names DERIVED FROM
    // THE FILTER the caller passed. Deriving is load-bearing in both
    // directions: a fake that listed nothing would make every "nothing was
    // deleted" assertion hold with the guard removed, and a fake that ignored
    // the filter would hand swept names to loops whose filter keeps a literal
    // anchor and legitimately carries no guard (`cc-getatt-readback`'s
    // `-PipeRole` loop), reporting a leak that real AWS cannot produce. Only
    // prefix semantics are modelled -- enough here, since the needles under
    // test are either empty (matches everything, the hazard) or a fixture's
    // own literal.
    const fake = join(fakeBin, 'aws');
    writeFileSync(
      fake,
      [
        '#!/bin/bash',
        `echo "$*" >> "${argvLog}"`,
        'needle=""',
        'prev=""',
        'for a in "$@"; do',
        '  case "${prev}" in',
        '    --query)',
        `      if [[ "\${a}" =~ (starts_with|contains|ends_with)\\([^,]*,[[:space:]]*[\\'\\"\\\`]([^\\'\\"\\\`]*)[\\'\\"\\\`] ]]; then`,
        '        needle="${BASH_REMATCH[2]}"',
        '      fi',
        '      ;;',
        '    --prefix|*-prefix) needle="${a}" ;;',
        '  esac',
        '  prev="${a}"',
        'done',
        'case "$1 $2" in',
        '  "logs describe-log-groups"|"iam list-roles"|"lambda list-functions"\\',
        '  |"sqs list-queues"|"ecs list-task-definitions"|"s3api list-buckets")',
        '    printf "%s-swept-1\\t%s-swept-2\\n" "${needle}" "${needle}" ;;',
        '  "sts get-caller-identity") echo "123456789012" ;;',
        '  *) echo "" ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    // A no-op `sleep`. Two of these teardowns poll a real resource with
    // `sleep 10` / `sleep 15` between attempts; against a fake `aws` that
    // never converges, the extracted function runs for minutes. Neutralising
    // the wait keeps the probe about the GUARD rather than about polling, and
    // the `timeout` on each spawn below is the backstop.
    const fakeSleep = join(fakeBin, 'sleep');
    writeFileSync(fakeSleep, ['#!/bin/bash', 'exit 0', ''].join('\n'));
    chmodSync(fakeSleep, 0o755);
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  /** Body of a top-level shell function, from `name() {` to the column-0 `}`. */
  function extractFunction(source: string, name: string): string {
    const lines = source.split('\n');
    const start = lines.findIndex((l) => l.startsWith(`${name}() {`));
    expect(start, `${name}() not found`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && (l === '}' || l === ') }'));
    expect(end, `${name}() has no column-0 close`).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join('\n');
  }

  interface RunResult {
    readonly argv: string;
    readonly stderr: string;
  }

  function runSweep(fixture: string, fn: string, assignments: string, args = ''): RunResult {
    if (existsSync(argvLog)) rmSync(argvLog);
    const source = readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8');
    const script = [
      'set -eu',
      // A path that is not executable, so the `[ -x "${LOCAL_DIST}" ]` arm of
      // a fixture's cleanup skips the CLI without needing a build.
      `LOCAL_DIST=${join(sandbox, 'no-such-cli')}`,
      'REGION=us-east-1',
      'ACCOUNT_ID=123456789012',
      assignments,
      extractFunction(source, fn),
      `${fn} ${args}`,
    ].join('\n');
    const res = spawnSync('/bin/bash', ['-c', script], {
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, STATE_BUCKET: '' },
      encoding: 'utf8',
      // A teardown that polls would otherwise hang the suite rather than fail
      // it; a kill leaves the argv log intact, so the assertions still read
      // what the script did before it was stopped.
      timeout: 20_000,
      killSignal: 'SIGKILL',
    });
    return {
      argv: existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '',
      stderr: res.stderr ?? '',
    };
  }

  /**
   * One row per guarded sweep. `listings` and `deletes` are LISTS, because a
   * fixture can carry more than one collapsible sweep in the same function —
   * `iam-oidc-provider` has two, and naming only one let the other run while
   * the refusal assertion stayed true (the surviving `*)` arm still printed
   * `refused`). Every scope variable the sweep reads is widened at once.
   */
  const CASES = [
    {
      fixture: 'loggroup-never-expire-guard',
      fn: 'sweep_log_groups',
      variables: ['LG_PREFIX'],
      listings: ['logs describe-log-groups'],
      deletes: ['delete-log-group'],
      widened: ['', '/', '/other-prefix/', 'cdkd-integ/', '/cdkd-integ/no-trailing-slash'],
    },
    {
      fixture: 'loggroup-class-guard',
      fn: 'sweep_log_groups',
      variables: ['LG_PREFIX'],
      listings: ['logs describe-log-groups'],
      deletes: ['delete-log-group'],
      widened: ['', '/', '/other-prefix/'],
    },
    {
      fixture: 'cc-getatt-readback',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['sqs list-queues'],
      deletes: ['delete-queue'],
      widened: ['', 'Cdkd', 'cdkd-lowercase', 'Other'],
    },
    {
      fixture: 'lambda-snapstart',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      // TWO collapsible sweeps in one function; both must fall silent.
      fixture: 'iam-oidc-provider',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles', 'lambda list-functions'],
      deletes: ['delete-role ', 'delete-function'],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      fixture: 'recreate-via-cc-api',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      fixture: 'recreate-via-sdk-provider',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      fixture: 'recreate-mixed-direction',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      fixture: 'recreate-nested-logical-id-collision',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      fixture: 'cc-protection-flip-eks',
      fn: 'cleanup',
      variables: ['STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      // The guarded value is the LOOP variable, so both stacks it iterates
      // have to be widened for the sweep to be reachable at all.
      fixture: 'cc-api-fallback-transitions',
      fn: 'cleanup',
      variables: ['OVERRIDE_STACK', 'TRANSITION_STACK'],
      listings: ['iam list-roles'],
      deletes: ['delete-role '],
      widened: ['', 'Cdkd', 'Other'],
    },
    {
      // The scope is the function's own first ARGUMENT, so it is widened by
      // passing a different one rather than by assigning a variable.
      fixture: 'eventsourcemapping-race',
      fn: 'list_esms_for_function',
      variables: [],
      argFor: (scope: string) => `"${scope}"`,
      ownArg: '"CdkdEsmRaceExample-fn"',
      listings: ['lambda list-event-source-mappings'],
      deletes: [],
      widened: [''],
      warns: true,
    },
    {
      fixture: 'secrets-array-nested',
      fn: 'deregister_family',
      variables: ['FAMILY'],
      listings: ['ecs list-task-definitions'],
      deletes: ['deregister-task-definition'],
      widened: ['', 'cdkd-test-array-secret-', 'other-family-123'],
    },
  ] as const;

  /**
   * The one recognized subject whose RUNTIME proof lives elsewhere.
   * `tests/unit/scripts/integ-s3-versions-helper.test.ts` already runs every
   * entry point of `s3-versions.sh` against a fake `aws` and asserts a
   * malformed prefix issues NO call — the same property, older and stronger
   * (it covers the count and assert paths too). Duplicating it here would test
   * the sibling suite's subject, not this one. Named with its owner rather than
   * silently absent, because the tree walk merely LISTING the file reads as
   * coverage it does not itself have.
   */
  const RUNTIME_PROOF_ELSEWHERE: Readonly<Record<string, string>> = {
    's3-versions.sh': 'tests/unit/scripts/integ-s3-versions-helper.test.ts',
  };

  it('covers every subject the static half recognizes', () => {
    // Otherwise a guarded sweep could be added with no runtime proof at all,
    // which is the half that catches a guard present but never reached.
    const covered = [
      ...new Set([...CASES.map((c) => c.fixture), ...Object.keys(RUNTIME_PROOF_ELSEWHERE)]),
    ].sort();
    expect(covered).toEqual(Object.keys(KNOWN_SWEEP_COUNTS).sort());
    for (const owner of Object.values(RUNTIME_PROOF_ELSEWHERE)) {
      const path = join(REPO_ROOT, owner);
      expect(existsSync(path), `${owner} must exist`).toBe(true);
      // ...and must still assert the property it is credited with. An
      // `existsSync` alone is satisfied by a gutted file.
      const body = readFileSync(path, 'utf8');
      expect(body, `${owner} must still exercise the purge entry point`).toContain(
        's3_purge_prefix_versions',
      );
      expect(body, `${owner} must still assert no AWS call was made`).toContain('awsCalled');
    }
  });

  /** The literal the fixture assigns to the guarded variable. */
  function ownScope(fixture: string, variable: string): string {
    const source = readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8');
    const m = new RegExp(`^${variable}="([^"]+)"`, 'm').exec(source);
    expect(m, `${fixture}: no literal ${variable}= assignment`).not.toBeNull();
    // A fixture may build its scope from another variable (`...-${ACCOUNT_ID}`);
    // the harness exports the same id the fake `aws` reports.
    return m![1]!.replace(/\$\{ACCOUNT_ID\}/g, '123456789012');
  }

  for (const c of CASES) {
    const argFor = 'argFor' in c ? (c as { argFor: (s: string) => string }).argFor : undefined;
    const ownArg = 'ownArg' in c ? (c as { ownArg: string }).ownArg : '';
    const assign = (value: string) => c.variables.map((v) => `${v}="${value}"`).join('\n');

    describe(`${c.fixture}/${c.fn}`, () => {
      it(
        'POSITIVE CONTROL: its own scope still sweeps',
        () => {
          // Without this every refusal below could hold because the sweep is
          // unreachable rather than because the guard fired.
          const r = runSweep(
            c.fixture,
            c.fn,
            c.variables.map((v) => `${v}="${ownScope(c.fixture, v)}"`).join('\n'),
            ownArg,
          );
          for (const listing of c.listings) expect(r.argv).toContain(listing);
          for (const del of c.deletes) expect(r.argv).toContain(del);
          const scopeVar = c.variables[0];
          if (scopeVar !== undefined && c.deletes.length > 0) {
            // ONE line must carry both the destructive verb and a name the
            // GUARDED listing produced. Asserting them independently over the
            // whole log was satisfied by a delete of an unrelated literal plus
            // the swept name appearing on some other line.
            const needle = `${ownScope(c.fixture, scopeVar)}-swept-1`;
            const hit = r.argv
              .split('\n')
              .some((l) => l.includes(needle) && c.deletes.some((d) => l.includes(d.trim())));
            expect(hit, `no single line carries both a delete and ${needle}`).toBe(true);
          }
        },
        SPAWN_TIMEOUT_MS,
      );

      for (const scope of c.widened) {
        it(
          `refuses ${JSON.stringify(scope)} before issuing the listing`,
          () => {
            const r = runSweep(c.fixture, c.fn, assign(scope), argFor ? argFor(scope) : '');
            for (const listing of c.listings) expect(r.argv).not.toContain(listing);
            // ...and nothing the guarded listing WOULD have produced was
            // deleted. The fake derives its names from the filter, so this
            // needle exists only if that listing ran. Skipped for the EMPTY
            // scope, where the derived name has no distinguishing prefix and
            // would substring-match a sibling loop's own (correctly unguarded,
            // literal-anchored) results.
            if (scope !== '') expect(r.argv).not.toContain(`${scope}-swept-1`);
            if (c.variables.length > 0 || 'warns' in c) {
              expect(r.stderr).toContain('teardown sweep refused');
            }
          },
          SPAWN_TIMEOUT_MS,
        );
      }

      if (c.variables.length > 0) {
        it(
          'refuses an UNSET scope variable',
          () => {
            // The case the `set +eu` in every teardown makes silent. An unset
            // variable expands to empty, so the same caveat as the empty-scope
            // case applies: the per-listing assertion is the check.
            const r = runSweep(
              c.fixture,
              c.fn,
              c.variables.map((v) => `unset ${v} || true`).join('\n'),
            );
            for (const listing of c.listings) expect(r.argv).not.toContain(listing);
            expect(r.stderr).toContain('teardown sweep refused');
          },
          SPAWN_TIMEOUT_MS,
        );
      }
    });
  }
});
