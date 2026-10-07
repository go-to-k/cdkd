import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * `cdkd state orphan <stack> --resource <logicalId>` (go-to-k/cdkd#4602): the
 * state-driven, single-record drop. One case per branch of
 * `stateOrphanResources` in `src/cli/commands/state.ts`.
 */
import { setStdinIsTty } from '../../stdin-tty.js';

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
  reserveStdoutForPayload: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveStateBucketWithDefaultAndSource: vi.fn(async () => ({ bucket: 'test-bucket' })),
  resolveApp: vi.fn(() => undefined),
}));

const awsClientsCtor = vi.hoisted(() => vi.fn());
const clientInstances = vi.hoisted(() => [] as Array<{ destroy: ReturnType<typeof vi.fn> }>);
const scopedRegions = vi.hoisted(() => [] as Array<string | undefined>);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation((config?: { region?: string }) => {
    awsClientsCtor(config);
    const instance = {
      region: config?.region,
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    };
    clientInstances.push(instance);
    return instance;
  }),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (clients: { region?: string }, fn: () => unknown) => {
    scopedRegions.push(clients.region);
    return fn();
  },
  getAwsClients: vi.fn(),
}));

const mockGetState = vi.hoisted(() => vi.fn());
const mockSaveState = vi.hoisted(() => vi.fn(async () => undefined));
const mockListStacks = vi.hoisted(() => vi.fn());
const mockDeleteState = vi.hoisted(() => vi.fn());
const mockRotateCreateTokenNonce = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    getState: mockGetState,
    saveState: mockSaveState,
    listStacks: mockListStacks,
    deleteState: mockDeleteState,
    verifyBucketExists: vi.fn(async () => undefined),
    rotateCreateTokenNonce: mockRotateCreateTokenNonce,
  })),
}));

const mockAcquireLock = vi.hoisted(() => vi.fn(async () => true));
const mockReleaseLock = vi.hoisted(() => vi.fn(async () => undefined));
const mockForceReleaseLock = vi.hoisted(() => vi.fn(async () => undefined));
const mockIsLocked = vi.hoisted(() => vi.fn(async () => false));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    releaseLock: mockReleaseLock,
    forceReleaseLock: mockForceReleaseLock,
    isLocked: mockIsLocked,
    getLockInfo: vi.fn(async () => null),
  })),
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const mockGetAttribute = vi.hoisted(() => vi.fn(async () => undefined as unknown));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: vi.fn(() => ({ provider: { getAttribute: mockGetAttribute } })),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: readlineQuestion, close: vi.fn() })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return { output, restore: () => (process.stdout.write = original) };
}

async function run(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

/** Every message the command printed through `logger.error` (the thrown text). */
function errors(): string {
  return errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

function baseState(): Record<string, unknown> {
  return {
    version: 10,
    stackName: 'App',
    region: 'us-east-1',
    resources: {
      Gone: {
        physicalId: 'gone-queue-url',
        resourceType: 'AWS::SQS::Queue',
        properties: {},
        attributes: { Arn: 'arn:aws:sqs:us-east-1:123456789012:gone' },
        dependencies: [],
      },
      Keeper: {
        physicalId: 'keeper-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: { Ref: 'Gone' } },
        dependencies: ['Gone'],
      },
      Other: {
        physicalId: 'other-param',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: 'x' },
        dependencies: [],
      },
    },
    outputs: { QueueUrl: { Ref: 'Gone' } },
    lastModified: 1,
  };
}

function resourcesOf(state: Record<string, unknown>): Record<string, unknown> {
  return state['resources'] as Record<string, unknown>;
}

function savedState(): {
  resources: Record<string, { properties: Record<string, unknown>; dependencies: string[] }>;
  outputs: Record<string, unknown>;
} {
  expect(mockSaveState).toHaveBeenCalledTimes(1);
  return (mockSaveState.mock.calls[0] as unknown as unknown[])[2] as ReturnType<typeof savedState>;
}

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  vi.clearAllMocks();
  scopedRegions.length = 0;
  clientInstances.length = 0;
  mockAcquireLock.mockResolvedValue(true);
  mockListStacks.mockResolvedValue([{ stackName: 'App', region: 'us-east-1' }]);
  mockGetState.mockImplementation(async () => ({ state: baseState(), etag: 'etag-1' }));
  mockGetAttribute.mockResolvedValue(undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
  exitSpy.mockRestore();
});

