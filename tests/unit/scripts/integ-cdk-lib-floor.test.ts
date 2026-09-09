import { describe, it, expect, afterAll } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FLOORS,
  INTEG_ROOT_REL,
  SELF_PROBE_CASES,
  TEMPLATE_REL,
  checkIntegCdkLibFloor,
  compareFloors,
  extractTemplateFloor,
  extractTemplateFloorDetailed,
  parseFloor,
  runSelfProbe,
} from '../../../scripts/check-integ-cdk-lib-floor.js';

/**
 * Enforcement for issue #2839: the `/new-integ` scaffold template's
 * `aws-cdk-lib` floor must not fall behind the integ-fixture corpus. As with
 * `check-verification-depth-rule.ts` and `check-source-control-bytes.ts`, this
 * unit test IS the CI enforcement — there is no `vp run` task and no `ci.yml`
 * step. The script's CLI exists so a human can read the current numbers.
 *
 * See the script header for WHY the rule is "template >= corpus minimum"
 * rather than "all floors equal": dependabot bumps one directory at a time, so
 * an equality fence would red-flag every one of its PRs.
 */

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-integ-cdk-lib-floor.ts');
const REAL_INTEG_ROOT = join(REPO_ROOT, INTEG_ROOT_REL);
const REAL_TEMPLATE = join(REPO_ROOT, TEMPLATE_REL);

/**
 * Every temp dir this file makes, swept in `afterAll`. Each probe copies ~292
 * manifests; without the sweep a run leaves ~21 such trees behind.
 */
const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Run the SHIPPED binary, so `main()`, `parseArgs` and the seam are all live. */
function runCli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // A spawn that never ran reports `status: null`, which satisfies
  // `not.toBe(0)` — a failure indistinguishable from the refusal being tested.
  // Throwing here makes it a loud test error instead.
  if (res.error) throw res.error;
  if (res.status === null) {
    throw new Error(`checker was killed by signal ${String(res.signal)}; stderr: ${res.stderr}`);
  }
  return { status: res.status, stderr: res.stderr ?? '', stdout: res.stdout ?? '' };
}

/**
 * A COPY of the real corpus's manifests — the only files this checker reads.
 * Copying the manifests rather than a synthetic tree keeps the mutation probes
 * real-code probes, and never writes to `tests/integration` itself.
 */
