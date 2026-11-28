import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const debugLog = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugLog,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  GetSchemaCreationStatusCommand,
  StartSchemaCreationCommand,
} from '@aws-sdk/client-appsync';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { setResolvedResourceTimeouts } from '../../../src/provisioning/resource-timeout-registry.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import { SCHEMA_WAIT_MAX_MS } from '../../../src/provisioning/providers/appsync/schema-wait.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';

const TYPE = 'AWS::AppSync::GraphQLSchema';
const V1 = 'type Query { a: String }';
const V2 = 'type Query { a: String  b: String }';
const BAD_DETAILS =
  "Found 1 problem(s) with the schema:\nThe field type 'NoSuchType' is not present when resolving type 'Query'.";

/** Answers StartSchemaCreation with PROCESSING and each status read with the next entry. */
function armStatuses(
  statuses: Array<Record<string, unknown> | Error>,
  started: Record<string, unknown> = { status: 'PROCESSING' }
): void {
  const queue = [...statuses];
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof StartSchemaCreationCommand) return started;
    if (command instanceof GetSchemaCreationStatusCommand) {
      const next = queue.shift();
      if (next === undefined) throw new Error('test: status read past the armed answers');
      if (next instanceof Error) throw next;
      return next;
    }
    throw new Error(`test: unexpected ${String((command as object).constructor.name)}`);
  });
}

