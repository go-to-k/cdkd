import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';

import {
  createLocalStateProvider,
  isCfnFlagPresent,
  resolveCfnStackName,
  resolveCfnRegion,
  rejectExplicitCfnStackWithMultipleStacks,
  LocalStateSourceError,
  type LocalStateSourceOptions,
} from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';
import { CfnLocalStateProvider } from '../../../src/local/cfn-local-state-provider.js';

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
    ).toThrow(/Drop the value to use the cdkd stack name/);
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