describe('cdkd state orphan --resource', () => {
  it('removes ONLY the named record, rewrites references to it, and leaves the stack record in place', async () => {
    await run(['orphan', 'App', '--resource', 'Gone', '--yes']);

    const saved = savedState();
    expect(Object.keys(saved.resources).sort()).toEqual(['Keeper', 'Other']);
    // The survivor's Ref became the removed record's physical id, and its
    // dependency on it was dropped.
    expect(saved.resources['Keeper']!.properties).toEqual({ Value: 'gone-queue-url' });
    expect(saved.resources['Keeper']!.dependencies).toEqual([]);
    expect(saved.outputs).toEqual({ QueueUrl: 'gone-queue-url' });
    // If-Match save of the same record; the whole-stack delete never runs.
    expect(mockSaveState).toHaveBeenCalledWith('App', 'us-east-1', expect.anything(), {
      expectedEtag: 'etag-1',
    });
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(mockRotateCreateTokenNonce).toHaveBeenCalledWith('App', 'us-east-1', ['Gone']);
    expect(mockAcquireLock).toHaveBeenCalledWith(
      'App',
      'us-east-1',
      expect.any(String),
      'state-orphan'
    );
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Removed 1 resource record\(s\) from state: Gone/)
    );
  });

  it('accepts --resource repeatedly and de-duplicates', async () => {
    await run(['orphan', 'App', '--resource', 'Gone', '--resource', 'Other', '--resource', 'Gone', '-y']);

    expect(Object.keys(savedState().resources)).toEqual(['Keeper']);
    expect(mockRotateCreateTokenNonce).toHaveBeenCalledWith('App', 'us-east-1', ['Gone', 'Other']);
  });

  it('migrates a legacy-keyed record on save, as cdkd orphan does', async () => {
    mockGetState.mockImplementation(async () => ({
      state: baseState(),
      etag: 'etag-1',
      migrationPending: true,
    }));

    await run(['orphan', 'App', '--resource', 'Other', '-y']);

    expect(mockSaveState).toHaveBeenCalledWith('App', 'us-east-1', expect.anything(), {
      expectedEtag: 'etag-1',
      migrateLegacy: true,
    });
  });

  it('refuses more than one stack', async () => {
    await expect(run(['orphan', 'App', 'Other', '--resource', 'Gone', '-y'])).rejects.toThrow();

    expect(errors()).toMatch(/--resource names resources of ONE stack, but 2 stacks were given/);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses an empty --resource value at parse time', async () => {
    await expect(run(['orphan', 'App', '--resource', '', '-y'])).rejects.toThrow(
      /expected a logical id/
    );
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses a stack with records in several regions unless --stack-region picks one', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'App', region: 'us-east-1' },
      { stackName: 'App', region: 'us-west-2' },
    ]);

    await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();

    expect(errors()).toMatch(/has state in multiple regions/);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('operates on the --stack-region record only, with providers scoped to that region', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'App', region: 'us-east-1' },
      { stackName: 'App', region: 'us-west-2' },
    ]);

    await run(['orphan', 'App', '--resource', 'Gone', '--stack-region', 'us-west-2', '-y']);

    expect(mockGetState).toHaveBeenCalledWith('App', 'us-west-2');
    expect(mockSaveState).toHaveBeenCalledWith('App', 'us-west-2', expect.anything(), {
      expectedEtag: 'etag-1',
    });
    expect(awsClientsCtor).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-west-2' }));
    expect(scopedRegions.length).toBeGreaterThan(0);
    expect(new Set(scopedRegions)).toEqual(new Set(['us-west-2']));
  });

  it('refuses a --stack-region the stack has no record in', async () => {
    await expect(
      run(['orphan', 'App', '--resource', 'Gone', '--stack-region', 'eu-west-1', '-y'])
    ).rejects.toThrow();
    expect(errors()).toMatch(/No state found for stack App in region "?eu-west-1"?/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses a stack with no state record', async () => {
    mockListStacks.mockResolvedValue([]);
    await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();
    expect(errors()).toMatch(/No state found for stack App/);
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });

  it('refuses a legacy record listed without a region', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'App' }]);
    await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();
    expect(errors()).toMatch(/legacy state record without a region/);
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('refuses a logical id the record does not hold, naming the available ones, and releases the lock', async () => {
    await expect(run(['orphan', 'App', '--resource', 'Nope', '-y'])).rejects.toThrow();

    expect(errors()).toMatch(/Resource\(s\) not in state for App \(us-east-1\): Nope/);
    expect(errors()).toMatch(/Available logical IDs: Gone, Keeper, Other/);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
  });

  it('does not take the lock from a live holder, even with --force', async () => {
    mockAcquireLock.mockResolvedValue(false);

    await expect(run(['orphan', 'App', '--resource', 'Gone', '--force'])).rejects.toThrow();

    expect(errors()).toMatch(/lock/i);
    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  describe('a reference that cannot be resolved', () => {
    function stateWithGetAtt(): Record<string, unknown> {
      const state = baseState();
      const resources = state['resources'] as Record<string, Record<string, unknown>>;
      resources['Keeper']!['properties'] = { Value: { 'Fn::GetAtt': ['Gone', 'QueueName'] } };
      return state;
    }

    it('aborts without --force and saves nothing', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithGetAtt(), etag: 'e' }));

      await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/Orphan aborted: 1 reference\(s\) could not be resolved/);
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockRotateCreateTokenNonce).not.toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
    });

    it('with --force, saves anyway, leaving the intrinsic in place and warning', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithGetAtt(), etag: 'e' }));

      await run(['orphan', 'App', '--resource', 'Gone', '--force']);

      const saved = savedState();
      expect(saved.resources['Keeper']!.properties).toEqual({
        Value: { 'Fn::GetAtt': ['Gone', 'QueueName'] },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/--force: continuing despite 1 unresolved reference/)
      );
      // --force also skips the prompt.
      expect(readlineQuestion).not.toHaveBeenCalled();
    });

    it('resolves it through the live provider read when that answers', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithGetAtt(), etag: 'e' }));
      mockGetAttribute.mockResolvedValue('gone-queue-name');

      await run(['orphan', 'App', '--resource', 'Gone', '-y']);

      expect(savedState().resources['Keeper']!.properties).toEqual({ Value: 'gone-queue-name' });
    });
  });

  describe('a nested stack record', () => {
    function stateWithNested(): Record<string, unknown> {
      const state = baseState();
      (state['resources'] as Record<string, unknown>)['Child'] = {
        physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/App-Child/x',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        dependencies: [],
      };
      return state;
    }

    // go-to-k/cdkd#4648: the child drop carries the run's account flags.
    it('the child drop carries --profile, the resolved bucket and the prefix (go-to-k/cdkd#4648)', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'us-east-1' },
      ]);
      await expect(
        run([
          'orphan', 'App', '--resource', 'Child', '-y', '--profile', 'prod', '--state-prefix', 'team-a',
        ])
      ).rejects.toThrow();
      expect(errors()).toMatch(
        /Drop the child with: cdkd state orphan 'App~Child' --stack-region us-east-1 --profile prod --state-bucket test-bucket --state-prefix team-a$/m
      );
    });

    it('a refused --profile is a described hole on the child drop (go-to-k/cdkd#4648)', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'us-east-1' },
      ]);
      await expect(
        run(['orphan', 'App', '--resource', 'Child', '-y', '--profile', 'my profile'])
      ).rejects.toThrow();
      expect(errors()).toMatch(/Drop the child with: .* --profile '<profile>' --state-bucket test-bucket$/m);
      expect(errors()).not.toContain('my profile');
      expect(errors()).toContain("The '--profile' value this run was given is not a plain identifier");
    });

    it("refuses while the child's own state record exists, naming the command that drops it", async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'us-east-1' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/Child has a nested stack's state record of its own/);
      expect(errors()).toMatch(
        /Drop the child with: cdkd state orphan 'App~Child' --stack-region us-east-1 --state-bucket test-bucket$/m
      );
      expect(errors()).not.toMatch(/other region/);
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
    });

    it('re-lists under the lock, catching a child created after the first listing', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks
        .mockResolvedValueOnce([{ stackName: 'App', region: 'us-east-1' }])
        .mockResolvedValueOnce([
          { stackName: 'App', region: 'us-east-1' },
          { stackName: 'App~Child', region: 'us-east-1' },
        ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/Child has a nested stack's state record/);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it("refuses a child recorded in ANOTHER region, naming the child's own region", async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'eu-west-1' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(
        /Drop the child with: cdkd state orphan 'App~Child' --stack-region eu-west-1 --state-bucket test-bucket$/m
      );
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('says when the child also has records in other regions', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'eu-west-1' },
        { stackName: 'App~Child', region: 'ap-northeast-1' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/also has records in 1 other region\(s\)/);
      expect(errors()).toMatch(
        /Drop the child with: cdkd state orphan 'App~Child' --stack-region eu-west-1 --state-bucket test-bucket$/m
      );
    });

    it("names the parent's own region first when the child is recorded there too", async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child', region: 'eu-west-1' },
        { stackName: 'App~Child', region: 'us-east-1' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(
        /Drop the child with: cdkd state orphan 'App~Child' --stack-region us-east-1 --state-bucket test-bucket$/m
      );
    });

    it('omits --stack-region for a legacy child record listed with no region', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Child' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Child', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/Drop the child with: cdkd state orphan 'App~Child' --state-bucket test-bucket$/m);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('checks every target for a child record, whatever its recorded type', async () => {
      // `Gone` is recorded as a queue; a torn row's type proves nothing.
      mockListStacks.mockResolvedValue([
        { stackName: 'App', region: 'us-east-1' },
        { stackName: 'App~Gone', region: 'us-east-1' },
      ]);

      await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(/Gone has a nested stack's state record of its own/);
      expect(mockSaveState).not.toHaveBeenCalled();
    });

    it('proceeds once the child has no state record', async () => {
      mockGetState.mockImplementation(async () => ({ state: stateWithNested(), etag: 'e' }));

      await run(['orphan', 'App', '--resource', 'Child', '-y']);

      expect(Object.keys(savedState().resources)).not.toContain('Child');
    });
  });

  describe('the confirmation prompt', () => {
    it('prompts without -y / --force and saves on y', async () => {
      readlineQuestion.mockResolvedValue('y');

      const out = await run(['orphan', 'App', '--resource', 'Gone']);

      expect(out).toMatch(/This removes cdkd's state record of 1 resource\(s\) \[Gone\] from App \(us-east-1\) only/);
      expect(out).toMatch(/The stack's other records are kept/);
      expect(readlineQuestion).toHaveBeenCalledWith(
        expect.stringMatching(/Remove the record\(s\) of Gone from state for App \(us-east-1\)\?/)
      );
      expect(mockSaveState).toHaveBeenCalledTimes(1);
    });

    it('saves nothing when the answer is not y, and still releases the lock', async () => {
      readlineQuestion.mockResolvedValue('n');

      await run(['orphan', 'App', '--resource', 'Gone']);

      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockRotateCreateTokenNonce).not.toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Cancelled removal of resource record\(s\) for stack: App/)
      );
    });

    it('refuses a non-interactive stdin instead of prompting', async () => {
      setStdinIsTty(false);

      await expect(run(['orphan', 'App', '--resource', 'Gone'])).rejects.toThrow();

      expect(readlineQuestion).not.toHaveBeenCalled();
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
      // `--force` also turns on the cached-attribute fallback under --resource,
      // so the refusal points at -y alone.
      expect(errors()).toMatch(/non-interactive environment\. Pass -y \/ --yes to confirm/);
      expect(errors()).not.toMatch(/--force/);
    });
  });

  describe('an unreadable record is refused before any write, and the lock released', () => {
    type Mutate = (state: Record<string, unknown>) => void;
    const resources = (state: Record<string, unknown>): Record<string, Record<string, unknown>> =>
      state['resources'] as Record<string, Record<string, unknown>>;
    const cases: Array<[string, Mutate, RegExp]> = [
      ['the resources bag', (st) => (st['resources'] = 'abc'), /has no readable 'resources' map/],
      ['the outputs bag', (st) => (st['outputs'] = 'abcdef'), /has no readable 'outputs' map/],
      ["a surviving entry", (st) => (resources(st)['Other'] = null as never), /cannot be read as resources — Other —/],
      ["a survivor's properties", (st) => (resources(st)['Other']!['properties'] = 'x'), /whose 'properties' map cannot be read — Other —/],
      ["a survivor's attributes", (st) => (resources(st)['Other']!['attributes'] = 'x'), /whose 'attributes' map cannot be read — Other —/],
      ['the rollback-orphan list', (st) => (st['orphans'] = 'x'), /has no readable 'orphans' list/],
    ];

    it.each(cases)('%s', async (_what, mutate, message) => {
      const state = baseState();
      mutate(state);
      mockGetState.mockImplementation(async () => ({ state, etag: 'e' }));

      await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();

      expect(errors()).toMatch(message);
      expect(errors()).not.toMatch(/Resource\(s\) not in state/);
      expect(mockSaveState).not.toHaveBeenCalled();
      expect(mockRotateCreateTokenNonce).not.toHaveBeenCalled();
      expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
    });

    // The ENTRY-scoped refusals exempt the record being removed: dropping a
    // torn entry is a way out of it, as with `cdkd orphan`.
    it.each([
      ['an unreadable entry', (st: Record<string, unknown>) => (resources(st)['Other'] = null as never)],
      ['unreadable properties', (st: Record<string, unknown>) => (resources(st)['Other']!['properties'] = 'x')],
      ['unreadable attributes', (st: Record<string, unknown>) => (resources(st)['Other']!['attributes'] = 'x')],
    ])('removes the record that has %s', async (_what, mutate) => {
      const state = baseState();
      mutate(state);
      mockGetState.mockImplementation(async () => ({ state, etag: 'e' }));

      await run(['orphan', 'App', '--resource', 'Other', '-y']);

      expect(Object.keys(savedState().resources)).not.toContain('Other');
    });
  });

  it('rotates the create-token nonce BEFORE the save, and saves nothing when it fails', async () => {
    await run(['orphan', 'App', '--resource', 'Gone', '-y']);
    expect(mockRotateCreateTokenNonce.mock.invocationCallOrder[0]!).toBeLessThan(
      mockSaveState.mock.invocationCallOrder[0]!
    );

    vi.clearAllMocks();
    mockRotateCreateTokenNonce.mockRejectedValueOnce(new Error('ledger write denied'));
    await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();
    expect(errors()).toMatch(/ledger write denied/);
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
  });

  it('--force does not splice a cached credential into a survivor, nor print it (go-to-k/cdkd#4602)', async () => {
    const PLAINTEXT = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYSTATETEST';
    mockGetAttribute.mockRejectedValue(new Error('throttled'));
    const state = baseState();
    resourcesOf(state)['Key'] = {
      physicalId: 'AKIA',
      resourceType: 'AWS::IAM::AccessKey',
      properties: {},
      attributes: { SecretAccessKey: PLAINTEXT },
      dependencies: [],
    };
    (resourcesOf(state)['Other'] as Record<string, unknown>)['properties'] = {
      Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
    };
    mockGetState.mockImplementation(async () => ({ state, etag: 'e' }));

    await run(['orphan', 'App', '--resource', 'Key', '--force']);

    expect(savedState().resources['Other']!.properties).toEqual({
      Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
    });
    const printed = [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => String(c[0]))
      .join('\n');
    expect(printed).toContain('a credential-named attribute');
    expect(printed).not.toContain(PLAINTEXT);
  });

  it('releases the lock when the conditional save fails', async () => {
    mockSaveState.mockRejectedValueOnce(new Error('PreconditionFailed'));

    await expect(run(['orphan', 'App', '--resource', 'Gone', '-y'])).rejects.toThrow();

    expect(errors()).toMatch(/PreconditionFailed/);
    expect(mockReleaseLock).toHaveBeenCalledWith('App', 'us-east-1');
  });

  it("reads presence as an OWN key: 'constructor' is not in the record", async () => {
    await expect(run(['orphan', 'App', '--resource', 'constructor', '-y'])).rejects.toThrow();

    expect(errors()).toMatch(/Resource\(s\) not in state for App \(us-east-1\): constructor/);
    expect(mockSaveState).not.toHaveBeenCalled();
  });

  it('warns when the lock release fails, and still disposes every client', async () => {
    mockReleaseLock.mockRejectedValueOnce(new Error('AccessDenied on lock.json'));

    await run(['orphan', 'App', '--resource', 'Gone', '-y']);

    expect(mockSaveState).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to release lock: AccessDenied on lock\.json/)
    );
    // The command's own clients (setup.dispose) and the stack-region ones.
    expect(clientInstances.length).toBeGreaterThanOrEqual(2);
    for (const instance of clientInstances) expect(instance.destroy).toHaveBeenCalled();
  });

  it('disposes every client on a refusal too', async () => {
    await expect(run(['orphan', 'App', '--resource', 'Nope', '-y'])).rejects.toThrow();
    expect(clientInstances.length).toBeGreaterThanOrEqual(1);
    for (const instance of clientInstances) expect(instance.destroy).toHaveBeenCalled();
  });

  it('describes a stack name that is not a plain identifier at the prompt, with the state-list pointer', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'My Stack', region: 'us-east-1' }]);
    readlineQuestion.mockResolvedValue('n');

    const out = await run(['orphan', 'My Stack', '--resource', 'Gone']);

    expect(out).toContain("'cdkd state list --long' shows the records as stored.");
    expect(out).not.toContain('My Stack');
    expect(String(readlineQuestion.mock.calls[0]?.[0])).not.toContain('My Stack');
  });

  it('leaves the whole-stack form unchanged when --resource is absent', async () => {
    await run(['orphan', 'App', '-y']);

    expect(mockDeleteState).toHaveBeenCalledWith('App', 'us-east-1');
    expect(mockSaveState).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });
});
