import { describe, it, expect } from 'vite-plus/test';
import { buildProgram } from '../../../src/cli/program.js';
import {
  collectCommandSpecs,
  extractInvocations,
  findCliVariables,
  joinContinuedLines,
  lintFixtureTree,
  lintScript,
  acceptedFlagsFor,
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

  // Missing an assignment silently mutes EVERY invocation in that fixture, and
  // the file then contributes nothing to the coverage floors either -- a false
  // negative that hides itself twice over.
  it.each([
    ['export prefix', 'export CLI="node ../../dist/cli.js"'],
    ['readonly prefix', 'readonly CLI="node ../../dist/cli.js"'],
    ['local prefix', 'local CLI="node ../../dist/cli.js"'],
    ['trailing comment', 'CLI="node ../../dist/cli.js" # the built binary'],
    ['command substitution', 'CLI="node $(dirname "$0")/../../dist/cli.js"'],
  ])('recognizes the %s form', (_label, assignment) => {
    expect([...findCliVariables(assignment)]).toContain('CLI');
  });

  it('skips a version-pinned published binary', () => {
    // The schema-migration fixtures install an OLD `@go-to-k/cdkd` to prove the
    // state round-trip. Its flags belong to that version's option set, so
    // judging them against today's tree would report a false violation the
    // moment this repo deprecates a flag.
    const pinned = 'V5_BIN="${V5_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"';
    expect([...findCliVariables(pinned)]).toEqual([]);
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

  // A chained line used to collapse into ONE invocation, so the second
  // command's flags were judged against the first. With `deploy && import`
  // that hid the very bug this lint exists to catch, because `deploy` accepts
  // `--region` and `import` does not.
  it('parses each command of a chained line separately', () => {
    const inv = extractInvocations(
      withCli('${CLI} deploy S && ${CLI} import S --region us-east-1'),
      specs,
    );
    expect(inv).toHaveLength(2);
    expect(inv[0]!.commandPath).toBe('deploy');
    expect(inv[0]!.longFlags).toEqual([]);
    expect(inv[1]!.commandPath).toBe('import');
    expect(inv[1]!.longFlags).toEqual(['--region']);
  });

  it.each([
    ['&&', '${CLI} deploy S --yes && ${CLI} destroy S --force'],
    ['||', '${CLI} deploy S --yes || ${CLI} destroy S --force'],
    [';', '${CLI} deploy S --yes; ${CLI} destroy S --force'],
  ])('attributes flags to the right command across `%s`', (_op, body) => {
    const inv = extractInvocations(withCli(body), specs);
    expect(inv.map((i) => [i.commandPath, i.longFlags])).toEqual([
      ['deploy', ['--yes']],
      ['destroy', ['--force']],
    ]);
  });

  it('does not split on an operator inside quotes', () => {
    const inv = extractInvocations(withCli('${CLI} deploy S -c "a&&b" --force'), specs);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.longFlags).toEqual(['--force']);
  });

  // A bare `&` separates commands, but `2>&1` is a redirect. Splitting there
  // truncated the segment and silently dropped every flag after it -- the
  // under-detection direction.
  it('does not split a `2>&1` redirect', () => {
    const inv = extractInvocations(withCli('${CLI} deploy S 2>&1 --bogus-flag'), specs);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.longFlags).toEqual(['--bogus-flag']);
  });

  it('still splits a real background `&`', () => {
    const inv = extractInvocations(withCli('${CLI} deploy S --force & ${CLI} synth --json'), specs);
    expect(inv.map((i) => i.commandPath)).toEqual(['deploy', 'synth']);
  });

  it('does not lose flags after an escaped quote inside a quoted argument', () => {
    const inv = extractInvocations(withCli('${CLI} deploy S -c "a\\"b&&c" --force'), specs);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.longFlags).toEqual(['--force']);
  });

  it('keeps flags that follow a quoted `#`', () => {
    // A naive `/\s#.*$/` strip discarded everything after the quoted hash,
    // reporting zero flags for the line.
    const inv = extractInvocations(withCli('${CLI} import S -c "a #b" --region us-east-1'), specs);
    expect(inv[0]!.longFlags).toEqual(['--region']);
  });

  it('still strips a real trailing comment', () => {
    const inv = extractInvocations(withCli('${CLI} deploy S --force # --region here'), specs);
    expect(inv[0]!.longFlags).toEqual(['--force']);
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

  // Commander lets a subcommand accept options declared on an ANCESTOR, not
  // just its own and the program's. Checking own+program only produced false
  // positives on all five `events prune` call sites. Verified on the built
  // binary: `events prune --state-bucket` is accepted (it fails later, on
  // bucket access), while `--bogus-flag` is still rejected.
  it('accepts a flag declared on a parent command', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} events prune S --all --state-bucket b\n';
    expect(lintScript('sample', script, specs)).toEqual([]);
  });

  it('still rejects a flag no ancestor declares', () => {
    const script = 'CLI="node ../../../dist/cli.js"\n${CLI} events prune S --bogus-flag\n';
    expect(lintScript('sample', script, specs)).toHaveLength(1);
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
  // failure. They sit under the current numbers (829 invocations / 2164 flags
  // / 25 command paths) with enough slack for ordinary fixture churn.
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
    expect(invocations).toBeGreaterThan(700);
    expect(flags).toBeGreaterThan(1800);
    expect(commandPaths.size).toBeGreaterThan(20);
    // The highest-traffic commands must always be represented.
    for (const cmd of ['deploy', 'destroy', 'synth']) {
      expect(commandPaths.has(cmd), `no ${cmd} invocation parsed`).toBe(true);
    }
  });

  // Aggregate floors have ~20% headroom, so a regression that kills ONE
  // invocation shape stays well under them and passes. That is not
  // hypothetical: the env-prefix branch was silently dropping every
  // UPDATE-mode deploy (46 invocations) while the suite was green. So assert
  // each shape the extractor claims to handle is actually exercised by the
  // real tree.
  it('parses every invocation shape it claims to support', () => {
    // Only shapes the real tree actually contains. `node <literal>/cli.js` is
    // supported by the extractor (see the unit test above) but never appears
    // as an invocation here -- every `node ../../../dist/cli.js` occurrence in
    // the tree is inside a variable ASSIGNMENT, not a call site.
    // Anchored at the start of the invocation, so an argument that merely
    // LOOKS like a prefix (an uppercase `KEY=VALUE` passed as a flag value)
    // cannot stand in for the shape. Unanchored, `env prefix` matched 267
    // invocations against 257 genuinely env-prefixed ones -- enough slack that
    // a total regression of the env branch would still have satisfied
    // `toBeGreaterThan(0)`.
    const ENV = String.raw`(?:[A-Z_][A-Z0-9_]*=\S*\s+|env\s+-[iu]\S*\s+\S+\s+)*`;
    const shapes: Record<string, RegExp> = {
      // `node "${LOCAL_DIST}" deploy ...` -- how most fixtures invoke the CLI.
      'node + variable path': new RegExp(String.raw`^\s*${ENV}node\s+"?\$\{?[A-Za-z_]+\}?"?\s`),
      // `${CDKD} deploy ...`
      'bare variable': new RegExp(String.raw`^\s*${ENV}"?\$\{?[A-Za-z_]+\}?"?\s`),
      // `CDKD_TEST_UPDATE=true ...` / `env -u FOO ...`
      'env prefix': new RegExp(String.raw`^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+|env\s+-[iu])`),
    };
    const seen = new Map<string, number>(Object.keys(shapes).map((k) => [k, 0]));

    for (const e of readdirSync(INTEG_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(INTEG_ROOT, e.name, 'verify.sh'))) continue;
      const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
      for (const inv of extractInvocations(content, specs)) {
        for (const [name, re] of Object.entries(shapes)) {
          if (re.test(inv.raw)) seen.set(name, seen.get(name)! + 1);
        }
      }
    }

    // Real floors, not `> 0`. A shape can regress PARTIALLY (e.g. only the
    // `env -u` form stops matching) and a zero-check would not notice.
    // Current: node+var 535, bare var 294, env prefix 257.
    const floors: Record<string, number> = {
      // The shape whose silent loss this assertion exists to prevent:
      // requiring a literal `cli.js` in the token made 135 of the 195 fixtures
      // contribute ZERO invocations while the suite stayed green.
      'node + variable path': 400,
      'bare variable': 200,
      'env prefix': 180,
    };
    for (const [name, floor] of Object.entries(floors)) {
      expect(seen.get(name), `too few invocations parsed for shape: ${name}`).toBeGreaterThan(
        floor,
      );
    }
  });
});
