/**
 * go-to-k/cdkd#4606 / #4655, the EventBridge Pipes slice:
 * `PipesPipeProvider.isSameResource` (is the pipe a failed CREATE journaled
 * the one the record under the same logical id holds?) and
 * `resourceIdentity` (`<pipeArn>@<creationTime epoch seconds>`, the token a
 * fix-forward settle compares before deleting a name-keyed orphan), plus the
 * token a failed CREATE's mark carries from `CreatePipe`'s answer. Every case
 * the read cannot prove answers `unknown` / `undefined`, never `different` /
 * a token; a pipe in `DELETING` never reads as the live resource.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreatePipeCommand,
  DeletePipeCommand,
  DescribePipeCommand,
  NotFoundException,
} from '@aws-sdk/client-pipes';

const { mockSend, clientRegion, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'us-east-1' },
  childLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
}));

vi.mock('@aws-sdk/client-pipes', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-pipes')>('@aws-sdk/client-pipes');
  return {
    ...actual,
    PipesClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { orphanDeleteNeedsIdentity } from '../../../src/deployment/rollback-executor/orphan-identity.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { withRetry } from '../../../src/deployment/retry.js';

const TYPE = 'AWS::Pipes::Pipe';
const REGION = { expectedRegion: 'us-east-1' };
const JOURNALED = 'cdkd-pffo-a';
const RECORD = 'cdkd-pffo-a-b';
const CREATED_AT = new Date('2026-10-15T01:02:03.456Z');
const CREATED_S = Math.floor(CREATED_AT.getTime() / 1000);
const arnOf = (name: string): string => `arn:aws:pipes:us-east-1:123456789012:pipe/${name}`;
const tokenOf = (name: string, seconds: number = CREATED_S): string => `${arnOf(name)}@${seconds}`;

type Pipe = Record<string, unknown>;
/** A `DescribePipe` answer; `overrides` replaces (an explicit `undefined` removes) a field. */
function pipe(name: string, overrides: Pipe = {}): Pipe {
  const base: Pipe = {
    Name: name,
    Arn: arnOf(name),
    CurrentState: 'RUNNING',
    CreationTime: CREATED_AT,
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}
const notFound = (): NotFoundException =>
  new NotFoundException({ message: 'Pipe not found', $metadata: {} });
function accessDenied(action: string): Error {
  return Object.assign(new Error(`User is not authorized to perform: pipes:${action}`), {
    name: 'AccessDeniedException',
    $metadata: { httpStatusCode: 403 },
  });
}

/** Answer each `DescribePipe` by name; a name not in `byName` is not found. */
function describeBy(byName: Record<string, Pipe | Error>): void {
  mockSend.mockImplementation(async (command: unknown) => {
    if (!(command instanceof DescribePipeCommand)) {
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    }
    const answer = byName[command.input.Name as string];
    if (answer === undefined) throw notFound();
    if (answer instanceof Error) throw answer;
    return answer;
  });
}
function describedNames(): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof DescribePipeCommand)
    .map((c) => (c[0] as DescribePipeCommand).input.Name);
}

