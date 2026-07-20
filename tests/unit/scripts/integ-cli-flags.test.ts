import { describe, it, expect } from 'vite-plus/test';
import { buildProgram } from '../../../src/cli/program.js';
import {
  collectCommandSpecs,
  extractInvocations,
  findCliVariables,
  joinContinuedLines,
  lintFixtureTree,
  lintScript,
  formatViolation,
} from '../../../scripts/check-integ-cli-flags.js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression guard for the third fixture-quality gap on issue #1097: a
 * `verify.sh` passing a flag the target subcommand does not declare.
 *
 * The originating case: `cdkd import --region` died with
 * `error: unknown option '--region'`, which meant the import round-trip that
 * fixture exists to exercise had never executed once. `--region` IS declared in
 * `src/cli/options.ts` and IS accepted by ~10 sibling commands; `import` is the
 * single one that never attaches it. Only a per-subcommand check catches that.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const specs = collectCommandSpecs(buildProgram());

describe('collectCommandSpecs', () => {
  it('discovers the top-level commands', () => {
    for (const name of ['deploy', 'destroy', 'import', 'export', 'diff', 'drift', 'synth']) {
      expect(specs.has(name), `missing ${name}`).toBe(true);
    }
  });

  it('discovers nested subcommand paths and aliases', () => {
    expect(specs.has('state destroy')).toBe(true);
    expect(specs.has('state list')).toBe(true);
    expect(specs.has('local invoke')).toBe(true);
    // `ls` is an alias of `list`.
    expect(specs.has('ls')).toBe(true);
  });

  it('captures hidden options, which `--help` omits', () => {
    // `--region` is registered as a hidden deprecated option on deploy.
    expect(specs.get('deploy')!.longFlags.has('--region')).toBe(true);
  });

  it('models the exact gap that motivated this lint', () => {
    // The invariant under test: --region is widely declared but NOT on import.
    // If a future PR attaches it to `import`, this expectation flips and the
    // test must be updated deliberately rather than silently.
    expect(specs.get('import')!.longFlags.has('--region')).toBe(false);
    expect(specs.get('deploy')!.longFlags.has('--region')).toBe(true);
    expect(specs.get('destroy')!.longFlags.has('--region')).toBe(true);
  });
});

describe('findCliVariables', () => {
  it.each([
    ['CLI="node ${REPO_ROOT}/dist/cli.js"', 'CLI'],
    ['CDKD="node ../../../dist/cli.js"', 'CDKD'],
    ['LOCAL_DIST="${PWD}/../../../dist/cli.js"', 'LOCAL_DIST'],
  ])('recognizes %s', (assignment, expected) => {
    expect([...findCliVariables(assignment)]).toContain(expected);
  });

  it('ignores unrelated assignments', () => {
    expect([...findCliVariables('STACK="CdkdExample"\nREGION="us-east-1"')]).toEqual([]);
  });
});

describe('joinContinuedLines', () => {
  it('joins backslash continuations and reports the first line number', () => {
    const joined = joinContinuedLines('a\n${CLI} deploy \\\n  --state-bucket b \\\n  --force\nz');
    const inv = joined.find((l) => l.text.includes('deploy'))!;
    expect(inv.line).toBe(2);
    expect(inv.text).toContain('--state-bucket');
    expect(inv.text).toContain('--force');
  });
});

