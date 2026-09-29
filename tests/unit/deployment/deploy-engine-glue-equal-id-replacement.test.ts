import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

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
    // Identity, except the NEW template's `DatabaseName: { Ref: 'Db' }`, which
    // resolves to `my|db`: the engine must compare the RESOLVED bag, and a
    // literal in the template could not tell resolved from desired.
    resolve: vi.fn().mockImplementation((value: unknown) => {
      const mapRef = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(mapRef);
        if (v !== null && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (Object.keys(o).length === 1 && o['Ref'] === 'Db') return 'my|db';
          return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, mapRef(x)]));
        }
        return v;
      };
      return Promise.resolve(mapRef(value));
    }),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock('../../../src/deployment/resource-deadline.js', () => ({
  withResourceDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

type StateRecord = {
  physicalId: string;
  resourceType: string;
  properties: Record<string, unknown>;
  attributes: Record<string, unknown>;
  dependencies: string[];
  provisionedBy?: 'sdk' | 'cc-api';
};

/**
 * Issue #3892: a Glue table's id `<databaseName>|<tableName>` is placed by the
 * recorded DatabaseName, and either name may carry `|`. So table `db|orders`
 * in database `my` and table `orders` in database `my|db` share the id
 * `my|db|orders`. A replacement that changes BOTH names creates a genuinely NEW
 * table under the old id. The engine's name-idempotent guards read an equal id
 * as "the create returned the existing resource" — true for every other type,
 * wrong here. They must compare the two halves' DatabaseName: a different
 * database is a different table, the create was genuine, and the old table is
 * deleted through its OWN record.
 *
 * Every case pairs with a CONTROL (same database) that keeps the pre-#3892
 * refusal, so a guard that stopped firing altogether would fail one of them.
 */
describe('DeployEngine — an equal Glue table id that names a different table (issue #3892)', () => {
  const TYPE = 'AWS::Glue::Table';
  const ID = 'my|db|orders';
  const OLD = { DatabaseName: 'my', TableInput: { Name: 'db|orders', Description: 'old' } };
  // The template's NEW bag carries an intrinsic; the resolver makes it `my|db`.
  const NEW = { DatabaseName: { Ref: 'Db' }, TableInput: { Name: 'orders', Description: 'new' } };
  const NEW_RESOLVED = { DatabaseName: 'my|db', TableInput: { Name: 'orders', Description: 'new' } };
  // Control: the same database, so an equal id IS the same table.
  const SAME_DB_OLD = { DatabaseName: 'mydb', TableInput: { Name: 't', Description: 'old' } };
  const SAME_DB_NEW = { DatabaseName: 'mydb', TableInput: { Name: 't', Description: 'new' } };

  let provider: ResourceProvider;
  let callOrder: string[];

  beforeEach(() => {
    callOrder = [];
    provider = {
      // Glue's CreateTable is not name-idempotent in either case below: the
      // id it returns is simply the one both records share.
      create: vi.fn().mockImplementation(async () => {
        callOrder.push('create');
        return { physicalId: ID, attributes: {} };
      }),
      update: vi.fn(),
      delete: vi.fn().mockImplementation(async () => {
        callOrder.push('delete');
      }),
      getAttribute: vi.fn(),
    };
  });

  function makeEngine(
    opts: { replace?: boolean; recreateViaSdk?: boolean } = {}
  ): InstanceType<typeof DeployEngine> {
    const mockStateBackend = { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag-2') };
    const mockLockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const mockDagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    };
    const mockDiffCalculator = {
      calculateDiff: vi.fn().mockResolvedValue(new Map<string, ResourceChange>()),
      hasChanges: vi.fn().mockReturnValue(false),
      filterByType: vi.fn().mockReturnValue([]),
    };
    const mockProviderRegistry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' as const }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    };
    return new DeployEngine(
      mockStateBackend as unknown as never,
      mockLockManager as unknown as never,
      mockDagBuilder as unknown as never,
      mockDiffCalculator as unknown as never,
      mockProviderRegistry as unknown as never,
      {
        // A table is stateful; consent is what lets the replacement run at all.
        forceStatefulRecreation: true,
        ...(opts.replace !== undefined && { replace: opts.replace }),
        ...(opts.recreateViaSdk && {
          recreateTargets: {
            stackName: 'MyStack',
            viaCcApi: new Set<string>(),
            viaSdkProvider: new Set(['Table']),
          },
        }),
      },
      'us-east-1'
    );
  }

  async function invokeProvision(
    engine: InstanceType<typeof DeployEngine>,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
    { retain = false, inPlace = false }: { retain?: boolean; inPlace?: boolean } = {}
  ): Promise<Record<string, StateRecord>> {
    const change: ResourceChange = {
      logicalId: 'Table',
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: oldProps,
      desiredProperties: newProps,
      propertyChanges: [
        {
          path: 'DatabaseName',
          oldValue: oldProps['DatabaseName'],
          newValue: newProps['DatabaseName'],
          // `inPlace`: the diff planned an UPDATE, and the provider's refusal
          // is what sends the engine to its update-unsupported fallback.
          requiresReplacement: !inPlace,
        },
      ],
    };
    const stateResources: Record<string, StateRecord> = {
      Table: {
        physicalId: ID,
        resourceType: TYPE,
        properties: oldProps,
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Table: {
          Type: TYPE,
          Properties: newProps,
          ...(retain && { UpdateReplacePolicy: 'Retain' }),
        },
      },
    };
    const provisionResource = (
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
    await provisionResource('Table', change, stateResources, 'MyStack', template);
    return stateResources;
  }

  function codeOf(err: unknown): string | undefined {
    const e = err as { code?: string; cause?: { code?: string } } | null;
    return e?.cause?.code ?? e?.code;
  }

  describe('create-first replacement', () => {
    it('keeps the new table and deletes the old one through ITS record', async () => {
      const state = await invokeProvision(makeEngine(), OLD, NEW);

      expect(callOrder).toEqual(['create', 'delete']);
      // The delete is addressed with the OLD record's bag, which anchors the
      // id on database `my` — the old table, not the one just created.
      expect(provider.delete).toHaveBeenCalledWith(
        'Table',
        ID,
        TYPE,
        OLD,
        expect.anything()
      );
      expect(state['Table']!.physicalId).toBe(ID);
      expect(state['Table']!.properties).toEqual(NEW_RESOLVED);
    });

    it('CONTROL: the same database keeps the name-idempotent refusal', async () => {
      const err = await invokeProvision(makeEngine(), SAME_DB_OLD, SAME_DB_NEW).then(
        () => null,
        (e: unknown) => e
      );

      expect(codeOf(err)).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
      expect(provider.delete).not.toHaveBeenCalled();
    });
  });

  describe('create-first replacement under UpdateReplacePolicy: Retain', () => {
    it('keeps the new table and retains the old one, with no refusal', async () => {
      const state = await invokeProvision(makeEngine(), OLD, NEW, { retain: true });

      expect(callOrder).toEqual(['create']);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(state['Table']!.properties).toEqual(NEW_RESOLVED);
    });

    it('CONTROL: the same database keeps the Retain refusal', async () => {
      const err = await invokeProvision(makeEngine(), SAME_DB_OLD, SAME_DB_NEW, {
        retain: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(codeOf(err)).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    });
  });

  describe('flagged recreate (destroy-then-create) under UpdateReplacePolicy: Retain', () => {
    it('accepts the new table under the shared id', async () => {
      const state = await invokeProvision(makeEngine({ recreateViaSdk: true }), OLD, NEW, {
        retain: true,
      });

      expect(provider.delete).not.toHaveBeenCalled();
      expect(state['Table']!.properties).toEqual(NEW_RESOLVED);
    });

    it('CONTROL: the same database keeps the recreate refusal', async () => {
      const err = await invokeProvision(
        makeEngine({ recreateViaSdk: true }),
        SAME_DB_OLD,
        SAME_DB_NEW,
        { retain: true }
      ).then(
        () => null,
        (e: unknown) => e
      );

      expect(codeOf(err)).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    });
  });

  // The update-unsupported fallback (`--replace` after the provider refuses an
  // in-place update) has its own Retain arm with the same id comparison.
  describe('update-unsupported fallback under --replace and UpdateReplacePolicy: Retain', () => {
    beforeEach(() => {
      provider.update = vi.fn().mockImplementation(async () => {
        callOrder.push('update');
        throw new ResourceUpdateNotSupportedError(TYPE, 'Table', 'refused in place');
      });
    });

    it('accepts the new table under the shared id', async () => {
      const state = await invokeProvision(makeEngine({ replace: true }), OLD, NEW, {
        retain: true,
        inPlace: true,
      });

      expect(callOrder).toEqual(['update', 'create']);
      expect(provider.delete).not.toHaveBeenCalled();
      expect(state['Table']!.properties).toEqual(NEW_RESOLVED);
    });

    it('CONTROL: the same database keeps the refusal', async () => {
      const err = await invokeProvision(makeEngine({ replace: true }), SAME_DB_OLD, SAME_DB_NEW, {
        retain: true,
        inPlace: true,
      }).then(
        () => null,
        (e: unknown) => e
      );

      expect(callOrder).toEqual(['update', 'create']);
      expect(codeOf(err)).toBe('NAMED_REPLACEMENT_IDEMPOTENT_CREATE');
    });
  });
});