function provider(): PipesPipeProvider {
  let clock = 0;
  return new PipesPipeProvider({
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
}

beforeEach(() => {
  mockSend.mockReset();
  clientRegion.value = 'us-east-1';
  childLogger.info.mockReset();
  childLogger.debug.mockReset();
});

describe('PipesPipeProvider.isSameResource (#4606)', () => {
  it('answers different when the journaled pipe is gone and the record reads back', async () => {
    describeBy({ [RECORD]: pipe(RECORD) });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('different');
    expect(describedNames()).toEqual([RECORD, JOURNALED]);
  });

  it('answers different when both read back under different ARNs', async () => {
    describeBy({ [RECORD]: pipe(RECORD), [JOURNALED]: pipe(JOURNALED) });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('different');
  });

  it("answers same when AWS reads the journaled name back under the record's ARN", async () => {
    describeBy({ [RECORD]: pipe(RECORD), [JOURNALED]: pipe(JOURNALED, { Arn: arnOf(RECORD) }) });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('same');
  });

  it('answers same for equal names without a read', async () => {
    await expect(
      provider().isSameResource(RECORD, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('same');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['another type', JOURNALED, RECORD, 'AWS::Events::Rule'],
    ['a journaled ARN', arnOf(JOURNALED), RECORD, TYPE],
    ['a record ARN', JOURNALED, arnOf(RECORD), TYPE],
    ['an empty journaled id', '', RECORD, TYPE],
    ['a 65-character name', 'a'.repeat(65), RECORD, TYPE],
    ['a name with a slash', 'cdkd/pffo-a', RECORD, TYPE],
    ['names differing only in case', 'CDKD-PFFO-A-B', RECORD, TYPE],
  ])('answers unknown without a read for %s', async (_label, journaled, record, type) => {
    await expect(
      provider().isSameResource(journaled, { physicalId: record }, type, REGION)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers unknown without a read for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("answers unknown when the record's pipe is not found, without reading the journaled one", async () => {
    describeBy({ [JOURNALED]: pipe(JOURNALED) });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('unknown');
    expect(describedNames()).toEqual([RECORD]);
  });

  it.each([
    ['the record', RECORD],
    ['the journaled pipe', JOURNALED],
  ])('answers unknown when %s reads back with no ARN', async (_label, which) => {
    describeBy({
      [RECORD]: pipe(RECORD, which === RECORD ? { Arn: undefined } : {}),
      [JOURNALED]: pipe(JOURNALED, which === JOURNALED ? { Arn: undefined } : {}),
    });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).resolves.toBe('unknown');
  });

  it.each([
    ['the record', RECORD],
    ['the journaled pipe', JOURNALED],
  ])('throws (read as unknown) when reading %s fails with anything but not-found', async (_l, which) => {
    describeBy({
      [RECORD]: which === RECORD ? accessDenied('DescribePipe') : pipe(RECORD),
      [JOURNALED]: which === JOURNALED ? accessDenied('DescribePipe') : pipe(JOURNALED),
    });

    await expect(
      provider().isSameResource(JOURNALED, { physicalId: RECORD }, TYPE, REGION)
    ).rejects.toThrow(/not authorized/);
  });
});

describe('PipesPipeProvider.resourceIdentity (#4606)', () => {
  it('is the ARN and the creation time in whole epoch seconds', async () => {
    describeBy({ [JOURNALED]: pipe(JOURNALED) });

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      tokenOf(JOURNALED)
    );
    expect(tokenOf(JOURNALED)).toBe(`${arnOf(JOURNALED)}@1792026123`);
  });

  it('changes when the name is re-created (another creation time)', async () => {
    describeBy({ [JOURNALED]: pipe(JOURNALED) });
    const first = await provider().resourceIdentity(JOURNALED, TYPE, REGION);
    describeBy({
      [JOURNALED]: pipe(JOURNALED, { CreationTime: new Date(CREATED_AT.getTime() + 45_000) }),
    });
    const second = await provider().resourceIdentity(JOURNALED, TYPE, REGION);

    expect(second).toBe(tokenOf(JOURNALED, CREATED_S + 45));
    expect(second).not.toBe(first);
  });

  it('is the same token whatever fraction of the second the answer carries', async () => {
    describeBy({
      [JOURNALED]: pipe(JOURNALED, { CreationTime: new Date(CREATED_S * 1000) }),
    });

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      tokenOf(JOURNALED)
    );
  });

  it('is RESOURCE_NOT_FOUND on AWS not-found', async () => {
    describeBy({});

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      RESOURCE_NOT_FOUND
    );
  });

  it.each([
    'CREATING',
    'CREATE_FAILED',
    'CREATE_ROLLBACK_FAILED',
    'RUNNING',
    'STARTING',
    'START_FAILED',
    'STOPPED',
    'STOPPING',
    'STOP_FAILED',
    'UPDATING',
    'UPDATE_FAILED',
    'UPDATE_ROLLBACK_FAILED',
    'DELETE_FAILED',
    'DELETE_ROLLBACK_FAILED',
  ])('answers the token for a pipe in %s', async (state) => {
    describeBy({ [JOURNALED]: pipe(JOURNALED, { CurrentState: state }) });

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(
      tokenOf(JOURNALED)
    );
  });

  it.each([
    ['in DELETING', { CurrentState: 'DELETING' }],
    ['in a state cdkd does not know', { CurrentState: 'ARCHIVING' }],
    ['with no state', { CurrentState: undefined }],
    ['answered for another name', { Name: RECORD }],
    ['answered with no name', { Name: undefined }],
    ['with no ARN', { Arn: undefined }],
    ["with another pipe's ARN", { Arn: arnOf(RECORD) }],
    ['with an ARN that is not one', { Arn: `pipe/${JOURNALED}` }],
    ['with no creation time', { CreationTime: undefined }],
    ['with an invalid creation time', { CreationTime: new Date(Number.NaN) }],
    ['with a creation time at the epoch', { CreationTime: new Date(0) }],
    ['with a creation time that is not a Date', { CreationTime: CREATED_S }],
  ])('answers no token for a pipe %s', async (_label, overrides) => {
    describeBy({ [JOURNALED]: pipe(JOURNALED, overrides as Pipe) });

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBeUndefined();
  });

  it.each([
    ['another type', JOURNALED, 'AWS::Events::Rule'],
    ['an ARN', arnOf(JOURNALED), TYPE],
    ['an empty id', '', TYPE],
  ])('answers no token without a read for %s', async (_label, id, type) => {
    await expect(provider().resourceIdentity(id, type, REGION)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('answers no token without a read for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('throws on a read failure that is not not-found (never "gone")', async () => {
    describeBy({ [JOURNALED]: accessDenied('DescribePipe') });

    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).rejects.toThrow(
      /not authorized/
    );
  });

  it('is required before the settle deletes a pipe orphan', () => {
    expect(orphanDeleteNeedsIdentity(TYPE)).toBe(true);
  });
});

describe("PipesPipeProvider.create — the failed CREATE's mark carries CreatePipe's token (#4606)", () => {
  /**
   * The fixture's shape: CreatePipe answers `created`, every DescribePipe is
   * refused (so the settle fails), and so is the retire's DeletePipe.
   */
  function describeAndDeleteDenied(created: Pipe): void {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreatePipeCommand) return created;
      if (command instanceof DescribePipeCommand) throw accessDenied('DescribePipe');
      if (command instanceof DeletePipeCommand) throw accessDenied('DeletePipe');
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    });
  }
  async function failedCreate(): Promise<unknown> {
    return provider()
      .create('OrphanA', TYPE, { Name: JOURNALED, RoleArn: 'r', Source: 's', Target: 't' })
      .then(
        () => {
          throw new Error('create unexpectedly succeeded');
        },
        (e: unknown) => e
      );
  }

  it("marks the pipe with the token DescribePipe would answer for it", async () => {
    describeAndDeleteDenied({
      Name: JOURNALED,
      Arn: arnOf(JOURNALED),
      CurrentState: 'CREATING',
      CreationTime: CREATED_AT,
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/could not delete the pipe it had created/);
    expect(createdBeforeFailure(error, 'OrphanA', TYPE)).toBe(JOURNALED);
    const marked = createdResourceIdentityBeforeFailure(error, 'OrphanA', TYPE);
    expect(marked).toBe(tokenOf(JOURNALED));
    // The settle's later live read of the same pipe (another fraction of the
    // same second) answers the same token.
    describeBy({
      [JOURNALED]: pipe(JOURNALED, { CreationTime: new Date(CREATED_S * 1000 + 999) }),
    });
    await expect(provider().resourceIdentity(JOURNALED, TYPE, REGION)).resolves.toBe(marked);
  });

  it.each([
    ['no creation time', { CreationTime: undefined }],
    ['no ARN', { Arn: undefined }],
    ["another pipe's ARN", { Arn: arnOf(RECORD) }],
    ['an invalid creation time', { CreationTime: new Date(Number.NaN) }],
  ])('marks the pipe with no token when CreatePipe answers %s', async (_label, overrides) => {
    describeAndDeleteDenied(pipe(JOURNALED, { CurrentState: 'CREATING', ...overrides } as Pipe));

    const error = await failedCreate();

    // Still marked (the engine's journaling-time read supplies the token).
    expect(createdBeforeFailure(error, 'OrphanA', TYPE)).toBe(JOURNALED);
    expect(createdResourceIdentityBeforeFailure(error, 'OrphanA', TYPE)).toBeUndefined();
  });

  it("is terminal for the engine's retry, which would replay CreatePipe into the pipe it left", async () => {
    // A denied settle read matches the IAM-propagation retry pattern; without
    // the terminal mark the replayed CreatePipe collides with the left-behind
    // pipe and its "already exists" replaces the delete advice.
    let creates = 0;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreatePipeCommand) {
        creates++;
        if (creates > 1) {
          throw Object.assign(new Error(`Pipe ${JOURNALED} already exists.`), {
            name: 'ConflictException',
            $metadata: { httpStatusCode: 409 },
          });
        }
        return pipe(JOURNALED, { CurrentState: 'CREATING' });
      }
      if (command instanceof DescribePipeCommand) {
        throw new Error(
          `User: arn:aws:sts::123456789012:assumed-role/r/s is not authorized to perform: pipes:DescribePipe on resource: ${arnOf(JOURNALED)} with an explicit deny`
        );
      }
      if (command instanceof DeletePipeCommand) throw accessDenied('DeletePipe');
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    });
    const p = provider();
    const props = { Name: JOURNALED, RoleArn: 'r', Source: 's', Target: 't' };

    const error = await withRetry(() => p.create('OrphanA', TYPE, props), 'OrphanA', {
      sleep: async () => {},
    }).catch((e: unknown) => e);

    expect(creates).toBe(1);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain(
      `Otherwise delete it yourself with: aws pipes delete-pipe --name ${JOURNALED} --region us-east-1`
    );
    expect(createdResourceIdentityBeforeFailure(error, 'OrphanA', TYPE)).toBe(tokenOf(JOURNALED));
  });

  it('marks the token, terminal, when the delete was sent but never confirmed progressing', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreatePipeCommand) return pipe(JOURNALED, { CurrentState: 'CREATING' });
      // CREATE_FAILED before and after the accepted delete: no DELETING read.
      if (command instanceof DescribePipeCommand) {
        return pipe(JOURNALED, { CurrentState: 'CREATE_FAILED' });
      }
      if (command instanceof DeletePipeCommand) return {};
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/could not confirm the delete progressed/);
    expect(createdBeforeFailure(error, 'OrphanA', TYPE)).toBe(JOURNALED);
    expect(createdResourceIdentityBeforeFailure(error, 'OrphanA', TYPE)).toBe(tokenOf(JOURNALED));
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('leaves the error unmarked, and retryable as before, when the retire confirmed the pipe gone', async () => {
    let deleted = false;
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreatePipeCommand) return pipe(JOURNALED, { CurrentState: 'CREATING' });
      // The settle's read fails with a retryable-shaped denial; once the
      // retire's delete is sent, the pipe reads gone.
      if (command instanceof DescribePipeCommand) {
        if (deleted) throw notFound();
        throw accessDenied('DescribePipe');
      }
      if (command instanceof DeletePipeCommand) {
        deleted = true;
        return {};
      }
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/cdkd deleted the pipe it had created/);
    expect(createdBeforeFailure(error, 'OrphanA', TYPE)).toBeUndefined();
    // Nothing holds the name any more, so the engine may still replay the
    // create: the terminal mark is the left-behind paths' alone.
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('marks the pipe with no token when CreatePipe answers nothing', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreatePipeCommand) return undefined;
      if (command instanceof DescribePipeCommand) throw accessDenied('DescribePipe');
      throw accessDenied('DeletePipe');
    });

    const error = await failedCreate();

    expect(createdBeforeFailure(error, 'OrphanA', TYPE)).toBe(JOURNALED);
    expect(createdResourceIdentityBeforeFailure(error, 'OrphanA', TYPE)).toBeUndefined();
  });
});

describe('PipesPipeProvider.delete — a gone pipe (#4606)', () => {
  function deleteNotFound(): void {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DeletePipeCommand) throw notFound();
      throw new Error(`unexpected ${(command as object).constructor.name}`);
    });
  }

  it("says a failed CREATE's orphan already gone at info", async () => {
    deleteNotFound();

    await provider().delete('OrphanA', JOURNALED, TYPE, undefined, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });

    expect(childLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(`Pipe ${JOURNALED} (OrphanA), which a failed deploy created, is already gone`)
    );
  });

  it('keeps an ordinary gone delete at debug', async () => {
    deleteNotFound();

    await provider().delete('OrphanA', JOURNALED, TYPE, undefined, { expectedRegion: 'us-east-1' });

    expect(childLogger.info).not.toHaveBeenCalled();
    expect(childLogger.debug).toHaveBeenCalledWith(expect.stringContaining('already deleted'));
  });
});