describe('extractInvocations', () => {
  const withCli = (body: string) => `CLI="node ../../../dist/cli.js"\n${body}\n`;

  it('resolves the deepest matching command path', () => {
    const inv = extractInvocations(withCli('${CLI} state destroy MyStack --force'), specs);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.commandPath).toBe('state destroy');
    expect(inv[0]!.longFlags).toEqual(['--force']);
  });

  it('handles a bare `node <path>/cli.js` invocation', () => {
    const inv = extractInvocations('node ../../../dist/cli.js deploy --verbose', specs);
    expect(inv[0]?.commandPath).toBe('deploy');
  });

  it('splits `--flag=value` down to the flag', () => {
    const inv = extractInvocations(withCli('${CLI} deploy --state-bucket=my-bucket'), specs);
    expect(inv[0]!.longFlags).toEqual(['--state-bucket']);
  });

  it('skips flags built from shell variables, which cannot be checked statically', () => {
    const inv = extractInvocations(withCli('${CLI} deploy ${EXTRA_FLAGS} --force'), specs);
    expect(inv[0]!.longFlags).toEqual(['--force']);
  });

  it('finds an invocation inside an if-condition or pipeline', () => {
    expect(extractInvocations(withCli('if ${CLI} diff --fail; then :; fi'), specs)).toHaveLength(1);
    expect(extractInvocations(withCli('${CLI} list --json | jq .'), specs)).toHaveLength(1);
  });

  // Without these, the lint silently skipped the UPDATE-mode deploys -- the
  // exact invocations most worth checking. Found by measuring what the lint
  // saw rather than trusting a green run.
  it.each([
    ['inline env assignment', 'CDKD_TEST_UPDATE=true ${CLI} deploy MyStack --force'],
    ['quoted env assignment', 'FOO="a b" ${CLI} deploy MyStack --force'],
    ['multiple env assignments', 'A=1 B=2 ${CLI} deploy MyStack --force'],
    ['env -u prefix', 'env -u CDKD_TEST_UPDATE ${CLI} deploy MyStack --force'],
    ['env assignment before node form', 'CDKD_TEST_UPDATE=true node ../../../dist/cli.js deploy --force'],
  ])('sees an invocation behind an env prefix: %s', (_label, body) => {
    const inv = extractInvocations(withCli(body), specs);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.commandPath).toBe('deploy');
    expect(inv[0]!.longFlags).toContain('--force');
  });

  it('ignores a non-CLI command that happens to share a subcommand name', () => {
    expect(extractInvocations('aws s3 deploy --region us-east-1', specs)).toEqual([]);
  });
});

describe('lintScript', () => {
  it('flags a flag the subcommand does not declare, naming where it IS declared', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} import MyStack --region us-east-1\n';
    const violations = lintScript('sample', script, specs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.flag).toBe('--region');
    expect(violations[0]!.commandPath).toBe('import');
    expect(violations[0]!.declaredOn).toContain('deploy');
    expect(formatViolation(violations[0]!)).toContain('but NOT on `import`');
  });

  it('accepts the same flag on a subcommand that does declare it', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} deploy MyStack --region us-east-1\n';
    expect(lintScript('sample', script, specs)).toEqual([]);
  });

  it('accepts program-level flags on any subcommand', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} import MyStack --help\n';
    expect(lintScript('sample', script, specs)).toEqual([]);
  });

  it('reports a flag that exists on no subcommand at all', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} deploy --totally-made-up\n';
    const violations = lintScript('sample', script, specs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.declaredOn).toEqual([]);
    expect(formatViolation(violations[0]!)).toContain('not declared on any subcommand');
  });
});

describe('integ fixture CLI invocations (#1097)', () => {
  it('every fixture invocation uses flags its subcommand accepts', () => {
    const violations = lintFixtureTree(INTEG_ROOT, specs);
    const report = violations.map(formatViolation).join('\n\n');
    expect(report).toBe('');
  });

  // A green run above is only meaningful if the extractor actually SEES the
  // invocations. A regex regression that silently stops matching would make
  // the check pass vacuously, which is the failure mode that let the original
  // `import --region` bug ship. These floors turn "sees nothing" into a
  // failure. They are deliberately well under the current numbers (300
  // invocations / 640 flags / 23 command paths) so ordinary fixture churn does
  // not trip them.
  it('parses a substantial share of the fixture tree', () => {
    const fixtures = readdirSync(INTEG_ROOT, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')),
    );
    let invocations = 0;
    let flags = 0;
    const commandPaths = new Set<string>();

    for (const e of fixtures) {
      const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
      for (const inv of extractInvocations(content, specs)) {
        invocations++;
        flags += inv.longFlags.length;
        commandPaths.add(inv.commandPath);
      }
    }

    expect(fixtures.length).toBeGreaterThan(150);
    expect(invocations).toBeGreaterThan(250);
    expect(flags).toBeGreaterThan(550);
    expect(commandPaths.size).toBeGreaterThan(15);
    // The highest-traffic commands must always be represented.
    for (const cmd of ['deploy', 'destroy', 'synth']) {
      expect(commandPaths.has(cmd), `no ${cmd} invocation parsed`).toBe(true);
    }
  });
});
