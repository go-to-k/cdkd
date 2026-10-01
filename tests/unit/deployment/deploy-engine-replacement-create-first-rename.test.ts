/**
 * go-to-k/cdkd#3931 and #3937, the #3808 siblings.
 *
 * #3931: the UPDATE-not-supported fallback and the `--recreate-via-*` recreate
 * deleted the old resource FIRST even when the replacement also moved its
 * explicit name off the one the old resource holds. Deleting first frees
 * nothing then; when another resource held the new name the create collided
 * with the managed resource already gone. Both now create first when the name
 * is KNOWN to differ, and a collision deletes nothing.
 *
 * #3937: a create API that hands back (SQS, SNS, Step Functions) or overwrites
 * (EventBridge, CloudWatch alarms) a resource already holding the name cannot
 * collide, so a rename onto a third party's name "succeeded" with that
 * resource, the old one was deleted, and state recorded the stranger's. The
 * name is now probed before the create.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ccUpdateUnsupportedRejection } from '../_cc-unsupported-action.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { getLogger } from '../../../src/utils/logger.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('p-limit', () => ({
  default: vi.fn(() => <T>(fn: () => T) => fn()),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type Inner = Error & { code?: string; cause?: unknown };

/** Lambda's real collision spelling, anchored on the logical id. */
const collision = (name: string): Error =>
  new Error(`Failed to create Lambda function Fn: Function already exist: ${name}`, {
    cause: awsSdkError(`Function already exist: ${name}`),
  });

