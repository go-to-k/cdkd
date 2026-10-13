import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier Lambda function (only `'different'` lets
// it delete), and the `<FunctionArn>@<LastModified>` token a failed CREATE
// journals beside the orphan's function name for the settle to compare, so a
// function re-created under the name is never deleted as the orphan.

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

// Not a `LambdaClient`, so `LambdaCreateClientCache` sends CreateFunction
// through this same double.
const sharedClient = vi.hoisted(() => ({
  send: mockSend,
  config: { region: () => Promise.resolve(clientRegion.value) },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ lambda: sharedClient, ec2: { send: vi.fn() } }),
}));

import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  PutFunctionConcurrencyCommand,
  PutRuntimeManagementConfigCommand,
  ResourceConflictException,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import { withPrintingSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { recordLogOnlyValue, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const TYPE = 'AWS::Lambda::Function';
const CTX = { expectedRegion: 'us-east-1' };
const arnOf = (name: string): string => `arn:aws:lambda:us-east-1:123456789012:function:${name}`;
// Lambda's own `LastModified` spelling (`+0000`, no colon).
const T1 = '2026-10-13T03:45:50.123+0000';
const T1_MS = Date.parse('2026-10-13T03:45:50.123Z');
const T2 = '2026-10-13T04:00:00.000+0000';
const tokenOf = (name: string, ms: number): string => `${arnOf(name)}@${ms}`;

const notFound = (name: string): Error =>
  new ResourceNotFoundException({
    message: `Function not found: ${arnOf(name)}`,
    $metadata: {},
  });

const denied = (op: string): Error =>
  Object.assign(new Error(`User is not authorized to perform: lambda:${op}`), {
    name: 'AccessDeniedException',
  });

/**
 * One function name's GetFunction answer: its `LastModified`, gone, an error,
 * a response naming another function, or one naming no `FunctionArn`.
 */
type Entry = string | 'gone' | Error | { answeredAs: string } | 'no-arn';

/** GetFunction answers per function name, exactly as asked. */
function live(entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof GetFunctionCommand)) throw new Error('unexpected command');
    const asked = cmd.input.FunctionName!;
    const entry = entries[asked];
    if (entry === undefined || entry === 'gone') throw notFound(asked);
    if (entry instanceof Error) throw entry;
    if (entry === 'no-arn') return { Configuration: { FunctionName: asked, LastModified: T1 } };
    if (typeof entry === 'object') {
      return {
        Configuration: {
          FunctionName: entry.answeredAs,
          FunctionArn: arnOf(entry.answeredAs),
          LastModified: T1,
        },
      };
    }
    return { Configuration: { FunctionName: asked, FunctionArn: arnOf(asked), LastModified: entry } };
  });
}

const askedNames = (): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) =>
    cmd instanceof GetFunctionCommand ? cmd.input.FunctionName : `<${String(cmd)}>`
  );

