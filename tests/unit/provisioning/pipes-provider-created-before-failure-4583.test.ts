/**
 * go-to-k/cdkd#4583: a pipe CreatePipe made, that the failed create's own
 * retire could not delete (or could not confirm deleting), is named on the
 * thrown error for the failed-CREATE journal -- and only then.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeletePipeCommand, NotFoundException } from '@aws-sdk/client-pipes';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-pipes', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-pipes')>('@aws-sdk/client-pipes');
  return {
    ...actual,
    PipesClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::Pipes::Pipe';
const NAME = 'my-pipe';
const PROPS = { Name: NAME, RoleArn: 'r', Source: 's', Target: 't' };

function described(state: string): Record<string, unknown> {
  return { Name: NAME, CurrentState: state, CreationTime: new Date('2026-10-01T00:00:00Z') };
}

/** Route each command class to a handler; anything else fails the call. */
function route(handlers: Partial<Record<string, (input: unknown) => unknown>>): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string }; input: unknown }) => {
    const handler = handlers[command.constructor.name];
    if (!handler) throw new Error(`unexpected ${command.constructor.name}`);
    return handler(command.input);
  });
}

function deleteCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof DeletePipeCommand);
}

const notFound = (): NotFoundException => new NotFoundException({ message: 'gone', $metadata: {} });

async function failedCreate(): Promise<unknown> {
  let clock = 0;
  const provider = new PipesPipeProvider({
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  });
  return provider.create('Pipe', TYPE, { ...PROPS }).then(
    () => {
      throw new Error('create unexpectedly succeeded');
    },
    (e: unknown) => e
  );
}

/** CREATE_FAILED until the delete is sent, then `after()` per read. */
function createFailsThen(after: () => unknown, onDelete: () => unknown = () => ({})): void {
  let deleted = false;
  route({
    CreatePipeCommand: () => ({}),
    DescribePipeCommand: () => (deleted ? after() : described('CREATE_FAILED')),
    DeletePipeCommand: () => {
      deleted = true;
      return onDelete();
    },
  });
}

describe('PipesPipeProvider.create — created-before-failure mark (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('marks the pipe name when the retire delete itself FAILS', async () => {
    createFailsThen(
      () => described('CREATE_FAILED'),
      () => {
        throw Object.assign(new Error('busy'), { name: 'ConflictException' });
      }
    );

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/could not delete the pipe it had created/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBe(NAME);
  });

  it('marks the pipe name when the retire delete reaches DELETE_FAILED', async () => {
    const after = [described('DELETING'), described('DELETE_FAILED')];
    createFailsThen(() => after.shift() ?? described('DELETE_FAILED'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/its delete did not complete/);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBe(NAME);
  });

  it('marks the pipe name when the delete was sent but never confirmed progressing', async () => {
    createFailsThen(() => described('CREATE_FAILED'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/could not confirm the delete progressed/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBe(NAME);
  });

  it('does not mark when the retire confirmed the pipe gone', async () => {
    createFailsThen(() => {
      throw notFound();
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/cdkd deleted the pipe it had created/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBeUndefined();
  });

  it('does not mark when the retire saw the pipe DELETING', async () => {
    createFailsThen(() => described('DELETING'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/cdkd started deleting the pipe it had created/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBeUndefined();
  });

  it('does not mark when the retire delete answered NotFound', async () => {
    createFailsThen(
      () => described('CREATE_FAILED'),
      () => {
        throw notFound();
      }
    );

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBeUndefined();
  });

  it("does not mark CreatePipe's own failure", async () => {
    route({
      CreatePipeCommand: () => {
        throw Object.assign(new Error('exists'), { name: 'ConflictException' });
      },
    });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/Failed to create Pipe Pipe/);
    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'Pipe', TYPE)).toBeUndefined();
  });
});
