/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/cli/commands/scrub.ts` slice: a handler that stringified its caught
 * value with a bare `String()` threw from inside itself when the value could
 * not be converted -- `String(Object.create(null))` throws `TypeError: Cannot
 * convert object to primitive value`. In a handler that logs and carries on,
 * that turned the degradation into a hard failure; in one that builds a
 * refusal, it replaced the refusal (its code and its remedy) with the
 * converter's `TypeError`.
 *
 * Every case rejects with exactly that value and asserts what the handler is
 * FOR still happens (the call resolves, the next stack is still scrubbed, the
 * refusal carries its own code), never merely "it did not throw". The
 * placeholder is asserted too, so a fix that swallowed the failure without
 * reporting it would not pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...log, child: () => log }),
}));

/** A rejection whose `String()` throws. */
const unconvertible = vi.hoisted(() => (): unknown => Object.create(null) as unknown);

/**
 * The resolver double. Every knob is OFF by default, so the resolver records
 * the one secret below and otherwise returns its input.
 */
const rx = vi.hoisted(() => ({
  /** `resolve` rejects for any value whose JSON contains this marker. */
  rejectMarker: undefined as string | undefined,
  /** `resolve` of a lone `Fn::ImportValue` node records a read of `Producer`. */
  recordImport: false,
  rejectParameters: false,
  rejectConditions: false,
  rejectDynamicReferences: false,
  conditions: {} as Record<string, boolean>,
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  // The non-class exports must survive the double: `scrub.ts` imports pure
  // helpers from this module (`carriesDynamicReference`, ...).
  ...(await importOriginal<typeof import('../../../../src/deployment/intrinsic-function-resolver.js')>()),
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    resolveParameters: vi.fn().mockImplementation(() =>
      rx.rejectParameters ? Promise.reject(unconvertible()) : Promise.resolve({})
    ),
    evaluateConditions: vi.fn().mockImplementation(() =>
      rx.rejectConditions ? Promise.reject(unconvertible()) : Promise.resolve(rx.conditions)
    ),
    resolveDynamicReferences: vi.fn().mockImplementation((token: string) =>
      rx.rejectDynamicReferences ? Promise.reject(unconvertible()) : Promise.resolve(token)
    ),
    resolve: vi
      .fn()
      .mockImplementation(
        (
          value: unknown,
          ctx: {
            recordedSecretValues?: Map<string, string>;
            recordedImports?: Array<{ sourceStack: string; sourceRegion: string; exportName: string }>;
          }
        ) => {
          if (rx.rejectMarker !== undefined && JSON.stringify(value ?? null).includes(rx.rejectMarker)) {
            return Promise.reject(unconvertible());
          }
          const node = value as Record<string, unknown> | null;
          if (
            rx.recordImport &&
            node &&
            typeof node === 'object' &&
            Object.keys(node).length === 1 &&
            'Fn::ImportValue' in node
          ) {
            ctx.recordedImports?.push({
              sourceStack: 'Producer',
              sourceRegion: 'us-east-1',
              exportName: 'ProducerExport',
            });
            return Promise.resolve('resolved-cross-stack-value');
          }
          const walk = (v: unknown): unknown => {
            if (v === SECRET_EXPR) {
              ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
              return SECRET_PLAINTEXT;
            }
            if (Array.isArray(v)) return v.map(walk);
            if (v && typeof v === 'object') {
              const out: Record<string, unknown> = {};
              for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
              return out;
            }
            return v;
          };
          return Promise.resolve(walk(value));
        }
      ),
  })),
}));

// --- scrubCommand's collaborators (the per-stack boundary cases) ---

const synthStacks = vi.hoisted(() => [] as unknown[]);
const commandStateBackend = vi.hoisted(() => ({
  prefix: 'cdkd',
  getState: vi.fn(),
  saveState: vi.fn(),
  purgeNoncurrentVersions: vi.fn(),
  listStacks: vi.fn(),
}));
const indexStore = vi.hoisted(() => ({
  readPersistedEntries: vi.fn(),
  patchEntry: vi.fn(),
}));
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {} })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => commandStateBackend),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => indexStore),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));

import {
  scrubCommand,
  scrubStack,
  type ScrubOptions,
} from '../../../../src/cli/commands/scrub.js';

/** What `describeAwsFailure(x).detail` / `safeStringify(x)` render for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

const lines = (spy: ReturnType<typeof vi.fn>): string[] =>
  spy.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : '')).join(' '));
const linesWith = (spy: ReturnType<typeof vi.fn>, needle: string): string[] =>
  lines(spy).filter((l) => l.includes(needle));

function stackInfo(
  template: CloudFormationTemplate,
  stackName = 'MyStack'
): {
  stackName: string;
  displayName: string;
  artifactId: string;
  template: CloudFormationTemplate;
  dependencyNames: string[];
} {
  return { stackName, displayName: stackName, artifactId: stackName, dependencyNames: [], template };
}

/** One leaked secret in a resource, so a scrub that runs to the end REWRITES. */
const LEAKY_RESOURCE = {
  Fn: {
    Type: 'AWS::Lambda::Function',
    Properties: { Environment: { Variables: { SECRET: SECRET_EXPR } } },
  },
};

/**
 * The same resource with one more top-level property. Scrub resolves per
 * top-level property and walks only resources the STATE record holds, so a
 * sibling property is how a failing value reaches the loop without taking the
 * leaked secret down with it.
 */
const leakyResourceWith = (extra: Record<string, unknown>): CloudFormationTemplate['Resources'] => ({
  Fn: {
    Type: 'AWS::Lambda::Function',
    Properties: { Environment: { Variables: { SECRET: SECRET_EXPR } }, ...extra },
  },
});

function leakyState(extra: Partial<StackState> = {}, stackName = 'MyStack'): StackState {
  return {
    version: 8,
    region: 'us-east-1',
    stackName,
    resources: {
      Fn: {
        physicalId: 'my-fn',
        resourceType: 'AWS::Lambda::Function',
        properties: { Environment: { Variables: { SECRET: SECRET_PLAINTEXT } } },
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  } as StackState;
}

let stateBackend: {
  prefix: string;
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  purgeNoncurrentVersions: ReturnType<typeof vi.fn>;
  getRawObject: ReturnType<typeof vi.fn>;
};
let lockManager: {
  acquireLockWithRetry: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  rx.rejectMarker = undefined;
  rx.recordImport = false;
  rx.rejectParameters = false;
  rx.rejectConditions = false;
  rx.rejectDynamicReferences = false;
  rx.conditions = {};
  stateBackend = {
    prefix: 'cdkd',
    getState: vi.fn().mockResolvedValue({ state: leakyState(), etag: 'etag-1' }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
    getRawObject: vi.fn().mockResolvedValue(null),
  };
  lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
});

const scrub = (
  template: CloudFormationTemplate,
  extra: Record<string, unknown> = {}
): ReturnType<typeof scrubStack> =>
  scrubStack(stackInfo(template) as never, 'us-east-1', stateBackend as never, lockManager as never, {
    dryRun: false,
    logger: log as never,
    ...extra,
  });

describe('scrubStack: handlers that log and carry on (#3361)', () => {
  it('a lock release rejecting unconvertibly still returns the scrub result, and warns', async () => {
    // The release `.catch` sits in `scrubStack`'s `finally`: its throw
    // replaced the scrub's own result, so a stack whose state was rewritten
    // was reported as failed.
    lockManager.releaseLock.mockRejectedValue(unconvertible());

    const res = await scrub({ Resources: LEAKY_RESOURCE });

    expect(res.recordsChanged).toBeGreaterThan(0);
    expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
    const warned = linesWith(log.warn, 'Failed to release lock for');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(PLACEHOLDER);
  });

  it('a resource property whose resolution rejects unconvertibly does not abandon the stack', async () => {
    rx.rejectMarker = 'REJECT-RESOURCE';

    const res = await scrub({ Resources: leakyResourceWith({ Description: 'REJECT-RESOURCE' }) });

    // The OTHER resource's secret is still rewritten.
    expect(res.recordsChanged).toBeGreaterThan(0);
    const partial = linesWith(log.debug, 'during scrub was partial');
    expect(partial).toHaveLength(1);
    expect(partial[0]).toContain(`partial: ${PLACEHOLDER}`);
  });

  it('an orphan record whose resolution rejects unconvertibly does not abandon the stack', async () => {
    rx.rejectMarker = 'REJECT-ORPHAN';
    stateBackend.getState.mockResolvedValue({
      state: leakyState({
        orphans: [
          {
            logicalId: 'Gone',
            state: {
              physicalId: 'gone-1',
              resourceType: 'AWS::SNS::Topic',
              properties: { TopicName: 'REJECT-ORPHAN' },
            },
            orphanedAt: 0,
          },
        ],
      } as unknown as Partial<StackState>),
      etag: 'etag-1',
    });

    const res = await scrub({ Resources: LEAKY_RESOURCE });

    expect(res.recordsChanged).toBeGreaterThan(0);
    const partial = linesWith(log.debug, 'Resolution of orphan record');
    expect(partial).toHaveLength(1);
    expect(partial[0]).toContain(`partial: ${PLACEHOLDER}`);
  });

  it('an output value and its Export.Name rejecting unconvertibly still scrub the rest', async () => {
    // Two sites: the output value's catch (debug), and the Export.Name
    // failure, whose error is carried out of its catch in `nameError` and
    // printed at DEFAULT verbosity -- the parameter-shaped one.
    rx.rejectMarker = 'REJECT-OUTPUT';
    stateBackend.getState.mockResolvedValue({
      state: leakyState({ outputs: { Out: 'stored-value' } }),
      etag: 'etag-1',
    });

    const res = await scrub({
      Resources: LEAKY_RESOURCE,
      Outputs: {
        // An INTRINSIC name: a literal one is never resolved.
        Out: { Value: 'REJECT-OUTPUT-VALUE', Export: { Name: { 'Fn::Sub': 'REJECT-OUTPUT-NAME' } } },
      },
    } as unknown as CloudFormationTemplate);

    expect(res.recordsChanged).toBeGreaterThan(0);
    const nameWarn = linesWith(log.warn, 'could not be resolved during scrub');
    expect(nameWarn).toHaveLength(1);
    expect(nameWarn[0]).toContain(`(${PLACEHOLDER})`);
    const valueDebug = linesWith(log.debug, 'Resolution of output');
    expect(valueDebug).toHaveLength(1);
    expect(valueDebug[0]).toContain(`partial: ${PLACEHOLDER}`);
  });

  it('parameter resolution rejecting unconvertibly still binds nothing and scrubs the stack', async () => {
    // Two sites: the whole-bag catch, and the per-parameter retry it falls
    // back to (`bindDefaultedParametersOneByOne`), which rejects the same way.
    rx.rejectParameters = true;

    const res = await scrub({
      Parameters: { Stage: { Type: 'String', Default: 'dev' } },
      Resources: LEAKY_RESOURCE,
    });

    expect(res.recordsChanged).toBeGreaterThan(0);
    const skipped = linesWith(log.debug, 'Parameter resolution skipped for');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(PLACEHOLDER);
    const unbound = linesWith(log.debug, 'left unbound');
    expect(unbound).toHaveLength(1);
    expect(unbound[0]).toContain(PLACEHOLDER);
  });

  it('condition evaluation rejecting unconvertibly still scrubs the stack', async () => {
    rx.rejectConditions = true;

    const res = await scrub({
      Conditions: { IsProd: { 'Fn::Equals': ['a', 'b'] } },
      Resources: LEAKY_RESOURCE,
    });

    expect(res.recordsChanged).toBeGreaterThan(0);
    const skipped = linesWith(log.debug, 'Condition evaluation skipped for');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(PLACEHOLDER);
  });

  it('a consumer-records read rejecting unconvertibly keeps every output key and warns', async () => {
    // A stored output key today's template no longer declares is a drop
    // candidate; the read that checks no other stack still reads it failed,
    // so the handler keeps them all. It threw instead.
    stateBackend.getState.mockResolvedValue({
      state: leakyState({ outputs: { Gone: 'old-value' }, imports: [], outputReads: [] } as Partial<StackState>),
      etag: 'etag-1',
    });

    const res = await scrub(
      { Resources: LEAKY_RESOURCE },
      { readConsumerRecords: () => Promise.reject(unconvertible()) }
    );

    expect(res.recordsChanged).toBeGreaterThan(0);
    const saved = stateBackend.saveState.mock.calls.at(-1)![2] as StackState;
    expect(saved.outputs['Gone']).toBe('old-value');
    const warned = linesWith(log.warn, 'NONE was dropped');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`(${PLACEHOLDER})`);
  });
});

describe('scrubStack: the cross-stack pre-pass (#3361)', () => {
  it('a SUPPRESSED output whose read rejects unconvertibly is debugged and skipped', async () => {
    // `canRefuse: false` -- a condition-suppressed output that wrote no
    // state key -- logs and returns. It threw instead.
    rx.rejectMarker = 'SuppressedExport';
    rx.conditions = { Off: false };

    const res = await scrub({
      Conditions: { Off: { 'Fn::Equals': ['a', 'b'] } },
      Resources: LEAKY_RESOURCE,
      Outputs: { Suppressed: { Condition: 'Off', Value: { 'Fn::ImportValue': 'SuppressedExport' } } },
    });

    expect(res.recordsChanged).toBeGreaterThan(0);
    const skipped = linesWith(log.debug, 'this position cannot refuse');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(PLACEHOLDER);
  });

  it('a read rejecting unconvertibly REFUSES the stack with its own code, not a TypeError', async () => {
    rx.rejectMarker = 'BrokenExport';

    const err = await scrub({
      Resources: leakyResourceWith({ Description: { 'Fn::ImportValue': 'BrokenExport' } }),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_STACK_READ_UNRESOLVED');
    expect((err as Error).message).toContain(PLACEHOLDER);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
  });

  it("a producer record that cannot be re-read unconvertibly is left unclassified", async () => {
    // `storedProducerValue` answers "cannot classify" when the producer's
    // record is unreadable. Its debug line threw instead, and the pre-pass
    // failed the CONSUMER over somebody else's record.
    rx.recordImport = true;
    stateBackend.getState.mockImplementation((stackName: string) =>
      stackName === 'Producer'
        ? Promise.reject(unconvertible())
        : Promise.resolve({ state: leakyState(), etag: 'etag-1' })
    );
    const producer = stackInfo(
      {
        Resources: {},
        Outputs: { Exp: { Value: SECRET_EXPR, Export: { Name: 'ProducerExport' } } },
      },
      'Producer'
    );
    const consumerTemplate: CloudFormationTemplate = {
      Resources: leakyResourceWith({ Description: { 'Fn::ImportValue': 'ProducerExport' } }),
    };

    const outcome = await scrub(consumerTemplate, {
      appStacks: [stackInfo(consumerTemplate), producer],
    }).catch((e: unknown) => e);

    const reread = linesWith(log.debug, 'could not re-read producer');
    expect(reread).toHaveLength(1);
    expect(reread[0]).toContain(PLACEHOLDER);
    // Unclassified is "fall back to the producer's TEMPLATE evidence", never a
    // refusal of THIS stack: its own secret is still rewritten.
    expect((outcome as { recordsChanged?: number }).recordsChanged).toBeGreaterThan(0);
  });
});

describe('scrubStack: refusals that interpolate the failure (#3361)', () => {
  it('a nested child whose Parameters reject unconvertibly refuses with its own code', async () => {
    rx.rejectParameters = true;

    const err = await scrub(
      { Parameters: { P: { Type: 'String' } }, Resources: LEAKY_RESOURCE },
      {
        nestedChild: {
          logicalId: 'Child',
          stackName: 'MyStack',
          input: { parameters: { P: 'v' }, inheritedSecrets: new Map() },
        },
      }
    ).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_NESTED_CHILD_UNRESOLVABLE');
    expect((err as Error).message).toContain(`(${PLACEHOLDER})`);
  });

  it('a legacy-key check rejecting unconvertibly refuses with its own code and still purges', async () => {
    // The write LANDED, so the refusal's remedy ("check that key yourself; a
    // re-run will not check it again") is the only place the operator learns
    // it. The converter's TypeError carried none of it.
    stateBackend.getState.mockResolvedValue({
      state: leakyState(),
      etag: 'etag-1',
      migrationPending: true,
    });
    stateBackend.getRawObject.mockRejectedValue(unconvertible());

    const err = await scrub({ Resources: LEAKY_RESOURCE }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_LEGACY_STATE_KEY_UNVERIFIED');
    expect((err as Error).message).toContain(`(${PLACEHOLDER})`);
    expect(stateBackend.purgeNoncurrentVersions).toHaveBeenCalledTimes(1);
  });

  it('a cross-region secret lookup rejecting unconvertibly refuses with its own code', async () => {
    rx.rejectDynamicReferences = true;
    const foreign =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-1:123456789012:secret:db-AbCdEf:SecretString:password::}}';

    const err = await scrub({
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { SECRET: foreign } } },
        },
      },
    }).catch((e: unknown) => e);

    expect((err as { code?: string }).code).toBe('SCRUB_CROSS_REGION_SECRET_UNRESOLVED');
    expect((err as Error).message).toContain(PLACEHOLDER);
  });
});

describe('scrubCommand: the per-stack boundary and the exports-index step (#3361)', () => {
  const options = (o: Partial<ScrubOptions> = {}): ScrubOptions => ({
    output: 'cdk.out',
    statePrefix: 'cdkd',
    verbose: false,
    all: true,
    ...o,
  });

  beforeEach(() => {
    synthStacks.length = 0;
    synthStacks.push(
      stackInfo({ Resources: LEAKY_RESOURCE }, 'First'),
      stackInfo({ Resources: LEAKY_RESOURCE }, 'Second')
    );
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      Promise.resolve({ state: leakyState({}, stackName), etag: 'etag-1' })
    );
    commandStateBackend.saveState.mockResolvedValue('etag-2');
    commandStateBackend.purgeNoncurrentVersions.mockResolvedValue(undefined);
    commandStateBackend.listStacks.mockResolvedValue([]);
    indexStore.readPersistedEntries.mockResolvedValue(undefined);
    indexStore.patchEntry.mockResolvedValue(true);
  });

  it('one stack failing unconvertibly is reported, and the NEXT stack is still scrubbed', async () => {
    // `describeFailure` is the per-stack boundary's renderer. Its `String`
    // threw from inside the `catch`, which ended the whole `--all` run at the
    // first such stack: every later stack went unexamined.
    commandStateBackend.getState.mockImplementation((stackName: string) =>
      stackName === 'First'
        ? Promise.reject(unconvertible())
        : Promise.resolve({ state: leakyState({}, stackName), etag: 'etag-1' })
    );

    const err = await scrubCommand([], options()).catch((e: unknown) => e);

    expect(commandStateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['Second']);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const failed = linesWith(log.error, 'Scrub of First failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(PLACEHOLDER);
  });

  it('the nested-record listing rejecting unconvertibly is reported, and the run finishes', async () => {
    commandStateBackend.listStacks.mockRejectedValue(unconvertible());

    const err = await scrubCommand([], options()).catch((e: unknown) => e);

    expect(commandStateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['First', 'Second']);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const failed = linesWith(log.error, 'their state records could not be listed');
    expect(failed).toHaveLength(2);
    for (const line of failed) expect(line).toContain(PLACEHOLDER);
  });

  it('an exports index unreadable unconvertibly is recorded once, and the run finishes', async () => {
    indexStore.readPersistedEntries.mockRejectedValue(unconvertible());

    const err = await scrubCommand([], options()).catch((e: unknown) => e);

    expect(commandStateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['First', 'Second']);
    expect((err as { code?: string }).code).toBe('SCRUB_EXPORT_INDEX_INCOMPLETE');
    const unreadable = linesWith(log.error, 'could not be read (first seen while scrubbing');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain(PLACEHOLDER);
  });

  it("the coverage report's second index read rejecting unconvertibly is recorded", async () => {
    // The per-stack pass found no index object, so the coverage report issues
    // its own GET -- the one that fails here.
    let reads = 0;
    indexStore.readPersistedEntries.mockImplementation(() =>
      ++reads <= 2 ? Promise.resolve(undefined) : Promise.reject(unconvertible())
    );

    const err = await scrubCommand([], options()).catch((e: unknown) => e);

    expect(commandStateBackend.saveState.mock.calls.map((c) => c[0])).toEqual(['First', 'Second']);
    expect((err as { code?: string }).code).toBe('SCRUB_EXPORT_INDEX_INCOMPLETE');
    const unreadable = linesWith(log.error, 'could not be read for the coverage report');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain(PLACEHOLDER);
  });
});
