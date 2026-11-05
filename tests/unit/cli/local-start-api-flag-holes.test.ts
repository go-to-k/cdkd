import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The two `cdkd local start-api` command-body messages that print a hole
 * beside a flag (go-to-k/cdkd#4295): the `--api` deprecation warning and the
 * "No stacks matched" refusal. Both now quote the hole. Driven through the real
 * command body, with Docker and synthesis stubbed so nothing leaves the
 * process.
 */
vi.mock('../../../src/local/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ensureDockerAvailable: vi.fn(async () => undefined),
}));

// A pass-through that records the first step after the failed lookup refusal.
const discoverRoutesCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../../src/local/route-discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/local/route-discovery.js')>();
  return {
    ...actual,
    discoverRoutes: (...args: Parameters<typeof actual.discoverRoutes>) => {
      discoverRoutesCalls.n += 1;
      return actual.discoverRoutes(...args);
    },
  };
});

const { createLocalStartApiCommand } = await import('../../../src/cli/commands/local-start-api.js');
const { Synthesizer } = await import('../../../src/synthesis/synthesizer.js');
const { getLogger } = await import('../../../src/utils/logger.js');

afterEach(() => {
  vi.restoreAllMocks();
});

async function run(args: string[]): Promise<{ warned: string; error: string }> {
  const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
  const errorLines: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errorLines.push(a.map(String).join(' '));
  });
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({ stacks: [] } as never);
  let thrown = '';
  try {
    const cmd = createLocalStartApiCommand();
    cmd.exitOverride();
    await cmd.parseAsync([...args, '--app', 'node app.js'], { from: 'user' });
  } catch (e) {
    thrown = e instanceof Error ? e.message : String(e);
  }
  return {
    warned: warn.mock.calls.map((c) => String(c[0])).join('\n'),
    error: [thrown, ...errorLines].join('\n'),
  };
}

describe('cdkd local start-api quotes the holes beside its flags (go-to-k/cdkd#4295)', () => {
  it('the --api deprecation warning', async () => {
    const { warned } = await run(['--api', 'MyApi']);
    expect(warned).toContain("[deprecated] --api '<id>' will be removed");
  });

  it('the "No stacks matched" refusal', async () => {
    const { error } = await run([]);
    expect(error).toContain(
      "No stacks matched. Pass --stack '<name>' (or --from-cfn-stack '<name>') or run from a single-stack app."
    );
  });
});

// go-to-k/cdkd#5807: a failed context lookup blocks only the stacks it serves.
describe('cdkd local start-api and a failed context lookup (go-to-k/cdkd#5807)', () => {
  const stackOf = (stackName: string, messages?: unknown[]): unknown => ({
    stackName,
    displayName: stackName,
    artifactId: stackName,
    dependencyNames: [],
    region: 'us-east-1',
    template: { Resources: {} },
    ...(messages && { messages }),
  });

  async function runWith(args: string[]): Promise<{ error: string; options: unknown }> {
    discoverRoutesCalls.n = 0;
    const errorLines: string[] = [];
    vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errorLines.push(a.map(String).join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const synth = vi.spyOn(Synthesizer.prototype, 'synthesize').mockResolvedValue({
      stacks: [
        stackOf('Other'),
        stackOf('Asking', [{ level: 'error', path: '/Asking', message: 'AccessDenied' }]),
      ],
      failedLookups: [{ key: 'ssm:k', error: 'AccessDenied' }],
    } as never);
    let thrown = '';
    try {
      const cmd = createLocalStartApiCommand();
      cmd.exitOverride();
      await cmd.parseAsync([...args, '--app', 'node app.js'], { from: 'user' });
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    return { error: [thrown, ...errorLines].join('\n'), options: synth.mock.calls[0]?.[0] };
  }

  it('refuses a selection holding the stack that asked, before serving', async () => {
    const { error, options } = await runWith(['--stack', 'Asking']);

    expect(error).toContain('Context lookup failed: ssm:k: AccessDenied');
    expect(options).toMatchObject({ failedLookupsCheckedByCaller: true });
    expect(discoverRoutesCalls.n).toBe(0);
  });

  it('goes past the check for a stack that did not ask', async () => {
    const { error } = await runWith(['--stack', 'Other']);

    expect(error).not.toContain('Context lookup failed');
    expect(discoverRoutesCalls.n).toBe(1);
  });
});
