import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';

import {
  createLocalStateProvider,
  isCfnFlagPresent,
  resolveCfnStackName,
  resolveCfnRegion,
  rejectExplicitCfnStackWithMultipleStacks,
  LocalStateSourceError,
  CfnLocalStateProvider,
  type LocalStateSourceOptions,
} from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

const REPO_ROOT_FOR_API_FENCE = joinPath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
);

describe('resolveCfnStackName', () => {
  it('returns the explicit string value when --from-cfn-stack <name> was passed', () => {
    expect(resolveCfnStackName('explicit-cfn-name', 'CdkdStack')).toBe('explicit-cfn-name');
  });

  it('falls back to the cdkd stack name when --from-cfn-stack bare (boolean true) was passed', () => {
    expect(resolveCfnStackName(true, 'CdkdStack')).toBe('CdkdStack');
  });

  it('falls back to the cdkd stack name when fromCfnStack is false (defensive)', () => {
    // Commander never produces `false` from --from-cfn-stack but the helper
    // tolerates it (returns the cdkd name) so a future grammar change
    // doesn't crash.
    expect(resolveCfnStackName(false, 'CdkdStack')).toBe('CdkdStack');
  });
});

describe('resolveCfnRegion', () => {
  const ORIGINAL_AWS_REGION = process.env['AWS_REGION'];
  const ORIGINAL_AWS_DEFAULT_REGION = process.env['AWS_DEFAULT_REGION'];

  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  afterEach(() => {
    if (ORIGINAL_AWS_REGION !== undefined) process.env['AWS_REGION'] = ORIGINAL_AWS_REGION;
    else delete process.env['AWS_REGION'];
    if (ORIGINAL_AWS_DEFAULT_REGION !== undefined)
      process.env['AWS_DEFAULT_REGION'] = ORIGINAL_AWS_DEFAULT_REGION;
    else delete process.env['AWS_DEFAULT_REGION'];
  });

  it('prefers --stack-region above everything', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(
      resolveCfnRegion({ stackRegion: 'eu-west-1', region: 'us-east-1' }, 'synth-region')
    ).toBe('eu-west-1');
  });

  it('falls back to --region when --stack-region is unset', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(resolveCfnRegion({ region: 'us-east-1' }, 'synth-region')).toBe('us-east-1');
  });

  it('falls back to AWS_REGION when --stack-region and --region are unset', () => {
    process.env['AWS_REGION'] = 'env-region';
    expect(resolveCfnRegion({}, 'synth-region')).toBe('env-region');
  });

  it('falls back to AWS_DEFAULT_REGION when --stack-region / --region / AWS_REGION are unset', () => {
    process.env['AWS_DEFAULT_REGION'] = 'default-env-region';
    expect(resolveCfnRegion({}, 'synth-region')).toBe('default-env-region');
  });

  it('falls back to the synth-derived region when nothing else is set', () => {
    expect(resolveCfnRegion({}, 'synth-region')).toBe('synth-region');
  });

  it('throws LocalStateSourceError when no region signal is available at all', () => {
    // The CFn API call needs a concrete region. Silently picking
    // us-east-1 (as `--from-state`'s state-bucket fallback does) would
    // query the wrong stack environment for non-us-east-1 users; worst
    // case it succeeds against a same-named stack in us-east-1 and
    // returns wrong physical IDs. Throw with a clear remediation
    // message instead.
    expect(() => resolveCfnRegion({}, undefined)).toThrow(LocalStateSourceError);
    expect(() => resolveCfnRegion({}, undefined)).toThrow(
      /--from-cfn-stack requires a region/
    );
  });
});

describe('rejectExplicitCfnStackWithMultipleStacks', () => {
  it('throws when explicit --from-cfn-stack <name> + >1 routed stack', () => {
    // local-start-api / local-start-service can route multiple stacks
    // in one invocation. An explicit CFn stack name would apply to
    // every routed stack and silently mismap logical IDs across
    // siblings. Reject at the CLI layer.
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 2)
    ).toThrow(LocalStateSourceError);
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 2)
    ).toThrow(/cannot be used with multiple routed stacks/);
  });

  it('permits explicit --from-cfn-stack <name> with exactly 1 routed stack', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 1)
    ).not.toThrow();
  });

  it('permits explicit --from-cfn-stack <name> with 0 routed stacks (no-op early exit)', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: 'my-cfn-stack' }, 0)
    ).not.toThrow();
  });

  it('permits bare --from-cfn-stack (boolean true) with multiple routed stacks', () => {
    // Bare flag is safe: each routed stack uses its own cdkd stack
    // name as the CFn stack name (the dispatcher's per-stack
    // `resolveCfnStackName(true, stack.stackName)` call returns the
    // routed stack's own name).
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: true }, 5)
    ).not.toThrow();
  });

  it('permits --from-cfn-stack absent (undefined) with multiple routed stacks', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: undefined }, 5)
    ).not.toThrow();
  });

  it('permits --from-cfn-stack false (defensive — commander never emits this) with multi-stack', () => {
    expect(() =>
      rejectExplicitCfnStackWithMultipleStacks({ fromCfnStack: false }, 5)
    ).not.toThrow();
  });
});

