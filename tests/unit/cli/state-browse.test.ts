/**
 * `cdkd state browse` (go-to-k/cdkd#5199): the picker loop, its refusal
 * without a terminal, and that each view prints exactly what its
 * non-interactive command prints. Harness from `state-resources.test.ts`.
 */
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));
vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
  getAwsClients: vi.fn(),
}));

const mockGetState = vi.fn<(stackName: string, region: string) => Promise<{ state: StackState } | null>>();
const mockListStacks = vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    destroyClient: vi.fn(),
    getState: mockGetState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: vi.fn(),
    getLockInfo: vi.fn(async () => null),
  })),
}));

import {
  createStateCommand,
  setupStateBackend,
  stateBrowseDeps,
} from '../../../src/cli/commands/state.js';
import { runStateBrowse, type BrowseDeps } from '../../../src/cli/commands/state-browse.js';
import type { SelectStreams } from '../../../src/cli/interactive-select.js';

const OPTIONS = { statePrefix: 'cdkd', verbose: false };

function stateOf(stackName: string): { state: StackState } {
  return {
    state: {
      version: 13,
      stackName,
      region: 'us-east-1',
      resources: {
        Bucket: { physicalId: 'my-bucket', resourceType: 'AWS::S3::Bucket', properties: {} },
        Queue: {
          physicalId: 'https://sqs/q',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          dependencies: ['Bucket'],
        },
      },
      outputs: { BucketName: 'my-bucket' },
      lastModified: 0,
    },
  };
}

function captureStdout(): { text: () => string; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return { text: () => output.join(''), restore: () => (process.stdout.write = original) };
}

async function runCommand(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.text();
}

function fakeTerminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const written: string[] = [];
  const streams: SelectStreams = {
    input,
    output: { isTTY: true, rows: 24, write: (c: string) => written.push(c) },
  };
  return { input, written, streams };
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
async function type(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tick();
    input.write(key);
  }
  await tick();
}
const esc = (input: PassThrough): void => {
  input.emit('keypress', '\x1b', { name: 'escape', sequence: '\x1b' });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyBucketExists.mockResolvedValue(undefined);
  mockListStacks.mockResolvedValue([
    { stackName: 'Beta', region: 'us-east-1' },
    { stackName: 'Alpha', region: 'us-east-1' },
  ]);
  mockGetState.mockImplementation(async (name) => stateOf(name));
});

describe('each browse view prints what its command prints (go-to-k/cdkd#5199)', () => {
  it.each([
    ['resources', ['resources', 'Alpha']],
    ['resources-long', ['resources', 'Alpha', '--long']],
    ['show', ['show', 'Alpha']],
  ] as const)('%s matches cdkd state %s', async (view, args) => {
    const expected = await runCommand([...args]);
    expect(expected, 'the command printed something to compare').toContain('Bucket');

    const setup = await setupStateBackend(OPTIONS);
    const deps = stateBrowseDeps(setup, OPTIONS, fakeTerminal().streams);
    const cap = captureStdout();
    try {
      await deps.printView(view, { stackName: 'Alpha', region: 'us-east-1' });
    } finally {
      cap.restore();
      setup.dispose();
    }
    expect(cap.text()).toBe(expected);
  });

  it('lists the stacks sorted, as cdkd state list does', async () => {
    const setup = await setupStateBackend(OPTIONS);
    const deps = stateBrowseDeps(setup, OPTIONS, fakeTerminal().streams);
    expect((await deps.listStacks()).map((r) => r.stackName)).toEqual(['Alpha', 'Beta']);
    setup.dispose();
  });

  it('refuses a region-less legacy record through reportError, not a crash', async () => {
    const setup = await setupStateBackend(OPTIONS);
    const deps = stateBrowseDeps(setup, OPTIONS, fakeTerminal().streams);
    await expect(deps.printView('show', { stackName: 'Old' })).rejects.toThrow();
    setup.dispose();
  });
});

describe('runStateBrowse', () => {
  function fakeDeps(streams: SelectStreams, printView = vi.fn(async () => undefined)) {
    const deps: BrowseDeps = {
      streams,
      listStacks: vi.fn(async () => [
        { stackName: 'Alpha', region: 'us-east-1' },
        { stackName: 'Beta', region: 'eu-west-1' },
      ]),
      label: (ref) => `${ref.stackName} (${ref.region})`,
      printView,
      reportError: vi.fn(),
    };
    return deps;
  }

  it('picks a stack, prints a view, goes back to the stack list, and leaves on Esc', async () => {
    const t = fakeTerminal();
    const deps = fakeDeps(t.streams);
    const done = runStateBrowse(deps);
    // Stack list: down to Beta, Enter. Menu: Enter on the first view.
    await type(t.input, '\x1b[B', '\r', '\r');
    // Menu again: down three times to "Back", Enter. Then Esc on the stack list.
    await type(t.input, '\x1b[B', '\x1b[B', '\x1b[B', '\r');
    esc(t.input);
    await done;

    expect(deps.printView).toHaveBeenCalledTimes(1);
    expect(deps.printView).toHaveBeenCalledWith('resources', { stackName: 'Beta', region: 'eu-west-1' });
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('reports a failing view and returns to the menu', async () => {
    const t = fakeTerminal();
    const deps = fakeDeps(
      t.streams,
      vi.fn(async () => {
        throw new Error('gone');
      })
    );
    const done = runStateBrowse(deps);
    await type(t.input, '\r', '\r', '\x03');
    await done;

    expect(deps.reportError).toHaveBeenCalledWith(new Error('gone'));
  });

  it('refuses without a terminal before listing anything', async () => {
    const deps = fakeDeps({ input: new PassThrough(), output: { write: vi.fn() } });
    await expect(runStateBrowse(deps)).rejects.toMatchObject({ code: 'NON_INTERACTIVE' });
    expect(deps.listStacks).not.toHaveBeenCalled();
  });

  it('says so when the bucket holds no stack', async () => {
    const t = fakeTerminal();
    const deps = { ...fakeDeps(t.streams), listStacks: vi.fn(async () => []) };
    await runStateBrowse(deps);
    expect(t.written.join('')).toContain('No stacks in the state bucket.');
  });
});

describe('cdkd state browse without a terminal', () => {
  it('refuses with NON_INTERACTIVE before any AWS call', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(runCommand(['browse'])).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
    }
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('needs an interactive terminal');
    expect(mockVerifyBucketExists, 'no bucket check').not.toHaveBeenCalled();
    expect(mockListStacks).not.toHaveBeenCalled();
  });
});
