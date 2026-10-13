import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * The four `cdkd local` commands that embed a cdk-local serve hand it cdkd's
 * synthesizer, so no `cdkd local` command synthesizes through cdk-local's
 * toolkit-lib one.
 */

const seen = vi.hoisted(() => ({
  factoryOptions: [] as Array<Record<string, unknown>>,
  emulatorArgs: [] as unknown[][],
}));

vi.mock('cdk-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cdk-local')>();
  return {
    ...actual,
    createLocalStartAgentCoreCommand: (opts: Record<string, unknown>) => {
      seen.factoryOptions.push(opts);
      return actual.createLocalStartAgentCoreCommand(opts);
    },
    createLocalStartCloudFrontCommand: (opts: Record<string, unknown>) => {
      seen.factoryOptions.push(opts);
      return actual.createLocalStartCloudFrontCommand(opts);
    },
  };
});
vi.mock('../../../src/cli/commands/ecs-service-emulator.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runEcsServiceEmulator: vi.fn(async (...args: unknown[]) => {
    seen.emulatorArgs.push(args);
  }),
}));

const synthesize = vi.hoisted(() => vi.fn(async () => ({ stacks: [] })));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    synthesize = synthesize;
  },
}));

const { createLocalStartAgentCoreCommand } = await import(
  '../../../src/cli/commands/local-start-agentcore.js'
);
const { createLocalStartCloudFrontCommand } = await import(
  '../../../src/cli/commands/local-start-cloudfront.js'
);
const { createLocalStartServiceCommand } = await import(
  '../../../src/cli/commands/local-start-service.js'
);
const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');

interface Synth {
  synthesize(opts: { app: string; profile?: string }): Promise<unknown>;
}

beforeEach(() => {
  seen.factoryOptions = [];
  seen.emulatorArgs = [];
  synthesize.mockClear();
});

describe.each([
  ['start-agentcore', createLocalStartAgentCoreCommand],
  ['start-cloudfront', createLocalStartCloudFrontCommand],
])('%s', (_name, create) => {
  it("hands cdk-local cdkd's synthesizer", async () => {
    create();
    expect(seen.factoryOptions).toHaveLength(1);
    const synthesizer = seen.factoryOptions[0]!['synthesizer'] as Synth;
    await synthesizer.synthesize({ app: 'node app.js' });
    expect(synthesize).toHaveBeenCalledWith({ app: 'node app.js' });
  });
});

describe.each([
  ['start-service', createLocalStartServiceCommand, 'Stack/Service'],
  ['start-alb', createLocalStartAlbCommand, 'Stack/Alb'],
])('%s', (_name, create, target) => {
  it("hands the ECS emulator cdkd's synthesizer, with the command's --state-bucket", async () => {
    await create().parseAsync(['node', 'cdkd', target, '--state-bucket', 'my-bucket']);
    expect(seen.emulatorArgs).toHaveLength(1);
    const synthesizer = seen.emulatorArgs[0]![4] as Synth;
    await synthesizer.synthesize({ app: 'node app.js' });
    expect(synthesize).toHaveBeenCalledWith({ app: 'node app.js', stateBucket: 'my-bucket' });
  });
});
