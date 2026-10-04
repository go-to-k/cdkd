/**
 * Issue #3932: a Glue table replacement whose create-first `CreateTable` meets
 * an occupied address. The provider used to reword `AlreadyExistsException` so
 * the engine never saw a collision, which also took the `--replace` recovery
 * away from a replacement that KEEPS the address (a top-level `Name` change,
 * whose collision is with the old table itself). Now the provider relays the
 * error and the engine's holder proof decides: it lets `--replace` delete the
 * old table first only when that table holds the address the create sent, and
 * refuses a rename, another database or another Data Catalog with nothing
 * deleted.
 *
 * Driven through the REAL `DeployEngine.provisionResource` and the REAL
 * `GlueProvider`; only the Glue client's `send` is stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockGlueSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import {
  AlreadyExistsException,
  CreateTableCommand,
  DeleteTableCommand,
} from '@aws-sdk/client-glue';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

const TYPE = 'AWS::Glue::Table';
const LID = 'Table';
const OLD = {
  CatalogId: '123456789012',
  DatabaseName: 'db',
  TableInput: { Name: 't', TableType: 'EXTERNAL_TABLE' },
};

type StateRecord = { physicalId: string; properties: Record<string, unknown> };

/** The Glue WRITE commands `send` was called with, in order (reads omitted). */
function sentCommands(): string[] {
  return mockGlueSend.mock.calls
    .map((c) => (c[0] as object).constructor.name)
    .filter((name) => !name.startsWith('Get'));
}

function makeEngine(replace: boolean): InstanceType<typeof DeployEngine> {
  const provider = new GlueProvider();
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
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as unknown as never,
    // A table is stateful: the data-loss consent is not what is under test.
    { replace, forceStatefulRecreation: true },
    'us-east-1'
  );
}

/** One planned replacement of the table; resolves to the error, or null. */
async function replaceTable(
  newProps: Record<string, unknown>,
  changedPath: string,
  replace: boolean
): Promise<{ error: (Error & { code?: string }) | null; state: Record<string, StateRecord> }> {
  const change: ResourceChange = {
    logicalId: LID,
    changeType: 'UPDATE',
    resourceType: TYPE,
    currentProperties: OLD,
    desiredProperties: newProps,
    propertyChanges: [
      {
        path: changedPath,
        oldValue: (OLD as Record<string, unknown>)[changedPath],
        newValue: newProps[changedPath],
        requiresReplacement: true,
      },
    ],
  };
  const state: Record<string, StateRecord & Record<string, unknown>> = {
    [LID]: {
      physicalId: 'db|t',
      resourceType: TYPE,
      properties: OLD,
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    },
  };
  const template: CloudFormationTemplate = {
    Resources: { [LID]: { Type: TYPE, Properties: newProps } },
  };
  const engine = makeEngine(replace);
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
  const error = await run(LID, change, state, 'MyStack', template).then(
    () => null,
    (e: unknown) => ((e as { cause?: unknown }).cause ?? e) as Error & { code?: string }
  );
  return { error, state };
}

const occupied = () =>
  new AlreadyExistsException({ message: 'Table already exists.', $metadata: {} });

describe('a Glue table replacement meeting an occupied address (issue #3932)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
  });

  describe('the address is the old table itself (a top-level Name change)', () => {
    const NEW = { ...OLD, Name: 't-identifier' };

    it('--replace deletes the old table first and re-creates it', async () => {
      // The create-first attempt collides with the old table; the re-create
      // after the delete succeeds.
      mockGlueSend.mockImplementation(async (command: object) => {
        if (command instanceof CreateTableCommand) {
          if (mockGlueSend.mock.calls.filter((c) => c[0] instanceof CreateTableCommand).length === 1)
            throw occupied();
          return {};
        }
        if (command instanceof DeleteTableCommand) return {};
        // The post-create read-back; its answer is not under test.
        return {};
      });

      const { error, state } = await replaceTable(NEW, 'Name', true);

      // THE DISCRIMINATOR: before #3932 the provider's reworded error escaped
      // here and nothing could perform the replacement.
      expect(error).toBeNull();
      expect(sentCommands()).toEqual([
        'CreateTableCommand',
        'DeleteTableCommand',
        'CreateTableCommand',
      ]);
      expect(mockGlueSend.mock.calls[1]![0].input).toEqual({
        CatalogId: '123456789012',
        DatabaseName: 'db',
        Name: 't',
      });
      expect(state[LID]!.physicalId).toBe('db|t');
      expect(state[LID]!.properties).toEqual(NEW);
    });

    it('without --replace, the refusal names the collision and offers --replace', async () => {
      mockGlueSend.mockRejectedValueOnce(occupied());

      const { error } = await replaceTable(NEW, 'Name', false);

      expect(error?.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(error!.message).toContain(
        'Table (AWS::Glue::Table) requires replacement, but the create-first attempt collided ' +
          'with the existing resource: Failed to create Glue Table Table: Table already exists.'
      );
      expect(error!.message).toContain('re-run with `cdkd deploy --replace`');
      expect(sentCommands()).toEqual(['CreateTableCommand']);
    });
  });

  // Each of these moves the address, so the holder is another table: deleting
  // the old one first would destroy it and collide again.
  describe.each([
    ['a TableInput.Name rename', { ...OLD, TableInput: { ...OLD.TableInput, Name: 'u' } }, 'TableInput'],
    ['another database', { ...OLD, DatabaseName: 'other' }, 'DatabaseName'],
    ['another Data Catalog', { ...OLD, CatalogId: '210987654321' }, 'CatalogId'],
  ])('%s onto an occupied address', (_label, newProps, changedPath) => {
    it('--replace is refused with nothing deleted', async () => {
      mockGlueSend.mockRejectedValueOnce(occupied());

      const { error } = await replaceTable(newProps, changedPath, true);

      expect(error?.code).toBe('NAMED_REPLACEMENT_COLLISION');
      expect(error!.message).toContain('--replace was NOT applied and nothing was deleted');
      expect(error!.message).toContain(
        'Underlying collision: Failed to create Glue Table Table: Table already exists.'
      );
      expect(sentCommands()).toEqual(['CreateTableCommand']);
    });
  });
});
