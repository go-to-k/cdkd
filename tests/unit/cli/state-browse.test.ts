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
import { AwsClients } from '../../../src/utils/aws-clients.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
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

/** Run `parse` (a fresh `cdkd state` tree's parse), returning what it printed. */
async function runCommand(parse: () => Promise<unknown>): Promise<string> {
  const cap = captureStdout();
  try {
    await parse();
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
    armDelayMs: 0,
  };
  return { input, written, streams };
}

// Two turns: the next list opens after the previous one resolves (and a view
// prints), and it drops keys from its own first turn.
const tick = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 1));
};
async function type(input: PassThrough, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await tick();
    input.write(key);
  }
  await tick();
}
const esc = async (input: PassThrough): Promise<void> => {
  await tick();
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
    ['resources', () => createStateCommand().parseAsync(['resources', 'Alpha'], { from: 'user' })],
    ['resources-long', () => createStateCommand().parseAsync(['resources', 'Alpha', '--long'], { from: 'user' })],
    ['show', () => createStateCommand().parseAsync(['show', 'Alpha'], { from: 'user' })],
  ] as const)('%s matches its command', async (view, parse) => {
    const expected = await runCommand(parse);
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

  it('views the region that was picked when one name has records in two regions', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'Alpha', region: 'us-east-1' },
      { stackName: 'Alpha', region: 'eu-west-1' },
    ]);
    mockGetState.mockImplementation(async (name, region) => {
      const s = stateOf(name);
      s.state.region = region;
      s.state.resources['Bucket']!.physicalId = `bucket-in-${region}`;
      return s;
    });
    const setup = await setupStateBackend(OPTIONS);
    const deps = stateBrowseDeps(setup, OPTIONS, fakeTerminal().streams);
    const cap = captureStdout();
    try {
      await deps.printView('resources', { stackName: 'Alpha', region: 'eu-west-1' });
    } finally {
      cap.restore();
      setup.dispose();
    }
    expect(cap.text()).toContain('bucket-in-eu-west-1');
    expect(mockGetState).toHaveBeenCalledWith('Alpha', 'eu-west-1');
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
    mockListStacks.mockResolvedValue([{ stackName: 'Old' }]);
    await expect(deps.printView('show', { stackName: 'Old' })).rejects.toThrow(
      'has only a legacy state record without a region'
    );
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

  /** Resolves `true` once `p` settles, so a test can see it is still running. */
  function settled(p: Promise<unknown>): () => boolean {
    let done = false;
    void p.then(
      () => (done = true),
      () => (done = true)
    );
    return () => done;
  }
  const count = (written: string[], needle: string): number =>
    written.join('').split(needle).length - 1;

  it('picks a stack, prints a view, goes back to the stack list, and leaves on Esc', async () => {
    const t = fakeTerminal();
    const deps = fakeDeps(t.streams);
    const done = runStateBrowse(deps);
    const isDone = settled(done);
    // Stack list: down to Beta, Enter. Menu: Enter on the first view.
    await type(t.input, '\x1b[B', '\r', '\r');
    // Menu again: down three times to "Back", Enter.
    await type(t.input, '\x1b[B', '\x1b[B', '\x1b[B', '\r');
    expect(isDone(), 'Back returns to the stack list, not out of the command').toBe(false);
    expect(count(t.written, 'Select a stack:')).toBeGreaterThanOrEqual(2);
    await esc(t.input);
    await done;

    expect(deps.printView).toHaveBeenCalledTimes(1);
    expect(deps.printView).toHaveBeenCalledWith('resources', { stackName: 'Beta', region: 'eu-west-1' });
    expect(deps.listStacks, 'one listing for the whole session').toHaveBeenCalledTimes(1);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('Esc on a stack menu goes back to the stack list', async () => {
    const t = fakeTerminal();
    const deps = fakeDeps(t.streams);
    const done = runStateBrowse(deps);
    const isDone = settled(done);
    await type(t.input, '\r');
    await esc(t.input);
    await tick();
    expect(isDone()).toBe(false);
    expect(count(t.written, 'Select a stack:')).toBeGreaterThanOrEqual(2);
    await type(t.input, '\x03');
    await done;
    expect(deps.printView).not.toHaveBeenCalled();
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
    const isDone = settled(done);
    await type(t.input, '\r', '\r');
    expect(deps.reportError).toHaveBeenCalledWith(new Error('gone'));
    expect(isDone(), 'the menu comes back after a failing view').toBe(false);
    expect(count(t.written, 'Alpha (us-east-1):\n> Resources')).toBeGreaterThanOrEqual(2);
    await type(t.input, '\x03');
    await done;
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
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    try {
      await expect(runCommand(() => createStateCommand().parseAsync(['browse'], { from: 'user' }))).rejects.toThrow('exit 1');
    } finally {
      exit.mockRestore();
      for (const [stream, d] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
        if (d) Object.defineProperty(stream, 'isTTY', d);
        else delete (stream as { isTTY?: boolean }).isTTY;
      }
    }
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('needs an interactive terminal');
    expect(vi.mocked(AwsClients), 'no AWS client built').not.toHaveBeenCalled();
    expect(vi.mocked(S3StateBackend), 'no state backend built').not.toHaveBeenCalled();
    expect(mockVerifyBucketExists, 'no bucket check').not.toHaveBeenCalled();
    expect(mockListStacks).not.toHaveBeenCalled();
  });
});