describe('createLocalStateProvider — mutual exclusion', () => {
  it('throws LocalStateSourceError when both --from-state and --from-cfn-stack are set', () => {
    const opts: LocalStateSourceOptions = {
      fromState: true,
      fromCfnStack: 'X',
      statePrefix: 'cdkd',
    };
    expect(() => createLocalStateProvider(opts, 'X', 'us-east-1')).toThrow(LocalStateSourceError);
    expect(() => createLocalStateProvider(opts, 'X', 'us-east-1')).toThrow(
      /mutually exclusive/
    );
  });

  it('throws when --from-state + bare --from-cfn-stack (boolean true)', () => {
    const opts: LocalStateSourceOptions = {
      fromState: true,
      fromCfnStack: true,
      statePrefix: 'cdkd',
    };
    expect(() => createLocalStateProvider(opts, 'X', 'us-east-1')).toThrow(LocalStateSourceError);
  });

  it('allows --from-state alone (returns S3LocalStateProvider)', () => {
    const provider = createLocalStateProvider(
      {
        fromState: true,
        statePrefix: 'cdkd',
      },
      'X',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(S3LocalStateProvider);
    provider?.dispose();
  });

  it('allows --from-cfn-stack alone (returns CfnLocalStateProvider)', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        fromCfnStack: 'MyCfnStack',
        statePrefix: 'cdkd',
      },
      'CdkdStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    provider?.dispose();
  });
});

describe('createLocalStateProvider — undefined when no flag is set', () => {
  it('returns undefined when neither flag is set', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        statePrefix: 'cdkd',
      },
      'X',
      'us-east-1'
    );
    expect(provider).toBeUndefined();
  });

  it('returns undefined when fromState=false and fromCfnStack=undefined', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        statePrefix: 'cdkd',
      },
      'X',
      undefined
    );
    expect(provider).toBeUndefined();
  });

  it('returns undefined when fromCfnStack=false (defensive — Commander never emits this)', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        fromCfnStack: false,
        statePrefix: 'cdkd',
      },
      'X',
      undefined
    );
    expect(provider).toBeUndefined();
  });
});

describe('createLocalStateProvider — bare --from-cfn-stack uses cdkd stack name', () => {
  it('bare flag (true) → CfnLocalStateProvider with cfnStackName = cdkd stack name', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        fromCfnStack: true,
        statePrefix: 'cdkd',
      },
      'MyCdkdStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    // We don't have a way to introspect the CFn provider's stack name
    // post-construction without leaking via the test, but the label is
    // observable and confirms the CFn branch fired.
    expect(provider!.label).toBe('--from-cfn-stack');
    provider!.dispose();
  });

  it('explicit string value → CfnLocalStateProvider with the supplied name', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        fromCfnStack: 'explicit-cfn-name',
        statePrefix: 'cdkd',
      },
      'CdkdStack',
      'us-east-1'
    );
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    expect(provider!.label).toBe('--from-cfn-stack');
    provider!.dispose();
  });
});

describe('createLocalStateProvider — labels distinguish source for warn attribution', () => {
  it('--from-state path returns a provider labeled "--from-state"', () => {
    const provider = createLocalStateProvider(
      {
        fromState: true,
        statePrefix: 'cdkd',
      },
      'X',
      'us-east-1'
    );
    expect(provider!.label).toBe('--from-state');
    provider!.dispose();
  });

  it('--from-cfn-stack path returns a provider labeled "--from-cfn-stack"', () => {
    const provider = createLocalStateProvider(
      {
        fromState: false,
        fromCfnStack: 'X',
        statePrefix: 'cdkd',
      },
      'X',
      'us-east-1'
    );
    expect(provider!.label).toBe('--from-cfn-stack');
    provider!.dispose();
  });
});