function sentNames(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

describe('AppSync GraphQLSchema waits for the schema it submitted (#7127)', () => {
  let provider: AppSyncProvider;
  let clock: number;
  let sleeps: number[];

  beforeEach(() => {
    mockSend.mockReset();
    debugLog.mockReset();
    provider = new AppSyncProvider();
    clock = 0;
    sleeps = [];
    provider.now = () => clock;
    provider.sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
  });

  afterEach(() => {
    setResolvedResourceTimeouts(undefined);
  });

  it('create returns only once the status leaves PROCESSING for SUCCESS', async () => {
    armStatuses([{ status: 'PROCESSING' }, { status: 'PROCESSING' }, { status: 'SUCCESS' }]);
    const result = await provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 });
    expect(result.physicalId).toBe('api-1');
    expect(sentNames()).toEqual([
      'StartSchemaCreationCommand',
      'GetSchemaCreationStatusCommand',
      'GetSchemaCreationStatusCommand',
      'GetSchemaCreationStatusCommand',
    ]);
    expect(mockSend.mock.calls[1]![0].input).toEqual({ apiId: 'api-1' });
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  it('a schema AppSync refuses fails the create, AWS details withheld from the message', async () => {
    armStatuses([{ status: 'PROCESSING' }, { status: 'FAILED', details: BAD_DETAILS }]);
    const error = await provider
      .create('Schema', TYPE, { ApiId: 'api-1', Definition: 'type Query { a: NoSuchType }' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain('GraphQL schema Schema create failed: AWS AppSync reports FAILED');
    expect(message).not.toContain('NoSuchType');
    // AWS's text reaches the debug log and the cause chain.
    expect(debugLog.mock.calls.some((c) => String(c[0]).includes('NoSuchType'))).toBe(true);
    expect(((error as Error).cause as Error).message).toBe(BAD_DETAILS);
  });

  it('update waits too, and a refused schema fails the update', async () => {
    armStatuses([{ status: 'PROCESSING' }, { status: 'SUCCESS' }]);
    await provider.update(
      'Schema',
      'api-1',
      TYPE,
      { ApiId: 'api-1', Definition: V2 },
      { ApiId: 'api-1', Definition: V1 }
    );
    expect(sentNames().filter((n) => n === 'GetSchemaCreationStatusCommand')).toHaveLength(2);

    mockSend.mockReset();
    armStatuses([{ status: 'FAILED', details: BAD_DETAILS }]);
    await expect(
      provider.update(
        'Schema',
        'api-1',
        TYPE,
        { ApiId: 'api-1', Definition: 'type Query { a: NoSuchType }' },
        { ApiId: 'api-1', Definition: V2 }
      )
    ).rejects.toThrow(/GraphQL schema Schema update failed: AWS AppSync reports FAILED/);
  });

  it('an unchanged definition submits nothing and reads no status', async () => {
    armStatuses([]);
    await provider.update(
      'Schema',
      'api-1',
      TYPE,
      { ApiId: 'api-1', Definition: V1 },
      { ApiId: 'api-1', Definition: V1 }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(['NOT_APPLICABLE', 'DELETING'])('%s right after a start fails the resource', async (status) => {
    armStatuses([{ status }]);
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).rejects.toThrow(`AWS AppSync reports ${status}`);
  });

  it('ACTIVE counts as applied', async () => {
    armStatuses([{ status: 'ACTIVE' }]);
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).resolves.toMatchObject({ physicalId: 'api-1' });
  });

  it('a throttled status read re-polls', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    armStatuses([throttled, { status: 'SUCCESS' }]);
    await provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 });
    expect(sentNames().filter((n) => n === 'GetSchemaCreationStatusCommand')).toHaveLength(2);
  });

  it('a non-transient status read failure fails the resource as a ProvisioningError', async () => {
    const denied = Object.assign(new Error(
      'User: arn:aws:sts::123456789012:assumed-role/X/y is not authorized to perform: appsync:GetSchemaCreationStatus'
    ), {
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: { httpStatusCode: 403 },
    });
    armStatuses([denied]);
    const error = await provider
      .create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as Error).message).toContain('Failed to read the schema status of GraphQL schema Schema');
    // #2319: the caller's ARN in AWS's text is withheld from the persisted message.
    expect((error as Error).message).not.toContain('arn:aws:sts');
  });

  it('gives up at its cap; an explicit --resource-timeout only lowers it, to half of it', async () => {
    armStatuses(Array.from({ length: 1_000 }, () => ({ status: 'PROCESSING' })));
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).rejects.toThrow(
      `was not applied within ${SCHEMA_WAIT_MAX_MS / 1000}s of its create (last status: PROCESSING). ` +
        "AppSync may still be applying it: check 'aws appsync get-schema-creation-status --api-id api-1'"
    );
    expect(clock).toBe(SCHEMA_WAIT_MAX_MS);

    mockSend.mockReset();
    clock = 0;
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 60_000 } });
    armStatuses(Array.from({ length: 1_000 }, () => ({ status: 'PROCESSING' })));
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).rejects.toThrow('was not applied within 30s of its create');
    expect(clock).toBe(30_000);

    // A raised timeout never shortens the wait, nor lengthens it past the cap.
    mockSend.mockReset();
    clock = 0;
    setResolvedResourceTimeouts({ perTypeMs: { [TYPE]: 20 * 60_000 } });
    armStatuses(Array.from({ length: 1_000 }, () => ({ status: 'PROCESSING' })));
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).rejects.toThrow('was not applied within 600s of its create');
    mockSend.mockReset();
    clock = 0;
    setResolvedResourceTimeouts({ globalMs: 4 * SCHEMA_WAIT_MAX_MS });
    armStatuses(Array.from({ length: 1_000 }, () => ({ status: 'PROCESSING' })));
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
    ).rejects.toThrow(`was not applied within ${SCHEMA_WAIT_MAX_MS / 1000}s of its create`);
  });

  it.each(['FAILED', 'NOT_APPLICABLE', 'DELETING', 'SUCCESS'])(
    'a %s start answer decides nothing: the poll does',
    async (startStatus) => {
      armStatuses([{ status: 'PROCESSING' }, { status: 'SUCCESS' }], { status: startStatus });
      await provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 });
      expect(sentNames()).toEqual([
        'StartSchemaCreationCommand',
        'GetSchemaCreationStatusCommand',
        'GetSchemaCreationStatusCommand',
      ]);
    }
  );

  it('the timeout message names the API id through the masker', async () => {
    armStatuses(Array.from({ length: 1_000 }, () => ({ status: 'PROCESSING' })));
    const maskSecrets = (text: string): string => text.split('api-1').join('***');
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 }, { maskSecrets })
    ).rejects.toThrow("get-schema-creation-status --api-id ***'");
  });

  it('waits on the DefinitionS3Location path, create and update', async () => {
    provider.fetchS3LocationBody = vi.fn(async () => V2);
    armStatuses([{ status: 'PROCESSING' }, { status: 'SUCCESS' }]);
    await provider.create('Schema', TYPE, { ApiId: 'api-1', DefinitionS3Location: 's3://b/v1.graphql' });
    expect(sentNames()).toEqual([
      'StartSchemaCreationCommand',
      'GetSchemaCreationStatusCommand',
      'GetSchemaCreationStatusCommand',
    ]);

    mockSend.mockReset();
    armStatuses([{ status: 'FAILED', details: BAD_DETAILS }]);
    await expect(
      provider.update(
        'Schema',
        'api-1',
        TYPE,
        { ApiId: 'api-1', DefinitionS3Location: 's3://b/v2.graphql' },
        { ApiId: 'api-1', DefinitionS3Location: 's3://b/v1.graphql' }
      )
    ).rejects.toThrow('GraphQL schema Schema update failed: AWS AppSync reports FAILED');
    expect(sentNames()).toEqual(['StartSchemaCreationCommand', 'GetSchemaCreationStatusCommand']);
  });

  it('a create that submits no schema (empty Definition, no S3 location) reads no status', async () => {
    armStatuses([]);
    await expect(
      provider.create('Schema', TYPE, { ApiId: 'api-1', Definition: '' })
    ).resolves.toMatchObject({ physicalId: 'api-1' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('Ctrl-C', () => {
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      interruptWatchTestSeam.forceQuit = vi.fn();
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
      delete interruptWatchTestSeam.forceQuit;
    });

    it('stops the wait with an interrupt, not a timeout', async () => {
      const baseline = process.listeners('SIGINT');
      provider.sleep = async () => {
        for (const l of process.listeners('SIGINT').filter((x) => !baseline.includes(x))) {
          (l as () => void)();
        }
      };
      armStatuses(Array.from({ length: 10 }, () => ({ status: 'PROCESSING' })));
      const error = await provider
        .create('Schema', TYPE, { ApiId: 'api-1', Definition: V1 })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(sentNames().filter((n) => n === 'GetSchemaCreationStatusCommand')).toHaveLength(1);
    });
  });
});

describe('drift heals a pre-#7127 schema baseline', () => {
  const STALE = { ApiId: 'api-1', Definition: 'type Query {\n  a: String\n}' };

  it('skips Definition while the live SDL is the declared one', () => {
    const declared = { ApiId: 'api-1', Definition: V2 };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, STALE, declared, { ...declared })).toEqual([
      'Definition',
    ]);
  });

  it('keeps it compared when the live SDL differs from the declared one', () => {
    const declared = { ApiId: 'api-1', Definition: V2 };
    expect(
      preFixBaselineUncomparedDriftKeys(TYPE, STALE, declared, {
        ApiId: 'api-1',
        Definition: 'type Query {\n  c: String\n}',
      })
    ).toEqual([]);
  });

  it('leaves an S3-sourced schema to the provider pair hook (no declared SDL here, #7139)', () => {
    const declared = { ApiId: 'api-1', DefinitionS3Location: 's3://b/k.graphql' };
    expect(
      preFixBaselineUncomparedDriftKeys(TYPE, STALE, declared, {
        ApiId: 'api-1',
        Definition: STALE.Definition,
      })
    ).toEqual([]);
  });
});