const logger = getLogger() as unknown as {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

interface Harness {
  callOrder: string[];
  createFailures: Error[];
  createIds: string[];
  deleteFailure: Error | undefined;
  importResult: { physicalId: string } | null | Error;
  provider: ResourceProvider;
}

function makeHarness(type: string, opts: { withImport?: boolean } = {}): Harness {
  const h: Harness = {
    callOrder: [],
    createFailures: [],
    createIds: [],
    deleteFailure: undefined,
    importResult: null,
    provider: undefined as unknown as ResourceProvider,
  };
  h.provider = {
    create: vi.fn().mockImplementation(async () => {
      h.callOrder.push('create');
      const failure = h.createFailures.shift();
      if (failure) throw failure;
      return { physicalId: h.createIds.shift() ?? 'new-id', attributes: {} };
    }),
    update: vi.fn().mockImplementation(async (logicalId: string) => {
      h.callOrder.push('update');
      throw ccUpdateUnsupportedRejection(type, logicalId);
    }),
    delete: vi.fn().mockImplementation(async () => {
      h.callOrder.push('delete');
      if (h.deleteFailure) throw h.deleteFailure;
    }),
    getAttribute: vi.fn(),
    ...(opts.withImport !== false && {
      import: vi.fn().mockImplementation(async () => {
        h.callOrder.push('import');
        if (h.importResult instanceof Error) throw h.importResult;
        return h.importResult;
      }),
    }),
  };
  return h;
}

function makeEngine(
  h: Harness,
  opts: {
    replace?: boolean;
    recreateViaSdkProvider?: boolean;
    recreateViaCcApi?: boolean;
    forceStatefulRecreation?: boolean;
    provisionedBy?: 'sdk' | 'cc-api';
  } = {}
): InstanceType<typeof DeployEngine> {
  return new DeployEngine(
    { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') } as unknown as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    } as unknown as never,
    {
      getProvider: vi.fn().mockReturnValue(h.provider),
      getProviderFor: vi
        .fn()
        .mockReturnValue({ provider: h.provider, provisionedBy: opts.provisionedBy ?? 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    } as unknown as never,
    {
      ...(opts.replace !== undefined && { replace: opts.replace }),
      ...(opts.forceStatefulRecreation === true && { forceStatefulRecreation: true }),
      ...((opts.recreateViaSdkProvider === true || opts.recreateViaCcApi === true) && {
        recreateTargets: {
          stackName: 'MyStack',
          viaCcApi: new Set<string>(opts.recreateViaCcApi === true ? ['Fn'] : []),
          viaSdkProvider: new Set<string>(opts.recreateViaSdkProvider === true ? ['Fn'] : []),
        },
      }),
    },
    'us-east-1'
  );
}

/**
 * `replacement: false` reaches the UPDATE-not-supported fallback; `true` the
 * property-driven path (or the recreate arm, with the engine's recreate flag).
 */
async function provision(
  engine: InstanceType<typeof DeployEngine>,
  opts: {
    type?: string;
    nameProperty?: string;
    recorded: string;
    desired: string;
    physicalId?: string;
    policy?: 'Retain' | 'Snapshot';
    /** The state record's policy, for a template that declares none. */
    statePolicy?: 'Snapshot';
    replacement?: boolean;
    provisionedBy?: 'sdk' | 'cc-api';
    /** The state record's type and name property, for a Type change. */
    oldType?: string;
    oldNameProperty?: string;
    /** Extra properties on the old / new bag. */
    oldExtra?: Record<string, unknown>;
    newExtra?: Record<string, unknown>;
  }
): Promise<Inner | null> {
  const type = opts.type ?? 'AWS::Lambda::Function';
  const nameProperty = opts.nameProperty ?? 'FunctionName';
  const replacement = opts.replacement ?? true;
  const oldProps = {
    Runtime: 'nodejs20.x',
    [opts.oldNameProperty ?? nameProperty]: opts.recorded,
    ...opts.oldExtra,
  };
  const newProps = { Runtime: 'nodejs22.x', [nameProperty]: opts.desired, ...opts.newExtra };
  const change: ResourceChange = {
    logicalId: 'Fn',
    changeType: 'UPDATE',
    resourceType: type,
    currentProperties: oldProps,
    desiredProperties: newProps,
    propertyChanges: [
      {
        path: 'Runtime',
        oldValue: 'nodejs20.x',
        newValue: 'nodejs22.x',
        requiresReplacement: replacement,
      },
    ],
  };
  const stateResources = {
    Fn: {
      physicalId: opts.physicalId ?? opts.recorded,
      resourceType: opts.oldType ?? type,
      properties: oldProps,
      attributes: {},
      dependencies: [],
      provisionedBy: opts.provisionedBy ?? ('sdk' as const),
      ...(opts.statePolicy !== undefined && { updateReplacePolicy: opts.statePolicy }),
    },
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Fn: {
        Type: type,
        Properties: newProps,
        ...(opts.policy !== undefined && { UpdateReplacePolicy: opts.policy }),
      },
    },
  };
  const run = (
    engine as unknown as {
      provisionResource: (
        logicalId: string,
        change: ResourceChange,
        stateResources: Record<string, unknown>,
        stackName: string,
        template: CloudFormationTemplate
      ) => Promise<void>;
    }
  ).provisionResource.bind(engine);
  return run('Fn', change, stateResources, 'MyStack', template).then(
    () => null,
    (e) => (e as { cause?: unknown }).cause as Inner
  );
}

const infoLines = (): string[] => logger.info.mock.calls.map((c) => String(c[0]));
const warnLines = (): string[] => logger.warn.mock.calls.map((c) => String(c[0]));
const debugLines = (): string[] => logger.debug.mock.calls.map((c) => String(c[0]));

describe('DeployEngine — create-first when a replacement moves its name (#3931)', () => {
  let h: Harness;

  beforeEach(() => {
    logger.info.mockClear();
    logger.warn.mockClear();
    h = makeHarness('AWS::Lambda::Function', { withImport: false });
  });

  describe('the UPDATE-not-supported fallback', () => {
    it('refuses and deletes NOTHING when the new name is held elsewhere', async () => {
      h.createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'taken-name',
        replacement: false,
      });

      expect(err).not.toBeNull();
      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('created the new resource first because its name differs');
      expect(err!.message).toContain('held by ANOTHER existing resource');
      expect(err!.message).toContain('Nothing was deleted');
      expect(err!.message).not.toContain('is now gone');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect((err!.cause as Error).message).toContain('Function already exist: taken-name');
      // The feared shape: update -> delete -> create.
      expect(h.callOrder).toEqual(['update', 'create']);
      expect(h.provider.delete).not.toHaveBeenCalled();
    });

    it('creates the renamed resource BEFORE deleting the old one', async () => {
      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['update', 'create', 'delete']);
      expect(h.provider.delete).toHaveBeenCalledWith(
        'Fn',
        'my-fn',
        'AWS::Lambda::Function',
        expect.objectContaining({ FunctionName: 'my-fn' }),
        expect.anything()
      );
      expect(infoLines().some((l) => l.includes('replacing (CREATE → DELETE'))).toBe(true);
      expect(infoLines().some((l) => l.includes('replacing (DELETE → CREATE)'))).toBe(false);
    });

    it('keeps the fallback create-only under Retain for a rename onto a free name', async () => {
      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
        policy: 'Retain',
      });

      expect(err).toBeNull();
      // The old resource is retained: no delete at all.
      expect(h.callOrder).toEqual(['update', 'create']);
      expect(h.provider.delete).not.toHaveBeenCalled();
    });

    it('warns on a failed old-resource delete even when its text says NotFound', async () => {
      // An AccessDenied naming a missing dependency, while the old resource is
      // alive: a substring "already gone" read would silence the orphan.
      h.deleteFailure = new Error('AccessDenied: KMS key NotFound for my-fn; role does not exist');
      logger.debug.mockClear();

      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['update', 'create', 'delete']);
      expect(
        warnLines().some(
          (l) => l.includes('Failed to delete old resource Fn') && l.includes('AccessDenied')
        )
      ).toBe(true);
      expect(debugLines().some((l) => l.includes('already gone'))).toBe(false);
    });

    it('masks a secret the failed old-resource delete echoes', async () => {
      const secret = 'hunter2\u0007secret-value';
      h.deleteFailure = new Error(`AccessDenied for ${secret}`);
      const engine = makeEngine(h) as unknown as {
        deleteReplacedAfterCreate: (...args: unknown[]) => Promise<void>;
      };

      await engine.deleteReplacedAfterCreate(
        'Fn',
        'AWS::Lambda::Function',
        { physicalId: 'my-fn', resourceType: 'AWS::Lambda::Function', properties: {} },
        h.provider,
        {},
        undefined,
        undefined,
        new Map([[secret, '{{resolve:secretsmanager:s}}']])
      );

      const line = warnLines().find((l) => l.includes('Failed to delete old resource Fn'));
      expect(line).toBeDefined();
      expect(line).not.toContain('secret-value');
      expect(line).toContain('***');
    });

    it('a skipped cleanup SHOWS a composite physical id: its line has no command, and the id is the only trace (go-to-k/cdkd#4265)', async () => {
      // The `|`-composite ids (Route 53, Glue, API Gateway) are never plain, so
      // the delete-skip sentence would describe them beside a command. Here
      // the record is already gone and nothing else names the resource, so
      // the id is printed, bounded in JSON quotes.
      const composite = 'Z123|www.example.com|A';
      h.provider.delete = vi.fn().mockResolvedValue({
        outcome: 'skipped',
        reason: 'malformed physicalId in state — no delete issued',
      });
      const engine = makeEngine(h) as unknown as {
        deleteReplacedAfterCreate: (...args: unknown[]) => Promise<void>;
      };

      await engine.deleteReplacedAfterCreate(
        'Rec',
        'AWS::Route53::RecordSet',
        { physicalId: composite, resourceType: 'AWS::Route53::RecordSet', properties: {} },
        h.provider,
        {},
        undefined,
        undefined,
        new Map()
      );

      const line = warnLines().find((l) => l.includes('while cleaning up the replaced resource'));
      expect(line).toContain(`cdkd did not confirm Rec (${JSON.stringify(composite)}) was deleted`);
      expect(line).toContain('Delete it manually');
      expect(line).not.toContain('not a plain identifier');
    });

    it('keeps DELETE → CREATE for a same-name replacement (negative control)', async () => {
      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'my-fn',
        replacement: false,
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['update', 'delete', 'create']);
      expect(infoLines().some((l) => l.includes('replacing (DELETE → CREATE)'))).toBe(true);
    });

    it('warns and keeps the replacement when the old delete fails after the create', async () => {
      h.deleteFailure = new Error('AccessDenied on delete');

      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['update', 'create', 'delete']);
      expect(
        warnLines().some(
          (l) => l.includes('Failed to delete old resource Fn') && l.includes('AccessDenied')
        )
      ).toBe(true);
    });

    it('refuses a final snapshot it cannot take BEFORE creating anything', async () => {
      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
        policy: 'Snapshot',
      });

      expect(err).not.toBeNull();
      expect(err!.code).toMatch(/^FINAL_SNAPSHOT_/);
      expect(h.callOrder).toEqual(['update']);
    });

    it('surfaces a create failure that is not a collision raw, without the "gone" wording', async () => {
      h.createFailures = [new Error('AccessDenied: lambda:CreateFunction')];

      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
      });

      expect(err!.message).toContain('AccessDenied: lambda:CreateFunction');
      expect(err!.message).not.toContain('is now gone');
      expect(err!.message).not.toContain('Nothing was deleted');
      expect(h.callOrder).toEqual(['update', 'create']);
    });

    it('refuses without deleting when the create hands the old resource back', async () => {
      h.createIds = ['my-fn'];

      const err = await provision(makeEngine(h), {
        recorded: 'my-fn',
        desired: 'free-name',
        replacement: false,
      });

      expect(err!.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(err!.message).toContain('Nothing was deleted');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(h.callOrder).toEqual(['update', 'create']);
    });
  });

  describe('the --recreate-via-sdk-provider recreate', () => {
    it('refuses and deletes NOTHING when the new name is held elsewhere', async () => {
      h.createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'taken-name',
      });

      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('(--recreate-via-sdk-provider)');
      expect(err!.message).toContain('Nothing was deleted');
      expect(isMarkedNonRetryable(err)).toBe(true);
      // Once: the recreate's name-release retry is not run on a name the old
      // resource never held.
      expect(h.callOrder).toEqual(['create']);
    });

    it('creates the renamed resource BEFORE destroying the old one', async () => {
      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'free-name',
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['create', 'delete']);
      expect(infoLines().some((l) => l.includes('before recreate'))).toBe(false);
    });

    it('creates first for a case-only rename of a case-sensitive name (#3931)', async () => {
      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'My-Fn',
      });

      expect(err).toBeNull();
      // Lambda names are case-sensitive: `My-Fn` is another name, which the old
      // function does not hold, so deleting it first would free nothing.
      expect(h.callOrder).toEqual(['create', 'delete']);
    });

    it('keeps destroy-then-create for a case-only rename of a case-folding name', async () => {
      h = makeHarness('AWS::IAM::Role', { withImport: false });

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        type: 'AWS::IAM::Role',
        nameProperty: 'RoleName',
        recorded: 'my-role',
        desired: 'My-Role',
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['delete', 'create']);
    });

    it('keeps destroy-then-create for a same-name recreate (negative control)', async () => {
      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'my-fn',
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['delete', 'create']);
    });

    it('refuses a collision at once under Retain, not after the name-release retries', async () => {
      h.createFailures = [collision('taken-name')];

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'taken-name',
        policy: 'Retain',
      });

      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(err!.message).toContain(
        'Nothing was deleted (UpdateReplacePolicy: Retain keeps the old resource in place)'
      );
      expect(h.callOrder).toEqual(['create']);
    });

    it('creates first under --recreate-via-cc-api too', async () => {
      const err = await provision(makeEngine(h, { recreateViaCcApi: true }), {
        recorded: 'my-fn',
        desired: 'free-name',
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['create', 'delete']);
    });

    it('surfaces a create failure that is not a collision raw, with nothing deleted', async () => {
      h.createFailures = [new Error('AccessDenied: lambda:CreateFunction')];

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'free-name',
      });

      expect(err!.message).toContain('AccessDenied: lambda:CreateFunction');
      expect(err!.message).not.toContain('Nothing was deleted');
      expect(h.callOrder).toEqual(['create']);
    });

    it('refuses without deleting when the recreate create hands the old resource back', async () => {
      h.createIds = ['my-fn'];

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
        recorded: 'my-fn',
        desired: 'free-name',
      });

      expect(err!.code).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(h.callOrder).toEqual(['create']);
    });

    it('keeps the create-only Retain arm for a renamed recreate, recorded as a retention', async () => {
      const engine = makeEngine(h, { recreateViaSdkProvider: true });
      const err = await provision(engine, {
        recorded: 'my-fn',
        desired: 'free-name',
        policy: 'Retain',
      });

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['create']);
      // Issue #2603: what the rollback journal's `oldResourceRetained` reads.
      expect(
        (engine as unknown as { retainedOldOnReplacement: Set<string> }).retainedOldOnReplacement.has(
          'Fn'
        )
      ).toBe(true);
      expect(
        warnLines().some(
          (l) =>
            l.includes('UpdateReplacePolicy: Retain') &&
            l.includes('--recreate-via-sdk-provider leaves the old physical resource (my-fn)')
        )
      ).toBe(true);
    });
  });
});