describe('isCfnFlagPresent helper (Issue #611 NIT 5)', () => {
  it('returns false when fromCfnStack is undefined (flag absent)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: undefined })).toBe(false);
  });

  it('returns true when fromCfnStack === true (bare flag)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: true })).toBe(true);
  });

  it('returns false when fromCfnStack === false (defensive; commander never emits)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: false })).toBe(false);
  });

  it('returns true when fromCfnStack is a string (explicit value)', () => {
    expect(isCfnFlagPresent({ fromCfnStack: 'my-cfn-stack' })).toBe(true);
  });

  it('returns true even when fromCfnStack is the empty string', () => {
    // Empty-string is still "present" — the createLocalStateProvider
    // path rejects it explicitly with a clearer message (NIT 1). The
    // helper itself does not double-validate.
    expect(isCfnFlagPresent({ fromCfnStack: '' })).toBe(true);
  });
});

describe('createLocalStateProvider — empty --from-cfn-stack rejection (Issue #611 NIT 1)', () => {
  it('throws LocalStateSourceError when fromCfnStack is the empty string', () => {
    expect(() =>
      createLocalStateProvider(
        { fromState: false, fromCfnStack: '', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(LocalStateSourceError);
  });

  it('surfaces a remediation message naming the drop-the-value alternative', () => {
    expect(() =>
      createLocalStateProvider(
        { fromState: false, fromCfnStack: '', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(/non-empty stack name/);
    expect(() =>
      createLocalStateProvider(
        { fromState: false, fromCfnStack: '', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(/Drop the value to use the resolved stack name/);
  });

  it('rejects empty string even when --from-state is also set (mutex check fires first)', () => {
    // Mutual exclusion fires before the empty-string check, but the
    // important contract is: both errors are LocalStateSourceError with
    // a clear message. Whichever fires first is fine — the user sees
    // an actionable error either way.
    expect(() =>
      createLocalStateProvider(
        { fromState: true, fromCfnStack: '', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(LocalStateSourceError);
  });
});

/**
 * Issue [#2527](https://github.com/go-to-k/cdkd/issues/2527): cdkd carried an
 * unreferenced FORK of `CfnLocalStateProvider` at
 * `src/local/cfn-local-state-provider.ts`. It was reachable only from its own
 * unit test, and it called `DescribeStackResources` while the provider that
 * actually runs — cdk-local's, re-exported from this module — calls the
 * paginated `ListStackResources`. So a green test suite was pinning the
 * behaviour of code no `cdkd local * --from-cfn-stack` invocation ever entered.
 *
 * The fork is deleted. What is pinned here is the half of the change that could
 * regress silently: the re-export must still resolve (a deleted file plus a
 * mis-edited export line would fail at IMPORT, which is loud — but a re-export
 * quietly re-pointed at a cdkd-local module would not be), and the symbol must
 * come from the DEPENDENCY, which is the property the fork's existence made
 * ambiguous in the first place.
 */
describe('CfnLocalStateProvider comes from cdk-local, not from a cdkd fork (#2527)', () => {
  it('the re-exported class is the same object cdk-local exports', async () => {
    const upstream = await import('cdk-local');
    expect(CfnLocalStateProvider).toBe(upstream.CfnLocalStateProvider);
  });

  it('nothing under src/ imports a local cfn-local-state-provider module any more', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name.endsWith('.ts')) out.push(full);
      }
      return out;
    };
    const sources = walk(join(repoRoot, 'src'));
    // FLOOR first: a walk that returned nothing would satisfy the assertion
    // below without reading a single file.
    expect(sources.length).toBeGreaterThanOrEqual(200);
    const offenders = sources.filter((file) =>
      readFileSync(file, 'utf8').includes('cfn-local-state-provider')
    );
    expect(offenders).toEqual([]);
  });
});

/**
 * The API-NAME half of issue [#2527](https://github.com/go-to-k/cdkd/issues/2527),
 * fenced — the half a mutation probe found unprotected after the first fix round.
 *
 * #2527's headline is that cdkd's deleted fork "names a different CloudFormation
 * API than the provider that actually runs". Deleting the fork does not settle
 * that: the WRONG name had also been copied into the user-facing
 * `--from-cfn-stack` help and JSDoc of every `cdkd local` command that takes the
 * flag — 13 sites, all corrected, none of them pinned. Reverting any one stayed
 * green.
 *
 * The claim: the provider these commands actually route through is cdk-local's
 * `CfnLocalStateProvider`, which calls the PAGINATED `ListStackResources`
 * (`node_modules/cdk-local/dist/local-studio-BBtUAVNy.js`, its only
 * CloudFormation import). `DescribeStackResources` returns at most one page and
 * is a different API with a different failure mode, so naming it sends a user
 * debugging a truncated read to the wrong AWS docs page and the wrong IAM
 * action.
 *
 * The population is derived from the CODE — every `src/**` file that talks about
 * `--from-cfn-stack` — rather than from a path list that would rot. cdkd's OWN
 * `DescribeStackResources` caller (`retire-cfn-stack.ts`, the `cdkd import
 * --migrate-from-cloudformation` path) is correct and falls outside the
 * population on its own, because it never mentions the flag; that is asserted
 * below so the exemption cannot silently widen to cover the local files too.
 */
describe('the local --from-cfn-stack surface names the API that actually runs (#2527)', () => {
  const WRONG_API = 'DescribeStackResources';
  const RIGHT_API = 'ListStackResources';

  const srcFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) out.push(...srcFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  const SRC = joinPath(REPO_ROOT_FOR_API_FENCE, 'src');

  /**
   * Does this file GENUINELY call `DescribeStackResources`, as opposed to
   * naming it in prose?
   *
   * Exported from the closure so the population filter AND the case that
   * fences it call the SAME function. An earlier cut re-implemented the
   * predicate inline in the test, which made the test self-fulfilling:
   * reverting the filter to the prose-blind `text.includes(...)` left it
   * green, so the case named after the fix did not fence the fix.
   *
   * The construction is matched through an OPTIONAL ALIAS
   * (`new DescribeStackResourcesCmd(`): renaming a symbol on import is a style
   * change, and a fence that reddens on it is reporting a defect that is not
   * there. The SDK import is still required, so prose alone cannot satisfy it.
   */
  const reallyCallsDescribeStackResources = (text: string): boolean =>
    new RegExp(String.raw`new\s+\w*${WRONG_API}\w*\(`).test(text) &&
    /from '@aws-sdk\/client-cloudformation'/.test(text);

  const population = srcFiles(SRC).filter((file) => {
    const text = readFileSync(file, 'utf8');
    const talksAboutTheFlag =
      text.includes('fromCfnStack') || text.includes('--from-cfn-stack');
    // EXCLUDE a file that genuinely CALLS `DescribeStackResources`. Today the
    // two sets are disjoint by luck — `retire-cfn-stack.ts` never mentions the
    // flag — and this makes it disjoint by rule instead: the day `import.ts`
    // or `retire-cfn-stack.ts` mentions `--from-cfn-stack` in prose, the fence
    // would otherwise redden on ~15 correct usages.
    //
    // The predicate is a CONSTRUCTION plus the SDK import, not the bare
    // identifier. Keying on the identifier made the opt-out reachable from
    // prose: review measured that writing `reads the deployed stack with a
    // single DescribeStackResourcesCommand call` into `local-start-alb.ts`'s
    // JSDoc removed the file from the population and ran green, so the more
    // specific spelling — the one an API reference actually uses — bought
    // immunity from the fence.
    return talksAboutTheFlag && !reallyCallsDescribeStackResources(text);
  });

  it('finds the --from-cfn-stack surface — floor, so an empty population cannot pass', () => {
    expect(population.length).toBeGreaterThanOrEqual(10);
  });

  /**
   * The files whose user-facing text must NAME the API, pinned as a SET.
   *
   * Purely-negative fences are satisfied by deleting the sentence — the same
   * principle the `--stage` case asserts about its own help string. A `>=`
   * floor is only half a fix: a seventh file naming the API would silently buy
   * slack for a later deletion elsewhere. An exact set fails in both
   * directions, which is the point.
   */
  const MUST_NAME_THE_API = [
    'src/cli/commands/local-invoke-agentcore.ts',
    'src/cli/commands/local-invoke.ts',
    'src/cli/commands/local-run-task.ts',
    'src/cli/commands/local-start-api.ts',
    'src/cli/commands/local-state-source.ts',
    'src/local/local-state-provider.ts',
  ];

  it('the surface POSITIVELY names the API that runs, not merely nothing', () => {
    const naming = population
      .filter((file) => readFileSync(file, 'utf8').includes(RIGHT_API))
      .map((file) => file.slice(REPO_ROOT_FOR_API_FENCE.length + 1))
      .sort();
    expect(
      naming,
      'the set of files naming ListStackResources changed. A file DROPPED it: a fence that only ' +
        'forbids the wrong name is satisfied by deleting the sentence, which leaves the reader no ' +
        'better informed. A file GAINED it, or was renamed: update MUST_NAME_THE_API deliberately.'
    ).toEqual([...MUST_NAME_THE_API].sort());
  });

  it.each(population.map((f) => [f.slice(REPO_ROOT_FOR_API_FENCE.length + 1), f] as const))(
    '%s does not name DescribeStackResources',
    (label, file) => {
      const offending = readFileSync(file, 'utf8')
        .split('\n')
        .map((text, index) => [index + 1, text] as const)
        .filter(([, text]) => text.includes(WRONG_API))
        .map(([line, text]) => `${line}: ${text.trim()}`);
      expect(
        offending,
        `${label} names ${WRONG_API}, but --from-cfn-stack routes through cdk-local's ` +
          `CfnLocalStateProvider, which calls the paginated ${RIGHT_API} (issue #2527).`
      ).toEqual([]);
    }
  );

  it("cdkd's own DescribeStackResources caller is outside the population, on its own", () => {
    // Guard-the-guard. `cdkd import --migrate-from-cloudformation` really does
    // call `DescribeStackResources`, and the fence must not be excusing it by a
    // rule broad enough to excuse the local files as well. It falls out because
    // it never mentions the flag — asserted here, not assumed.
    const retire = joinPath(SRC, 'cli', 'commands', 'retire-cfn-stack.ts');
    expect(reallyCallsDescribeStackResources(readFileSync(retire, 'utf8'))).toBe(true);
    expect(population).not.toContain(retire);
  });

  it('the exclusion cannot be bought by NAMING the API in prose', () => {
    // The measured evasion: a file that merely mentions
    // `DescribeStackResourcesCommand` in a sentence used to drop out of the
    // population and take its wrong claim with it. The exclusion now needs a
    // real construction AND the SDK import, neither of which appears in prose.
    // Every case calls the SAME predicate the population filter uses, so
    // loosening that filter reddens here.
    const proseOnly = [
      "import { CloudFormationClient } from '@aws-sdk/client-cloudformation';",
      ' * reads the deployed stack with a single DescribeStackResourcesCommand call',
    ].join('\n');
    expect(reallyCallsDescribeStackResources(proseOnly)).toBe(false);

    const realCaller = [
      "import { DescribeStackResourcesCommand } from '@aws-sdk/client-cloudformation';",
      'await client.send(new DescribeStackResourcesCommand({ StackName: name }));',
    ].join('\n');
    expect(reallyCallsDescribeStackResources(realCaller)).toBe(true);

    // An ALIASED import is a style change, not a defect — the fence must not
    // redden on it.
    const aliased = [
      "import { DescribeStackResourcesCommand as DescribeStackResourcesCmd } from '@aws-sdk/client-cloudformation';",
      'await client.send(new DescribeStackResourcesCmd({ StackName: name }));',
    ].join('\n');
    expect(reallyCallsDescribeStackResources(aliased)).toBe(true);

    // ...and a construction with NO SDK import is not a caller either, so a
    // same-named local class cannot buy the opt-out.
    const noImport = 'await run(new DescribeStackResourcesCommand({ StackName: name }));';
    expect(reallyCallsDescribeStackResources(noImport)).toBe(false);
  });

  it('the shipped provider really does call ListStackResources', () => {
    // The fence asserts a name; this asserts the name is the RIGHT one, read
    // from the dependency rather than from memory. Without it the fence would
    // happily pin a second wrong name.
    //
    // The chunk filename is CONTENT-HASHED, so it changes on every cdk-local
    // bump. Globbing the dist directory keeps a bump reporting a real
    // disagreement instead of an opaque ENOENT for a path nobody would think
    // to look at.
    const dist = joinPath(REPO_ROOT_FOR_API_FENCE, 'node_modules/cdk-local/dist');
    const chunks = readdirSync(dist).filter((f) => f.endsWith('.js'));
    expect(chunks.length, 'cdk-local/dist has no .js chunks — is it installed?').toBeGreaterThan(0);
    const bundled = chunks.map((f) => readFileSync(joinPath(dist, f), 'utf8')).join('\n');
    expect(bundled).toContain(`${RIGHT_API}Command`);
    expect(bundled).not.toContain(`${WRONG_API}Command`);
  });
});