describe('LambdaFunctionProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new LambdaFunctionProvider();
  });

  it('another live function under another name is different', async () => {
    live({ 'fn-a': T1, 'fn-b': T2 });
    await expect(provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)).resolves.toBe(
      'different'
    );
    // The record's function is read first: it must exist for any verdict.
    expect(askedNames()).toEqual(['fn-b', 'fn-a']);
  });

  it('a journaled function AWS reports gone is different once the record reads back', async () => {
    live({ 'fn-b': T2 });
    await expect(provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)).resolves.toBe(
      'different'
    );
  });

  it("the record's function gone is unknown, not different, whatever the journaled one reads", async () => {
    for (const journaled of [T1, 'gone'] as const) {
      mockSend.mockReset();
      live({ 'fn-a': journaled });
      await expect(
        provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
      ).resolves.toBe('unknown');
    }
  });

  it('equal names are the same without a read, even from a client in another region', async () => {
    for (const region of ['us-east-1', 'us-west-2']) {
      clientRegion.value = region;
      live({});
      await expect(
        provider.isSameResource('fn-a', { physicalId: 'fn-a' }, TYPE, CTX)
      ).resolves.toBe('same');
    }
    expect(mockSend).not.toHaveBeenCalled();
  });

  // Not relied on either way: the verdict never rests on Lambda's case rules.
  it('names differing only in case are unknown, with no read', async () => {
    live({ 'My-Fn': T1, 'my-fn': T2 });
    await expect(
      provider.isSameResource('My-Fn', { physicalId: 'my-fn' }, TYPE, CTX)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a read failing other than with ResourceNotFoundException throws (the caller reads it as unknown)', async () => {
    live({ 'fn-a': denied('GetFunction'), 'fn-b': T2 });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('not authorized');
  });

  it("the record's read failing throws before the journaled one is read", async () => {
    live({ 'fn-a': T1, 'fn-b': denied('GetFunction') });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('not authorized');
    expect(askedNames()).toEqual(['fn-b']);
  });

  it('"not found" in the message of another error class never reads as gone', async () => {
    const lookalike = Object.assign(new Error('Function not found: fn-a'), {
      name: 'ServiceException',
    });
    live({ 'fn-a': lookalike, 'fn-b': T2 });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('not found');
  });

  it('a response naming another function, or no FunctionArn, throws rather than comparing it', async () => {
    live({ 'fn-a': { answeredAs: 'someone-else' }, 'fn-b': T2 });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('another function');
    mockSend.mockReset();
    live({ 'fn-a': 'no-arn', 'fn-b': T2 });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('no FunctionArn');
    // The record's side too: no verdict rests on a record without an ARN.
    mockSend.mockReset();
    live({ 'fn-a': T1, 'fn-b': 'no-arn' });
    await expect(
      provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)
    ).rejects.toThrow('no FunctionArn');
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'us-west-2';
    live({ 'fn-a': T1, 'fn-b': T2 });
    await expect(provider.isSameResource('fn-a', { physicalId: 'fn-b' }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an ARN', arnOf('fn-a')],
    ['a qualified name', 'fn-a:prod'],
    ['a name with a dot', 'fn.a'],
    ['an empty id', ''],
    ['a name one past the longest', 'a'.repeat(65)],
  ])('%s on either side is unknown, with no read', async (_label, bad) => {
    live({});
    await expect(provider.isSameResource(bad, { physicalId: 'fn-b' }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    await expect(provider.isSameResource('fn-a', { physicalId: bad }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the longest legal name, and one using every legal character class, are read', async () => {
    const longest = 'a'.repeat(64);
    const mixed = 'My_Fn-v2';
    live({ [longest]: T1, [mixed]: T2 });
    await expect(
      provider.isSameResource(longest, { physicalId: mixed }, TYPE, CTX)
    ).resolves.toBe('different');
    expect(askedNames()).toEqual([mixed, longest]);
  });

  it.each(['AWS::Lambda::Version', 'AWS::DynamoDB::Table'])(
    'another type (%s) is unknown, with no read',
    async (other) => {
      live({ 'fn-a': T1, 'fn-b': T2 });
      await expect(
        provider.isSameResource('fn-a', { physicalId: 'fn-b' }, other, CTX)
      ).resolves.toBe('unknown');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

describe('LambdaFunctionProvider.resourceIdentity (go-to-k/cdkd#4606)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new LambdaFunctionProvider();
  });

  it('is the live `<FunctionArn>@<LastModified epoch ms>`, read under the name as written', async () => {
    live({ 'fn-a': T1 });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).resolves.toBe(
      tokenOf('fn-a', T1_MS)
    );
    expect(askedNames()).toEqual(['fn-a']);
  });

  it('a function re-created under the name (another LastModified) reads another token', async () => {
    live({ 'fn-a': T2 });
    const token = await provider.resourceIdentity('fn-a', TYPE, CTX);
    expect(token).not.toBe(tokenOf('fn-a', T1_MS));
    expect(token).toBe(tokenOf('fn-a', Date.parse('2026-10-13T04:00:00.000Z')));
  });

  it('is RESOURCE_NOT_FOUND on ResourceNotFoundException', async () => {
    live({});
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "not found" in the message included (never gone)', async () => {
    live({ 'fn-a': denied('GetFunction') });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).rejects.toThrow('not authorized');
    mockSend.mockReset();
    live({
      'fn-a': Object.assign(new Error('fn-a not found'), { name: 'ServiceException' }),
    });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).rejects.toThrow('not found');
  });

  it('throws on a response naming no FunctionArn, or another function', async () => {
    live({ 'fn-a': 'no-arn' });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).rejects.toThrow('no FunctionArn');
    mockSend.mockReset();
    live({ 'fn-a': { answeredAs: 'fn-z' } });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).rejects.toThrow(
      'another function'
    );
  });

  it.each([
    ['no LastModified', undefined],
    ['an empty LastModified', ''],
    ['an unparseable LastModified', 'yesterday'],
  ])('is undefined for %s', async (_label, lastModified) => {
    mockSend.mockResolvedValue({
      Configuration: { FunctionName: 'fn-a', FunctionArn: arnOf('fn-a'), LastModified: lastModified },
    });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).resolves.toBeUndefined();
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live({ 'fn-a': T1 });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a function name, or another type', async () => {
    live({ 'fn-a': T1 });
    await expect(provider.resourceIdentity(arnOf('fn-a'), TYPE, CTX)).resolves.toBeUndefined();
    await expect(
      provider.resourceIdentity('fn-a', 'AWS::Lambda::Version', CTX)
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the created-before-failure mark carries CreateFunction's identity (go-to-k/cdkd#4606)", () => {
  const PROPS = {
    FunctionName: 'fn-a',
    Role: 'arn:aws:iam::123456789012:role/r',
    Runtime: 'nodejs20.x',
    Handler: 'index.handler',
    Code: { ZipFile: 'exports.handler = async () => {};' },
    ReservedConcurrentExecutions: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * CreateFunction answers `arn` / `lastModified` on the first call (a later
   * one ResourceConflictException); PutFunctionConcurrency is denied, and so
   * is the atomicity cleanup's DeleteFunction unless `deleteSucceeds`.
   */
  function aws(opts: {
    arn: string | undefined;
    lastModified: string | undefined;
    deleteSucceeds?: boolean;
  }): void {
    let creates = 0;
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd instanceof CreateFunctionCommand) {
        if (creates++ > 0) {
          throw new ResourceConflictException({
            message: 'Function already exist: fn-a',
            $metadata: {},
          });
        }
        return {
          FunctionName: 'fn-a',
          FunctionArn: opts.arn,
          LastModified: opts.lastModified,
          State: 'Pending',
        };
      }
      if (cmd instanceof PutFunctionConcurrencyCommand) throw denied('PutFunctionConcurrency');
      if (cmd instanceof DeleteFunctionCommand) {
        if (opts.deleteSucceeds === true) return {};
        throw denied('DeleteFunction');
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
  }

  const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('the create succeeded');
      },
      (e: unknown) => e
    );

  it("a post-create failure whose cleanup DeleteFunction fails marks the name and CreateFunction's identity", async () => {
    aws({ arn: arnOf('fn-a'), lastModified: T1 });
    const error = await failureOf(new LambdaFunctionProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('fn-a');
    // The create response's token, never a later read's (none is sent).
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(
      tokenOf('fn-a', T1_MS)
    );
    expect(mockSend.mock.calls.some(([c]) => c instanceof GetFunctionCommand)).toBe(false);
  });

  // The token the mark carries and the one `resourceIdentity` reads back must
  // be one spelling, or the settle never proves its own orphan.
  it('the marked token equals the live read of the same function', async () => {
    aws({ arn: arnOf('fn-a'), lastModified: T1 });
    const provider = new LambdaFunctionProvider();
    const error = await failureOf(provider.create('Orphan', TYPE, PROPS));
    mockSend.mockReset();
    live({ 'fn-a': T1 });
    await expect(provider.resourceIdentity('fn-a', TYPE, CTX)).resolves.toBe(
      createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)
    );
  });

  // The retry the failure may trigger replays the create, which fails with
  // ResourceConflictException: the error finally thrown keeps the FIRST
  // attempt's mark, identity included.
  it("a replay failing with ResourceConflictException keeps the first attempt's identity", async () => {
    aws({ arn: arnOf('fn-a'), lastModified: T1 });
    const provider = new LambdaFunctionProvider();
    let attempts = 0;
    const error = await failureOf(
      withRetry(
        () => {
          attempts++;
          return provider.create('Orphan', TYPE, PROPS);
        },
        'Orphan',
        { sleep: async () => {}, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }
      )
    );
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('fn-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(
      tokenOf('fn-a', T1_MS)
    );
    expect(attempts).toBeGreaterThan(1);
  });

  it.each([
    ['no FunctionArn', undefined, T1],
    ['an empty FunctionArn', '', T1],
    ['no LastModified', arnOf('fn-a'), undefined],
    ['an unparseable LastModified', arnOf('fn-a'), 'not-a-time'],
  ])('a CreateFunction response with %s marks the name alone', async (_label, arn, lastModified) => {
    aws({ arn, lastModified });
    const error = await failureOf(new LambdaFunctionProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('fn-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });

  // PutRuntimeManagementConfig is the one post-create call measured to MOVE
  // LastModified (the lambda-fix-forward-orphan fixture's step 1b).
  describe('RuntimeManagementConfig (go-to-k/cdkd#4606)', () => {
    const RT_PROPS = {
      FunctionName: 'fn-a',
      Role: 'arn:aws:iam::123456789012:role/r',
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: 'exports.handler = async () => ({});' },
      RuntimeManagementConfig: { UpdateRuntimeOn: 'FunctionUpdate' },
    };

    function awsRt(putSucceeds: boolean): void {
      mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
        if (cmd instanceof CreateFunctionCommand) {
          return { FunctionName: 'fn-a', FunctionArn: arnOf('fn-a'), LastModified: T1 };
        }
        if (cmd instanceof GetFunctionCommand) {
          return { Configuration: { FunctionName: 'fn-a', State: 'Active' } };
        }
        if (cmd instanceof PutRuntimeManagementConfigCommand) {
          if (putSucceeds) return {};
          throw denied('PutRuntimeManagementConfig');
        }
        if (cmd instanceof DeleteFunctionCommand) throw denied('DeleteFunction');
        throw new Error(`unexpected command ${cmd.constructor.name}`);
      });
    }

    it("a failed PutRuntimeManagementConfig keeps CreateFunction's token on the mark", async () => {
      awsRt(false);
      const error = await failureOf(new LambdaFunctionProvider().create('Orphan', TYPE, RT_PROPS));
      expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('fn-a');
      expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(
        tokenOf('fn-a', T1_MS)
      );
    });

    // Nothing fallible follows the call in `create` today; a failure there is
    // forced through the success line, so a step added later cannot journal
    // the stale token.
    it("a failure after a successful PutRuntimeManagementConfig drops CreateFunction's token", async () => {
      awsRt(true);
      providerLogger.debug.mockImplementation((m: unknown) => {
        if (String(m).includes('Successfully created')) throw new Error('a later step failed');
      });
      try {
        const error = await failureOf(
          new LambdaFunctionProvider().create('Orphan', TYPE, RT_PROPS)
        );
        expect(
          mockSend.mock.calls.some(([c]) => c instanceof PutRuntimeManagementConfigCommand)
        ).toBe(true);
        expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('fn-a');
        expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
      } finally {
        providerLogger.debug.mockReset();
      }
    });
  });

  it('a cleanup DeleteFunction that succeeded marks nothing, identity included', async () => {
    aws({ arn: arnOf('fn-a'), lastModified: T1, deleteSucceeds: true });
    const error = await failureOf(new LambdaFunctionProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });
});

describe('LambdaFunctionProvider.delete of a journaled function already gone (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  const skipDebugLines = (): number =>
    providerLogger.debug.mock.calls.filter(([m]) => String(m).includes('does not exist, skipping'))
      .length;

  // Both not-found arms: DeleteFunction's, and a VPC function's pre-delete
  // detach (UpdateFunctionConfiguration), which returns before DeleteFunction.
  it.each([
    ['DeleteFunction', {}],
    ['the VPC pre-detach', { VpcConfig: { SubnetIds: ['subnet-1'], SecurityGroupIds: ['sg-1'] } }],
  ])(
    'names it once at info on %s answering not found, since the settle then exits 0',
    async (_arm, properties) => {
      mockSend.mockImplementation(async () => {
        throw notFound('orphan-fn');
      });
      const provider = new LambdaFunctionProvider();
      await provider.delete('Orphan', 'orphan-fn', TYPE, properties, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
      expect(infos).toHaveLength(1);
      expect(infos[0]).toContain('Lambda function orphan-fn (Orphan)');
      expect(infos[0]).toContain('already gone');
      expect(skipDebugLines()).toBe(0);

      // A record's own delete keeps the quiet debug line, the flag absent or false.
      for (const context of [
        { expectedRegion: 'us-east-1' },
        { expectedRegion: 'us-east-1', failedCreateOrphan: false },
      ]) {
        providerLogger.info.mockClear();
        providerLogger.debug.mockClear();
        await provider.delete('Orphan', 'orphan-fn', TYPE, properties, context);
        expect(providerLogger.info).not.toHaveBeenCalled();
        expect(skipDebugLines()).toBe(1);
      }
    }
  );

  // go-to-k/cdkd#3869: the settle, `cdkd rollback` and `cdkd destroy` bind a
  // printing bag holding a secret-derived name around this delete; the line
  // carries the name verbatim, so the logger's line masker removes it.
  it('the info line names a secret-derived function only where the bound printing bag masks it', async () => {
    const DERIVED = 'fn-from-secret-x9';
    mockSend.mockImplementation(async () => {
      throw notFound(DERIVED);
    });
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, DERIVED);
    let masked = '<not masked>';
    await withPrintingSecrets(bag, async () => {
      await new LambdaFunctionProvider().delete('Orphan', DERIVED, TYPE, {}, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      const mask = currentLogLineMasker();
      const line = String(providerLogger.info.mock.calls[0]?.[0]);
      expect(line).toContain(DERIVED);
      masked = mask === undefined ? '<no masker bound>' : mask(line);
    });
    expect(masked).not.toContain(DERIVED);
    expect(masked).toContain(SECRET_MASK);
    expect(masked).toContain('already gone');
  });
});

// The settle end to end with the real provider: the journaled orphan `fn-a`
// carries its CreateFunction response's token (LastModified T1).
describe('the success settle with LambdaFunctionProvider (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * `fixForward`: the fix-forward's record under the orphan's logical id holds
   * `fn-b` (this deploy's CREATE), read live as `recordEntry`.
   */
  async function settle(
    liveEntry: Entry,
    fixForward?: { recordEntry: Entry },
    opts: { journaledIdentity: boolean } = { journaledIdentity: true }
  ) {
    const provider = new LambdaFunctionProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live({
      'fn-a': liveEntry,
      ...(fixForward !== undefined && { 'fn-b': fixForward.recordEntry }),
    });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: TYPE,
              physicalId: 'fn-a',
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              ...(opts.journaledIdentity && { createdResourceIdentity: tokenOf('fn-a', T1_MS) }),
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: {
        loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
        reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
        markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
      } as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: (fixForward === undefined
        ? {}
        : {
            Orphan: {
              physicalId: 'fn-b',
              resourceType: TYPE,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [
            { logicalId: 'Orphan', changeType: 'CREATE', resourceType: TYPE, physicalId: 'fn-b' },
          ]) as never,
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return {
      out,
      del,
      warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n'),
      infos: logger.info.mock.calls.map((m) => String(m[0])).join('\n'),
    };
  }

  it('the fix-forward: deletes `fn-a` when the record `fn-b` reads back', async () => {
    const r = await settle(T1, { recordEntry: T2 });
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del.mock.calls[0]?.[1]).toBe('fn-a');
    expect(r.out.unaddressed).toBe(0);
  });

  it('the fix-forward: keeps it when `fn-a` was re-created (another LastModified) before the settle', async () => {
    const r = await settle(T2, { recordEntry: T2 });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('the fix-forward: an earlier function already gone is named, not deleted, and settles', async () => {
    const r = await settle('gone', { recordEntry: T2 });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(0);
    expect(r.infos).toContain('Orphan (AWS::Lambda::Function)');
    expect(r.infos).toContain('is already gone: nothing to delete');
    expect(r.warned).toBe('');
  });

  // A read that cannot answer never reads as `'different'` or gone: the
  // provider throws, the settle reads the throw as unproven, and the orphan
  // is kept with a warning (exit 2), no DeleteFunction sent.
  it.each([
    [
      'a throttle',
      () => Object.assign(new Error('Rate exceeded'), { name: 'TooManyRequestsException' }),
    ],
    ['AccessDenied', () => denied('GetFunction')],
  ])('the fix-forward: keeps it when the identity read fails with %s', async (_label, failure) => {
    const r = await settle(failure(), { recordEntry: T2 });
    expect(r.del).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(mockSend.mock.calls.every(([cmd]) => cmd instanceof GetFunctionCommand)).toBe(true);
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain('Orphan (AWS::Lambda::Function)');
    expect(r.infos).not.toContain('already gone');
  });

  it("the fix-forward: keeps it when the record's own read fails, whatever the journaled one reads", async () => {
    const r = await settle(T1, { recordEntry: denied('GetFunction') });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain('Orphan (AWS::Lambda::Function)');
  });

  it("the fix-forward: keeps it when the record's function is gone", async () => {
    const r = await settle(T1, { recordEntry: 'gone' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  // A journal an older cdkd wrote carries no identity: whatever the live reads
  // answer, nothing proves the function under the name is the one its CREATE
  // made, so it is kept with a warning and no DeleteFunction is sent.
  it.each([
    ['the fix-forward', { recordEntry: T2 }],
    ['with no record under the id', undefined],
  ] as const)(
    '%s: an entry with no journaled identity (an older journal) is kept',
    async (_label, fixForward) => {
      const r = await settle(T1, fixForward, { journaledIdentity: false });
      expect(r.del).not.toHaveBeenCalled();
      expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteFunctionCommand)).toBe(false);
      expect(r.out.unaddressed).toBe(1);
      expect(r.warned).toContain('Orphan (AWS::Lambda::Function)');
    }
  );

  it('with no record under the id: deletes it when the name still reads back under the journaled token (control)', async () => {
    const r = await settle(T1);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: keeps it when the name now reads back under another token', async () => {
    const r = await settle(T2);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });
});