describe('DeployEngine — the final snapshot on a create-first replacement (#3931)', () => {
  const DB = 'AWS::RDS::DBInstance';
  let h: Harness;

  beforeEach(() => {
    h = makeHarness(DB, { withImport: false });
  });

  const db = (extra: Partial<Parameters<typeof provision>[1]> = {}): Parameters<typeof provision>[1] => ({
    type: DB,
    nameProperty: 'DBInstanceIdentifier',
    recorded: 'my-db',
    desired: 'new-db',
    ...extra,
  });

  const snapshotDelete = (): void => {
    expect(h.provider.delete).toHaveBeenCalledWith(
      'Fn',
      'my-db',
      DB,
      expect.anything(),
      expect.objectContaining({
        finalSnapshotIdentifier: expect.any(String),
        deletionPolicy: 'Snapshot',
      })
    );
  };

  it('hands the renamed recreate delete its final snapshot, after the create', async () => {
    const err = await provision(
      makeEngine(h, { recreateViaSdkProvider: true, forceStatefulRecreation: true }),
      db({ policy: 'Snapshot' })
    );

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['create', 'delete']);
    snapshotDelete();
  });

  it('hands the renamed fallback delete its final snapshot, after the create', async () => {
    const err = await provision(
      makeEngine(h, { forceStatefulRecreation: true }),
      db({ policy: 'Snapshot', replacement: false })
    );

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['update', 'create', 'delete']);
    snapshotDelete();
  });

  it("reads the fallback's Snapshot from state when the template declares none", async () => {
    const err = await provision(
      makeEngine(h, { forceStatefulRecreation: true }),
      db({ statePolicy: 'Snapshot', replacement: false })
    );

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['update', 'create', 'delete']);
    snapshotDelete();
  });
});

