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
