import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setStdinIsTty } from '../../stdin-tty.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { CfnStackResourceTree } from '../../../src/cli/commands/retire-cfn-stack.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `cdkd import` slice: a handler that stringified its caught value with
 * `x instanceof Error ? x.message : String(x)` turned a graceful degradation
 * into a hard failure when the value could not be converted --
 * `String(Object.create(null))` throws
 * `TypeError: Cannot convert object to primitive value` from INSIDE the
 * handler.
 *
 * Every case rejects with exactly that value and asserts the DEGRADATION still
 * happens (the import completes and writes state, the per-resource row is
 * produced, the resolution pass carries on, the refusal is the refusal),
 * never merely "it did not throw". The placeholder is asserted too, so a fix
 * that swallowed the failure without reporting it would not pass.
 */

const errorSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => l,
  };
  return { getLogger: () => l };
});

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
  resolveApp: vi.fn(() => 'cdk-out'),
  resolveUseCdkBootstrapAssets: vi.fn(() => false),
}));

vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createAssetRedirectResolver: vi.fn(() => async (): Promise<unknown> => undefined),
}));

const stsSend = vi.hoisted(() => vi.fn(async () => ({ Account: '123456789012' })));
// Every CloudFormation `send` answers "no such stack", so the deployed-parameter
// comparison (issue #2854) takes its cdkd-native path.
const cfnSend = vi.hoisted(() =>
  vi.fn(async (command: { input: { StackName?: string } }) => {
    const err = new Error(`Stack with id ${command.input.StackName ?? ''} does not exist`);
    err.name = 'ValidationError';
    throw err;
  })
);
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    get cloudFormation() {
      return { send: cfnSend };
    },
    get sts() {
      return { send: stsSend };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(() => ({
    sts: { send: stsSend },
    secretsManager: { send: vi.fn(async () => ({ SecretString: 'unused' })) },
    ssm: { send: vi.fn(async () => ({ Parameter: { Value: 'unused' } })) },
  })),
}));

const mockGetCfnResourceTree = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<CfnStackResourceTree>>()
);
vi.mock('../../../src/cli/commands/retire-cfn-stack.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/cli/commands/retire-cfn-stack.js')
  >('../../../src/cli/commands/retire-cfn-stack.js');
  return {
    retireCloudFormationStack: vi.fn(async () => ({ outcome: 'retired' })),
    getCloudFormationResourceTree: mockGetCfnResourceTree,
    tryGetCloudFormationResourceMap: vi.fn(async () => null),
    NESTED_STACK_RESOURCE_TYPE: actual.NESTED_STACK_RESOURCE_TYPE,
  };
});

const mockGetState = vi.fn<(s: string, r: string) => Promise<unknown>>();
const mockSaveState = vi.fn<(...args: unknown[]) => Promise<string>>();
const mockMarkRollbackJournalImported = vi.fn<(...args: unknown[]) => Promise<string[]>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    verifyBucketExists: vi.fn(async () => undefined),
    getState: mockGetState,
    saveState: mockSaveState,
    markRollbackJournalImported: mockMarkRollbackJournalImported,
  })),
}));

const mockAcquireLock = vi.fn<() => Promise<boolean>>();
const mockReleaseLock = vi.fn<(stackName: string, region: string) => Promise<void>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLock: mockAcquireLock,
    getLockInfo: vi.fn(async () => null),
    releaseLock: mockReleaseLock,
  })),
}));

const mockSynthesize = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
  synthesisStatusMessage: (_app: unknown, msg: string) => msg,
}));

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const mockHasProvider = vi.hoisted(() => vi.fn<(t: string) => boolean>());
const mockGetProvider = vi.hoisted(() => vi.fn<(t: string) => unknown>());
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    hasProvider: mockHasProvider,
    getProvider: mockGetProvider,
    getProviderFor: ({ resourceType }: { resourceType: string }) => ({
      provider: mockGetProvider(resourceType),
      provisionedBy: 'sdk',
    }),
  })),
}));

import { createImportCommand, resolveImportedProperties } from '../../../src/cli/commands/import.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { getLogger } from '../../../src/utils/logger.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A rejection whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const lines = (spy: ReturnType<typeof vi.fn>): string[] => spy.mock.calls.map((c) => String(c[0]));

async function runImport(args: string[]): Promise<void> {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const cmd = createImportCommand();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    process.stdout.write = original;
  }
}

function template(resources: CloudFormationTemplate['Resources']): CloudFormationTemplate {
  return { AWSTemplateFormatVersion: '2010-09-09', Resources: resources };
}

function stackInfo(name: string, tmpl: CloudFormationTemplate) {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: tmpl,
    dependencyNames: [],
    region: 'us-east-1',
  };
}

type Saved = [string, string, { resources: Record<string, { physicalId?: string }> }];
const saved = (name: string) =>
  (mockSaveState.mock.calls as unknown as Saved[]).find((c) => c[0] === name)?.[2];