describe('DeployEngine — a rename onto a name a name-adopting create would take over (#3937)', () => {
  const QUEUE = 'AWS::SQS::Queue';
  const OLD_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';
  const THEIRS = 'https://sqs.us-east-1.amazonaws.com/123456789012/their-queue';
  let h: Harness;

  beforeEach(() => {
    logger.info.mockClear();
    logger.warn.mockClear();
    h = makeHarness(QUEUE);
  });

  const queue = (
    desired: string,
    extra: Partial<Parameters<typeof provision>[1]> = {}
  ): Parameters<typeof provision>[1] => ({
    type: QUEUE,
    nameProperty: 'QueueName',
    recorded: 'my-queue',
    desired,
    physicalId: OLD_URL,
    ...extra,
  });

  it('refuses a property-driven rename BEFORE the create when another queue holds the name', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await provision(makeEngine(h), queue('their-queue'));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain(`another existing resource (${THEIRS})`);
    expect(err!.message).toContain('would take that resource over');
    expect(err!.message).toContain('Nothing was created or deleted');
    expect(isMarkedNonRetryable(err)).toBe(true);
    // The feared shape: create (hands back theirs) -> delete ours.
    expect(h.callOrder).toEqual(['import']);
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalId: 'Fn',
        resourceType: QUEUE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: expect.objectContaining({ QueueName: 'their-queue' }),
      })
    );
    // A name lookup, not a check of a known id.
    expect(
      (h.provider.import as ReturnType<typeof vi.fn>).mock.calls[0]![0].knownPhysicalId
    ).toBeUndefined();
  });

  it('proceeds when no resource holds the new name (negative control)', async () => {
    h.importResult = null;
    h.createIds = [THEIRS.replace('their-queue', 'free-queue')];

    const err = await provision(makeEngine(h), queue('free-queue'));

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['import', 'create', 'delete']);
  });

  it('refuses under Retain too, where nothing would have been deleted', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await provision(makeEngine(h), queue('their-queue', { policy: 'Retain' }));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses in the UPDATE-not-supported fallback before deleting or creating', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await provision(makeEngine(h), queue('their-queue', { replacement: false }));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['update', 'import']);
  });

  it('keeps the old order when the probe finds the OLD queue under the name', async () => {
    h.importResult = { physicalId: OLD_URL };

    const err = await provision(makeEngine(h), queue('their-queue', { replacement: false }));

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['update', 'import', 'delete', 'create']);
  });

  it('refuses when the probe fails, with nothing created or deleted', async () => {
    h.importResult = new Error('AccessDenied: sqs:GetQueueUrl');

    const err = await provision(makeEngine(h), queue('their-queue'));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('could not check whether another resource already holds it');
    expect(err!.message).toContain('AccessDenied');
    expect(err!.message).toContain('Nothing was created or deleted');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses a Step Functions rename whose old id is not a state machine ARN', async () => {
    h = makeHarness('AWS::StepFunctions::StateMachine');

    const err = await provision(makeEngine(h), {
      type: 'AWS::StepFunctions::StateMachine',
      nameProperty: 'StateMachineName',
      recorded: 'my-sm',
      desired: 'their-sm',
      physicalId: 'not-an-arn',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('cannot check whether another resource already holds it');
    expect(err!.message).toContain('Nothing was created or deleted');
    expect(h.callOrder).toEqual([]);
  });

  it('does not probe a Cloud Control create, which refuses a taken name itself', async () => {
    const err = await provision(
      makeEngine(h, { provisionedBy: 'cc-api' }),
      queue('free-queue', { provisionedBy: 'cc-api' })
    );

    expect(err).toBeNull();
    expect(h.provider.import).not.toHaveBeenCalled();
  });

  it('does not probe a same-name replacement', async () => {
    h.createIds = [OLD_URL.replace('my-queue', 'my-queue-2')];

    await provision(makeEngine(h), queue('my-queue'));

    expect(h.provider.import).not.toHaveBeenCalled();
  });

  it('probes a case-only rename, which a case-sensitive queue name makes a different name', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await provision(makeEngine(h), queue('My-Queue'));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('the fallback creates a renamed queue onto a free name before deleting the old one', async () => {
    h.importResult = null;
    h.createIds = [THEIRS.replace('their-queue', 'free-queue')];

    const err = await provision(makeEngine(h), queue('free-queue', { replacement: false }));

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['update', 'import', 'create', 'delete']);
  });

  it('refuses a renamed recreate onto a held queue before destroying anything', async () => {
    h.importResult = { physicalId: THEIRS };

    const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), queue('their-queue'));

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses an un-askable Step Functions rename even without an import() to call', async () => {
    h = makeHarness('AWS::StepFunctions::StateMachine', { withImport: false });

    const err = await provision(makeEngine(h), {
      type: 'AWS::StepFunctions::StateMachine',
      nameProperty: 'StateMachineName',
      recorded: 'my-sm',
      desired: 'their-sm',
      physicalId: 'not-an-arn',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual([]);
  });

  it('masks a secret the failed lookup echoes before it is cut for display', async () => {
    // A control character INSIDE the value: rendering replaces it, so a mask
    // applied after the rendering no longer finds the value.
    const secret = 'hunter2\u0007secret-value';
    h.importResult = new Error(`AccessDenied for ${secret} on GetQueueUrl`);
    const engine = makeEngine(h) as unknown as {
      checkedReplacementNameChange: (input: Record<string, unknown>) => Promise<unknown>;
    };

    const err = (await engine
      .checkedReplacementNameChange({
        logicalId: 'Fn',
        resourceType: QUEUE,
        oldResourceType: QUEUE,
        stackName: 'MyStack',
        currentResource: {
          physicalId: OLD_URL,
          resourceType: QUEUE,
          properties: { QueueName: 'my-queue' },
        },
        desiredProperties: { QueueName: 'their-queue' },
        createProvider: h.provider,
        createdVia: 'sdk',
        createProps: { QueueName: 'their-queue' },
        secrets: new Map([[secret, '{{resolve:secretsmanager:s}}']]),
      })
      .then(
        () => null,
        (e: unknown) => e
      )) as Error;

    expect(err.message).toContain('could not check whether another resource already holds it');
    expect(err.message).not.toContain(secret);
    expect(err.message).not.toContain('secret-value');
    expect(err.message).toContain('***');
  });

  describe('an EventBridge rule moving bus under the same Name', () => {
    const RULE = 'AWS::Events::Rule';
    const OLD_ARN = 'arn:aws:events:us-east-1:123456789012:rule/busA/my-rule';
    const THEIR_ARN = 'arn:aws:events:us-east-1:123456789012:rule/busB/my-rule';
    const rule = (
      oldBus: string | undefined,
      newBus: string | undefined
    ): Parameters<typeof provision>[1] => ({
      type: RULE,
      nameProperty: 'Name',
      recorded: 'my-rule',
      desired: 'my-rule',
      physicalId: OLD_ARN,
      ...(oldBus !== undefined && { oldExtra: { EventBusName: oldBus } }),
      ...(newBus !== undefined && { newExtra: { EventBusName: newBus } }),
    });

    beforeEach(() => {
      h = makeHarness(RULE);
    });

    it('refuses before PutRule when a rule of that name exists on the new bus', async () => {
      h.importResult = { physicalId: THEIR_ARN };

      const err = await provision(makeEngine(h), rule('busA', 'busB'));

      expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(err!.message).toContain('to bus "busB"');
      expect(h.callOrder).toEqual(['import']);
      expect(h.provider.import).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ Name: 'my-rule', EventBusName: 'busB' }),
        })
      );
    });

    it('proceeds when the new bus holds no rule of that name', async () => {
      h.importResult = null;
      h.createIds = [THEIR_ARN];

      const err = await provision(makeEngine(h), rule('busA', 'busB'));

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['import', 'create', 'delete']);
    });

    it('says the rule name is held on the new bus, not that the bus is held', async () => {
      h.importResult = { physicalId: THEIR_ARN };

      const err = await provision(makeEngine(h), rule('busA', 'busB'));

      expect(err!.message).toContain(
        'moves rule "my-rule" from bus "busA" to bus "busB", where another rule already holds that name'
      );
      expect(err!.message).not.toContain('is held by ANOTHER existing resource');
    });

    it('creates first when a recreate moves the rule to a free bus', async () => {
      h.importResult = null;
      h.createIds = [THEIR_ARN];

      const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), rule('busA', 'busB'));

      expect(err).toBeNull();
      expect(h.callOrder).toEqual(['import', 'create', 'delete']);
    });

    it('reads a bus ARN as its name, and an absent bus as default (no move)', async () => {
      h.createIds = [THEIR_ARN];
      await provision(
        makeEngine(h),
        rule('arn:aws:events:us-east-1:123456789012:event-bus/busA', 'busA')
      );
      await provision(makeEngine(h), rule(undefined, 'default'));

      expect(h.provider.import).not.toHaveBeenCalled();
    });
  });

  it('refuses an ECS cluster rename onto an ACTIVE cluster before CreateCluster adopts it', async () => {
    h = makeHarness('AWS::ECS::Cluster');
    h.importResult = { physicalId: 'their-cluster' };

    const err = await provision(makeEngine(h), {
      type: 'AWS::ECS::Cluster',
      nameProperty: 'ClusterName',
      recorded: 'my-cluster',
      desired: 'their-cluster',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('another existing resource (their-cluster)');
    expect(err!.message).toContain('Nothing was created or deleted');
    expect(h.callOrder).toEqual(['import']);
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: 'AWS::ECS::Cluster',
        properties: expect.objectContaining({ ClusterName: 'their-cluster' }),
      })
    );
  });

  it('proceeds with an ECS cluster rename onto a free name (negative control)', async () => {
    h = makeHarness('AWS::ECS::Cluster');
    h.importResult = null;
    h.createIds = ['free-cluster'];

    const err = await provision(makeEngine(h), {
      type: 'AWS::ECS::Cluster',
      nameProperty: 'ClusterName',
      recorded: 'my-cluster',
      desired: 'free-cluster',
    });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['import', 'create', 'delete']);
  });

  it('refuses an S3 bucket rename onto a bucket that already exists', async () => {
    h = makeHarness('AWS::S3::Bucket');
    h.importResult = { physicalId: 'their-bucket' };

    const err = await provision(makeEngine(h, { forceStatefulRecreation: true }), {
      type: 'AWS::S3::Bucket',
      nameProperty: 'BucketName',
      recorded: 'my-bucket',
      desired: 'their-bucket',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('another existing resource (their-bucket)');
    expect(h.callOrder).toEqual(['import']);
  });

  it('probes a Type change onto a name-adopting type even under the same name', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:123456789012:x';
    h.importResult = { physicalId: THEIRS.replace('their-queue', 'x') };

    const err = await provision(makeEngine(h), {
      type: QUEUE,
      nameProperty: 'QueueName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: 'x',
      physicalId: topicArn,
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('still refuses a Type change whose probe finds an id equal to the old resource of the other type', async () => {
    // Two namespaces: an equal id across two types is two resources.
    h.importResult = { physicalId: OLD_URL };

    const err = await provision(makeEngine(h), {
      type: QUEUE,
      nameProperty: 'QueueName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'my-queue',
      desired: 'my-queue',
      physicalId: OLD_URL,
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses an S3 rename onto a bucket another account owns as held, not as "re-run"', async () => {
    h = makeHarness('AWS::S3::Bucket');
    h.importResult = Object.assign(new Error('Forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    });

    const err = await provision(makeEngine(h, { forceStatefulRecreation: true }), {
      type: 'AWS::S3::Bucket',
      nameProperty: 'BucketName',
      recorded: 'my-bucket',
      desired: 'their-bucket',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain(
      'S3 answered 403 Forbidden for bucket their-bucket: another account owns that name, or a ' +
        'bucket of this account denies this identity `s3:ListBucket`, or the request\'s ' +
        'credentials were rejected. Nothing was created or deleted.'
    );
    expect(err!.message).not.toContain('held by ANOTHER existing resource');
    expect(err!.message).not.toContain('Re-run the deploy once the check can succeed');
    expect(h.callOrder).toEqual(['import']);
  });

  it('sends an S3 credential failure to the "could not check … re-run" refusal', async () => {
    h = makeHarness('AWS::S3::Bucket');
    h.importResult = Object.assign(new Error('The provided token has expired.'), {
      name: 'ExpiredToken',
      $metadata: { httpStatusCode: 403 },
    });

    const err = await provision(makeEngine(h, { forceStatefulRecreation: true }), {
      type: 'AWS::S3::Bucket',
      nameProperty: 'BucketName',
      recorded: 'my-bucket',
      desired: 'their-bucket',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('Re-run the deploy once the check can succeed');
    expect(err!.message).not.toContain('S3 answered 403 Forbidden');
    expect(h.callOrder).toEqual(['import']);
  });

  it('refuses a Type change onto Step Functions whose old ARN is in another region', async () => {
    h = makeHarness('AWS::StepFunctions::StateMachine');

    const err = await provision(makeEngine(h), {
      type: 'AWS::StepFunctions::StateMachine',
      nameProperty: 'StateMachineName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: 'x',
      physicalId: 'arn:aws:sns:eu-west-1:123456789012:x',
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(err!.message).toContain('cannot check whether another resource already holds it');
    expect(h.callOrder).toEqual([]);
  });

  it('proceeds on a Type change onto an adopting type when the probe finds nothing', async () => {
    h.importResult = null;
    h.createIds = [THEIRS.replace('their-queue', 'x')];

    const err = await provision(makeEngine(h), {
      type: QUEUE,
      nameProperty: 'QueueName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: 'x',
      physicalId: 'arn:aws:sns:us-east-1:123456789012:x',
    });

    expect(err).toBeNull();
    expect(h.callOrder).toEqual(['import', 'create', 'delete']);
  });

  it('keeps a Type change onto a NON-adopting type in its old order under the same name', async () => {
    h = makeHarness('AWS::Lambda::Function');

    const err = await provision(makeEngine(h, { recreateViaSdkProvider: true }), {
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: 'x',
      physicalId: 'arn:aws:sns:us-east-1:123456789012:x',
    });

    expect(err).toBeNull();
    expect(h.provider.import).not.toHaveBeenCalled();
    // No name change is read for a non-adopting type: destroy-then-create.
    expect(h.callOrder).toEqual(['delete', 'create']);
  });

  it('does not probe a Type change whose name is an unresolved reference', async () => {
    const err = await provision(makeEngine(h), {
      type: QUEUE,
      nameProperty: 'QueueName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: '{{resolve:ssm:queue-name}}',
      physicalId: 'arn:aws:sns:us-east-1:123456789012:x',
    });

    expect(err).toBeNull();
    expect(h.provider.import).not.toHaveBeenCalled();
  });

  it("derives a Type-changed state machine's ARN from the old resource's ARN", async () => {
    h = makeHarness('AWS::StepFunctions::StateMachine');
    h.importResult = null;
    h.createIds = ['arn:aws:states:us-east-1:123456789012:stateMachine:x'];

    const err = await provision(makeEngine(h), {
      type: 'AWS::StepFunctions::StateMachine',
      nameProperty: 'StateMachineName',
      oldType: 'AWS::SNS::Topic',
      oldNameProperty: 'TopicName',
      recorded: 'x',
      desired: 'x',
      physicalId: 'arn:aws:sns:us-east-1:123456789012:x',
    });

    expect(err).toBeNull();
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({
        knownPhysicalId: 'arn:aws:states:us-east-1:123456789012:stateMachine:x',
      })
    );
  });

  it('reads the legacy queue URL host of the OLD queue as the old queue', async () => {
    h.importResult = {
      physicalId: 'https://us-east-1.queue.amazonaws.com/123456789012/my-queue',
    };

    const err = await provision(makeEngine(h), queue('their-queue', { replacement: false }));

    expect(err).toBeNull();
    // The old order: the name was the old queue's after all.
    expect(h.callOrder).toEqual(['update', 'import', 'delete', 'create']);
  });

  it("asks Step Functions by the ARN the new name takes in the old one's account", async () => {
    h = makeHarness('AWS::StepFunctions::StateMachine');
    const oldArn = 'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm';
    const theirArn = 'arn:aws:states:us-east-1:123456789012:stateMachine:their-sm';
    h.importResult = { physicalId: theirArn };

    const err = await provision(makeEngine(h), {
      type: 'AWS::StepFunctions::StateMachine',
      nameProperty: 'StateMachineName',
      recorded: 'my-sm',
      desired: 'their-sm',
      physicalId: oldArn,
    });

    expect(err!.code).toBe('NAMED_REPLACEMENT_COLLISION');
    expect(h.provider.import).toHaveBeenCalledWith(
      expect.objectContaining({ knownPhysicalId: theirArn })
    );
    expect(h.callOrder).toEqual(['import']);
  });
});