function copyRealManifests(): string {
  const dir = scratch('cdkd-floor-integ-');
  for (const entry of readdirSync(REAL_INTEG_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = join(REAL_INTEG_ROOT, entry.name, 'package.json');
    if (!existsSync(src)) continue;
    mkdirSync(join(dir, entry.name), { recursive: true });
    writeFileSync(join(dir, entry.name, 'package.json'), readFileSync(src, 'utf8'));
  }
  return dir;
}

/** A COPY of the real scaffold template, optionally mutated. */
function copyRealTemplate(mutate?: (text: string) => string): string {
  const dir = scratch('cdkd-floor-tpl-');
  const path = join(dir, 'SKILL.md');
  const text = readFileSync(REAL_TEMPLATE, 'utf8');
  writeFileSync(path, mutate ? mutate(text) : text);
  return path;
}

function setFixtureSpec(integRoot: string, fixture: string, spec: string): void {
  const path = join(integRoot, fixture, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const bucket = manifest.dependencies?.['aws-cdk-lib'] ? 'dependencies' : 'devDependencies';
  const deps = manifest[bucket];
  if (!deps || !deps['aws-cdk-lib']) {
    throw new Error(`${fixture} declares no aws-cdk-lib in ${bucket}; the probe would be vacuous`);
  }
  deps['aws-cdk-lib'] = spec;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('parseFloor / compareFloors', () => {
  it.each(SELF_PROBE_CASES.map((c) => [c.label, c] as const))(
    'self-probe case %s behaves as declared',
    (_label, testCase) => {
      const got = parseFloor(testCase.spec);
      if (testCase.expected === 'refused') {
        expect(got).toBeNull();
        return;
      }
      expect(got).not.toBeNull();
      const [major, minor, patch] = testCase.floor!;
      expect([got!.major, got!.minor, got!.patch]).toEqual([major, minor, patch]);
    },
  );

  // The probe set is the primary defence against a predicate that stopped
  // discriminating, so its SIZE and its negative majority are pinned. A set
  // silently trimmed to its passing cases would leave every other assertion
  // in this file green.
  it('keeps a probe set that is majority-negative', () => {
    expect(SELF_PROBE_CASES.length).toBe(12);
    expect(SELF_PROBE_CASES.filter((c) => c.expected === 'refused').length).toBe(8);
  });

  it('runSelfProbe passes against the shipped classifier', () => {
    expect(runSelfProbe()).toEqual([]);
  });

  it('runSelfProbe honors the force-fail seam', () => {
    const prev = process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
    process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = '1';
    try {
      expect(runSelfProbe()).toEqual([{ label: 'forced', detail: 'CDKD_SELF_PROBE_FORCE_FAIL=1' }]);
    } finally {
      if (prev === undefined) delete process.env['CDKD_SELF_PROBE_FORCE_FAIL'];
      else process.env['CDKD_SELF_PROBE_FORCE_FAIL'] = prev;
    }
  });

  it('orders by the floor, across every segment', () => {
    const f = (s: string) => parseFloor(s)!;
    expect(compareFloors(f('^2.169.0'), f('^2.260.0'))).toBeLessThan(0);
    expect(compareFloors(f('^2.260.0'), f('^2.260.0'))).toBe(0);
    expect(compareFloors(f('^3.0.0'), f('^2.999.999'))).toBeGreaterThan(0);
    expect(compareFloors(f('^2.260.1'), f('^2.260.0'))).toBeGreaterThan(0);
    // The OPERATOR does not change the floor — `~2.260.0` and `^2.260.0` admit
    // the same lowest version, which is the only thing being compared.
    expect(compareFloors(f('~2.260.0'), f('^2.260.0'))).toBe(0);
  });
});

describe('extractTemplateFloor', () => {
  it('reads the floor out of the real scaffold template', () => {
    const floor = extractTemplateFloor(readFileSync(REAL_TEMPLATE, 'utf8'));
    expect(floor).not.toBeNull();
    expect(floor!.operator).toBe('^');
  });

  it('refuses a template with no aws-cdk-lib key', () => {
    expect(extractTemplateFloor('```json\n{ "dependencies": {} }\n```\n')).toBeNull();
  });

  // Two occurrences mean the template grew a second manifest; picking the
  // first would fence whichever happened to come first in the file.
  it('refuses a template declaring the key twice', () => {
    const twice = '"aws-cdk-lib": "^2.260.0"\n...\n"aws-cdk-lib": "^2.169.0"\n';
    expect(extractTemplateFloor(twice)).toBeNull();
  });

  it('refuses a template whose spec has no decidable floor', () => {
    expect(extractTemplateFloor('"aws-cdk-lib": "latest"\n')).toBeNull();
  });

  // One refusal string used to cover all three failures, so "someone added a
  // second example manifest" read as "the key is gone" and pointed the fix at
  // the wrong edit. The counting form is what lets the message discriminate.
  it.each([
    ['none', '```json\n{ "dependencies": {} }\n```\n', 0],
    ['two', '"aws-cdk-lib": "^2.260.0"\n"aws-cdk-lib": "^2.169.0"\n', 2],
    ['one, undecidable', '"aws-cdk-lib": "latest"\n', 1],
  ])('counts the declarations it found: %s', (_label, markdown, expected) => {
    const extraction = extractTemplateFloorDetailed(markdown);
    expect(extraction.matches).toBe(expected);
    expect(extraction.floor).toBeNull();
  });
});

describe('emptiness is a LIBRARY violation, not only a CLI floor', () => {
  it('reports a violation for an existing but empty corpus root', () => {
    const empty = scratch('cdkd-floor-empty-');
    const report = checkIntegCdkLibFloor({ integRoot: empty, templatePath: REAL_TEMPLATE });
    expect(report.fixtures).toBe(0);
    // The regression this pins: it used to return refusals:[] AND violations:[]
    // here, i.e. a fully clean report over a corpus it never read.
    expect(report.violations.join('\n')).toContain('the corpus was not read');
    // ...and it must name the root ACTUALLY checked. A hardcoded
    // `tests/integration` label sent the reader to a directory never read.
    expect(report.violations.join('\n')).toContain(empty);
    expect(report.violations.join('\n')).not.toContain(INTEG_ROOT_REL);
  });

  it('reports a violation when manifests exist but none declares a floor', () => {
    const dir = scratch('cdkd-floor-nodecl-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", "dependencies": {} }');
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    expect(report.fixtures).toBe(1);
    expect(report.declaringFixtures).toBe(0);
    expect(report.violations.join('\n')).toContain('none yielded a decidable aws-cdk-lib floor');
  });

  // The summary INFERS NO CAUSE. Two review rounds went into a conditional
  // trying to say why no floor was found; every version was wrong for some
  // input because it branched on `refusals.length` against `fixtures`, which
  // are different populations (`refusals` also holds the TEMPLATE refusal).
  // These cases pin the replacement: one fact, plus a pointer to the refusals,
  // which are themselves violations.
  it.each([
    ['unparseable manifest', '{ "name": "a", ', 1],
    ['undecidable spec', '{ "dependencies": { "aws-cdk-lib": "*" } }', 1],
    ['no declaration at all', '{ "name": "a", "dependencies": {} }', 0],
  ])('reports the fact without inferring a cause: %s', (_label, body, expectedRefusals) => {
    const dir = scratch('cdkd-floor-nofloor-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), body);
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    expect(report.fixtures).toBe(1);
    expect(report.refusals.length).toBe(expectedRefusals);
    const text = report.violations.join('\n');
    expect(text).toContain('none yielded a decidable aws-cdk-lib floor');
    // The retired wordings, each of which was wrong for one of these three.
    expect(text).not.toContain('none of them readable');
    expect(text).not.toContain('none declaring a decidable');
  });

  // The template is a refusal SOURCE that is not a fixture — the input that
  // made every count-comparing version of this message wrong.
  it('stays correct when the TEMPLATE also refuses', () => {
    const dir = scratch('cdkd-floor-bothrefuse-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", ');
    const report = checkIntegCdkLibFloor({
      integRoot: dir,
      templatePath: join(dir, 'no-such-template.md'),
    });
    expect(report.refusals.length).toBe(2); // one manifest + one template
    expect(report.violations.join('\n')).toContain('none yielded a decidable aws-cdk-lib floor');
  });

  // Every path the checker prints must name the root it ACTUALLY read.
  it('never names the hardcoded corpus path when a seam root was given', () => {
    const dir = scratch('cdkd-floor-pathlabel-');
    mkdirSync(join(dir, 'a'), { recursive: true });
    writeFileSync(join(dir, 'a', 'package.json'), '{ "name": "a", ');
    const report = checkIntegCdkLibFloor({ integRoot: dir, templatePath: REAL_TEMPLATE });
    const text = [...report.violations, ...report.refusals.map((r) => r.where)].join('\n');
    expect(text).toContain(dir);
    expect(text).not.toContain(INTEG_ROOT_REL);
  });
});

describe('the real repository satisfies the fence', () => {
  const report = checkIntegCdkLibFloor({
    integRoot: REAL_INTEG_ROOT,
    templatePath: REAL_TEMPLATE,
  });

  it('reports no refusals and no violations', () => {
    expect(report.refusals).toEqual([]);
    expect(report.violations).toEqual([]);
  });

  // FLOORS pinned to LITERALS. Asserting `report.fixtures > FLOORS.fixtures`
  // instead would be circular — it stays green with every floor zeroed — so
  // the magnitudes below are INDEPENDENT literals, not derived from FLOORS.
  it('pins the declared collapse floors', () => {
    expect(FLOORS.fixtures).toBe(250);
    expect(FLOORS.declaringFixtures).toBe(250);
  });

  it('reads a corpus far larger than the floors (measured 292/292 on 2026-09-09)', () => {
    expect(report.fixtures).toBeGreaterThanOrEqual(280);
    expect(report.declaringFixtures).toBeGreaterThanOrEqual(280);
    // Every fixture carrying a manifest declares aws-cdk-lib; a gap would mean
    // the reader silently stopped seeing one of the two dependency buckets.
    expect(report.declaringFixtures).toBe(report.fixtures);
  });

  it('resolves both sides of the comparison', () => {
    expect(report.minFloor).not.toBeNull();
    expect(report.templateFloor).not.toBeNull();
    expect(compareFloors(report.templateFloor!, report.minFloor!)).toBeGreaterThanOrEqual(0);
  });
});

describe('real-code failure probes (the checker must prove it FAILS)', () => {
  // Each case spawns the built script; per `.claude/rules/testing.md` a
  // subprocess-spawning test declares its own timeout rather than riding the
  // in-process 5 s default.
  const TIMEOUT = 60_000;

  it(
    'control: the unmutated real tree exits 0',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate();
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(0);
      expect(res.stderr).toContain('OK');
    },
    TIMEOUT,
  );

  it(
    'fails when the real template is reverted to the pre-#2838 floor',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate((t) => t.replace(/"aws-cdk-lib": "\^2\.\d+\.\d+"/, '"aws-cdk-lib": "^2.169.0"'));
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('below the lowest floor');
      expect(res.stderr).toContain('^2.169.0');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than passes when the template key cannot be found',
    () => {
      const integRoot = copyRealManifests();
      const template = copyRealTemplate((t) => t.replace('"aws-cdk-lib"', '"aws-cdk-lib-renamed"'));
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('found no `"aws-cdk-lib": "<spec>"` declaration');
    },
    TIMEOUT,
  );

  it(
    'REFUSES a template that grew a SECOND manifest, and says it found two',
    () => {
      const integRoot = copyRealManifests();
      // The realistic future edit: the skill gains a second example block.
      const template = copyRealTemplate((t) => `${t}\n\`\`\`json\n{ "dependencies": { "aws-cdk-lib": "^2.169.0" } }\n\`\`\`\n`);
      const res = runCli([`--integ-root=${integRoot}`, `--template=${template}`]);
      expect(res.status).toBe(1);
      // Naming the COUNT is the point — the old single string sent the reader
      // looking for a missing key instead of a duplicated one.
      expect(res.stderr).toContain('found 2 `"aws-cdk-lib": "<spec>"` declarations');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than skips a fixture manifest that does not parse',
    () => {
      const integRoot = copyRealManifests();
      writeFileSync(join(integRoot, 'basic', 'package.json'), '{ "name": "broken", ');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('manifest does not parse');
    },
    TIMEOUT,
  );

  it(
    'REFUSES rather than skips a spec with no decidable floor',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '*');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('no decidable floor');
    },
    TIMEOUT,
  );

  // The dependabot-safety property, and the reason this is not an equality
  // fence. Both directions of corpus spread must pass.
  it(
    'PASSES when one fixture is bumped ahead of the rest (the dependabot case)',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '^2.999.0');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'PASSES when one fixture lags the template (the deliberate looseness)',
    () => {
      const integRoot = copyRealManifests();
      setFixtureSpec(integRoot, 'basic', '^2.169.0');
      const res = runCli([`--integ-root=${integRoot}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'fails loudly when the corpus root is unreadable',
    () => {
      const res = runCli([
        `--integ-root=${join(tmpdir(), 'cdkd-floor-does-not-exist')}`,
        `--template=${copyRealTemplate()}`,
      ]);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('integ root unreadable');
    },
    TIMEOUT,
  );

  // The floors are only consulted by `main()`, so nothing above would notice
  // them going inert. A corpus of two fixtures is internally consistent and
  // violates no rule — only the floor can reject it.
  it(
    'the collapse floors fire on a corpus that shrank',
    () => {
      const full = copyRealManifests();
      const small = scratch('cdkd-floor-small-');
      for (const fixture of ['basic', 'lambda']) {
        mkdirSync(join(small, fixture), { recursive: true });
        writeFileSync(
          join(small, fixture, 'package.json'),
          readFileSync(join(full, fixture, 'package.json'), 'utf8'),
        );
      }
      const res = runCli([`--integ-root=${small}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(1);
      // BOTH floors, not just the first: pinning only `fixtures` left the
      // `declaringFixtures` block deletable with every test in this file green.
      expect(res.stderr).toContain('fixtures read (floor');
      expect(res.stderr).toContain('declared aws-cdk-lib (floor');
    },
    TIMEOUT,
  );

  it(
    'the SPAWNED binary still consults the self-probe',
    () => {
      const res = runCli([], { CDKD_SELF_PROBE_FORCE_FAIL: '1' });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('SELF-PROBE FAILED');
    },
    TIMEOUT,
  );

  // A per-case needle, not one alternation for all four: with a shared
  // `/unknown argument|requires a non-empty value/`, deleting the
  // `--integ-root=` branch routes it to `unknown argument` and the case still
  // passes — an arm passing on another arm's message.
  it.each([
    ['unknown flag', '--chekc', 'unknown argument: --chekc'],
    ['empty integ-root', '--integ-root=', '--integ-root= requires a non-empty value'],
    ['empty template', '--template=', '--template= requires a non-empty value'],
    ['positional', 'tests/integration', 'unknown argument: tests/integration'],
  ])(
    'refuses the malformed argument: %s',
    (_label, arg, needle) => {
      const res = runCli([arg]);
      // `not.toBe(0)` alone is satisfied by a spawn that never ran; `runCli`
      // now throws on that, and the exact code plus a needle pins the arm.
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(needle);
    },
    TIMEOUT,
  );

  it(
    'under --json, stdout carries only the report',
    () => {
      const res = runCli(['--json', `--integ-root=${copyRealManifests()}`, `--template=${copyRealTemplate()}`]);
      expect(res.status).toBe(0);
      expect(() => JSON.parse(res.stdout)).not.toThrow();
      expect(res.stdout).not.toContain('OK —');
    },
    TIMEOUT,
  );
});