let originalIsTTY: boolean | undefined;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
  vi.clearAllMocks();
  mockGetState.mockReset();
  mockGetState.mockResolvedValue(null);
  mockSaveState.mockReset();
  mockSaveState.mockResolvedValue('"new-etag"');
  mockMarkRollbackJournalImported.mockReset();
  mockMarkRollbackJournalImported.mockResolvedValue([]);
  mockAcquireLock.mockReset();
  mockAcquireLock.mockResolvedValue(true);
  mockReleaseLock.mockReset();
  mockReleaseLock.mockResolvedValue();
  mockSynthesize.mockReset();
  mockHasProvider.mockReset();
  mockGetProvider.mockReset();
  mockGetCfnResourceTree.mockReset();
  mockGetCfnResourceTree.mockResolvedValue({
    stackName: 'S',
    physicalId: 'S',
    resources: new Map(),
    nested: new Map(),
  });
  resetAccountInfoCache();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit-mock');
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  setStdinIsTty(originalIsTTY);
});

describe('cdkd import command handlers (#3361)', () => {
  const twoBuckets = () =>
    template({
      Good: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/Good' } },
      Bad: { Type: 'AWS::S3::Bucket', Properties: {}, Metadata: { 'aws:cdk:path': 'S/Bad' } },
    });

  it('a root releaseLock rejection is warned with the placeholder and the import still writes state', async () => {
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', twoBuckets())] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async (input: { logicalId: string }) => ({
        physicalId: `${input.logicalId}-id`,
        attributes: {},
      })),
    });
    mockReleaseLock.mockRejectedValue(unconvertible());

    await runImport(['--app', 'x', '--yes']);

    expect(Object.keys(saved('S')?.resources ?? {}).sort()).toEqual(['Bad', 'Good']);
    expect(mockReleaseLock).toHaveBeenCalledWith('S', 'us-east-1');
    expect(lines(warnSpy)).toContain(`Failed to release lock: ${PLACEHOLDER}`);
  });

  it('a rollback-journal mark rejection is the "state was NOT written" refusal, carrying the placeholder', async () => {
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', twoBuckets())] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
    });
    mockMarkRollbackJournalImported.mockRejectedValue(unconvertible());

    await expect(runImport(['--app', 'x', '--yes'])).rejects.toThrow('process.exit-mock');

    expect(mockSaveState).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = lines(errorSpy).join('\n');
    expect(errors).toContain('Could not record this import on the rollback journal');
    expect(errors).toContain('state was NOT written');
    expect(errors).toContain(`Cause: ${PLACEHOLDER}`);
    expect(errors).not.toContain('Cannot convert object to primitive value');
    expect(mockReleaseLock).toHaveBeenCalled();
  });

  it('a provider.import rejection becomes a failed row whose reason is the placeholder, and the sibling still imports', async () => {
    mockSynthesize.mockResolvedValue({ stacks: [stackInfo('S', twoBuckets())] });
    mockHasProvider.mockReturnValue(true);
    mockGetProvider.mockReturnValue({
      import: vi.fn(async (input: { logicalId: string }) => {
        if (input.logicalId === 'Bad') throw unconvertible();
        return { physicalId: 'good-id', attributes: {} };
      }),
    });

    await runImport(['--app', 'x', '--yes']);

    expect(Object.keys(saved('S')?.resources ?? {})).toEqual(['Good']);
    expect(lines(errorSpy)).toContain(`Failed to import Bad (AWS::S3::Bucket): ${PLACEHOLDER}`);
    // The row itself: printed by the plan with its reason, and counted as failed.
    const info = lines(infoSpy);
    expect(info.some((l) => l.includes('Bad') && l.endsWith(`— ${PLACEHOLDER}`))).toBe(true);
    expect(info.find((l) => l.startsWith('Summary:'))).toMatch(/1 imported, .* 1 failed/);
  });

  it('a nested child releaseLock rejection is warned with the placeholder and both states are still written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-import-3361-'));
    try {
      const childTemplatePath = join(dir, 'Child.nested.template.json');
      writeFileSync(
        childTemplatePath,
        JSON.stringify({ Resources: { Bucket: { Type: 'AWS::S3::Bucket', Properties: {} } } })
      );
      const tmpl = template({
        Child: { Type: 'AWS::CloudFormation::Stack', Properties: { TemplateURL: 'x' } },
      });
      mockSynthesize.mockResolvedValue({
        stacks: [{ ...stackInfo('P', tmpl), nestedTemplates: { Child: childTemplatePath } }],
      });
      mockHasProvider.mockImplementation((t: string) => t !== 'AWS::CloudFormation::Stack');
      mockGetProvider.mockReturnValue({
        import: vi.fn(async () => ({ physicalId: 'b', attributes: {} })),
      });
      const childArn = 'arn:aws:cloudformation:us-east-1:123:stack/Child/uuid';
      mockGetCfnResourceTree.mockResolvedValue({
        stackName: 'P',
        physicalId: 'P',
        resources: new Map([['Child', childArn]]),
        nested: new Map([
          [
            'Child',
            {
              stackName: childArn,
              physicalId: childArn,
              resources: new Map([['Bucket', 'b']]),
              nested: new Map(),
            },
          ],
        ]),
      });
      mockReleaseLock.mockImplementation(async (stackName: string) => {
        if (stackName === 'P~Child') throw unconvertible();
      });

      await runImport(['P', '--app', 'x', '--yes', '--migrate-from-cloudformation']);

      expect(saved('P~Child')?.resources['Bucket']?.physicalId).toBe('b');
      expect(saved('P')?.resources['Child']).toBeDefined();
      expect(mockReleaseLock).toHaveBeenCalledWith('P~Child', 'us-east-1');
      expect(mockReleaseLock).toHaveBeenCalledWith('P', 'us-east-1');
      expect(lines(warnSpy)).toContain(
        `Failed to release lock for nested stack 'P~Child' (us-east-1): ${PLACEHOLDER}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveImportedProperties preamble and per-resource handlers (#3361)', () => {
  const spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
  });

  function makeState(resources: Record<string, Record<string, unknown>>): StackState {
    return {
      version: STATE_SCHEMA_VERSION_CURRENT,
      stackName: 'outthrow-stack',
      region: 'us-east-1',
      resources: Object.fromEntries(
        Object.entries(resources).map(([id, properties]) => [
          id,
          { physicalId: `${id}-phys`, resourceType: 'AWS::SQS::Queue', properties },
        ])
      ),
      outputs: {},
      lastModified: 0,
    } satisfies StackState;
  }

  const TEMPLATE: CloudFormationTemplate = {
    Parameters: { Stage: { Type: 'String', Default: 'dev' } },
    Resources: {
      Res: { Type: 'AWS::SQS::Queue', Properties: {} },
      Other: { Type: 'AWS::SQS::Queue', Properties: {} },
    },
  };

  const joinAB = { 'Fn::Join': ['-', ['a', 'b']] };

  async function walk(state: StackState): Promise<void> {
    await resolveImportedProperties(
      state,
      TEMPLATE,
      'us-east-1',
      // Consulted only for a cross-stack read, which no fixture here has.
      undefined as never,
      getLogger()
    );
  }

  it('a parameter-resolution rejection is debug-logged with the placeholder and the Default-only retry still binds', async () => {
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolveParameters')
      .mockRejectedValueOnce(unconvertible());
    spies.push(spy);
    const state = makeState({ Res: { QueueName: { 'Fn::Sub': 'app-${Stage}' } } });

    await walk(state);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(state.resources['Res']?.properties).toEqual({ QueueName: 'app-dev' });
    expect(
      lines(debugSpy).some((l) =>
        l.startsWith(
          `Template parameter resolution failed during import-time property resolution: ${PLACEHOLDER} — retrying`
        )
      )
    ).toBe(true);
  });

  it("a 'Default'-only retry rejection is debug-logged with the placeholder and resolution continues without parameters", async () => {
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolveParameters')
      .mockRejectedValue(unconvertible());
    spies.push(spy);
    const state = makeState({ Res: { QueueName: joinAB } });

    await walk(state);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(state.resources['Res']?.properties).toEqual({ QueueName: 'a-b' });
    expect(
      lines(debugSpy).some((l) =>
        l.startsWith(
          `'Default'-only template parameter resolution also failed during import-time property resolution: ${PLACEHOLDER} — continuing`
        )
      )
    ).toBe(true);
  });

  it('a condition-evaluation rejection is debug-logged with the placeholder and resolution continues without conditions', async () => {
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'evaluateConditions')
      .mockRejectedValue(unconvertible());
    spies.push(spy);
    const state = makeState({ Res: { QueueName: joinAB } });

    await walk(state);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(state.resources['Res']?.properties).toEqual({ QueueName: 'a-b' });
    expect(lines(debugSpy)).toContain(
      `Template condition evaluation failed during import-time property resolution: ${PLACEHOLDER} — continuing without conditions.`
    );
  });

  it('an intrinsic-resolution rejection is warned with the placeholder, keeps the raw shape, and the next resource still resolves', async () => {
    const state = makeState({ Res: { QueueName: { 'Fn::Sub': 'raw-${Stage}' } }, Other: { QueueName: joinAB } });
    const failing = state.resources['Res']!.properties;
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(function (this: IntrinsicFunctionResolver, value, context) {
        if (value === failing) return Promise.reject(unconvertible());
        return original.call(this, value, context);
      });
    spies.push(spy);

    await walk(state);

    expect(state.resources['Res']?.properties).toEqual({ QueueName: { 'Fn::Sub': 'raw-${Stage}' } });
    expect(state.resources['Other']?.properties).toEqual({ QueueName: 'a-b' });
    expect(
      lines(warnSpy).some((l) =>
        l.startsWith(
          `Failed to resolve intrinsics in Properties for imported resource Res (AWS::SQS::Queue): ${PLACEHOLDER}.\n`
        )
      )
    ).toBe(true);
  });
});
