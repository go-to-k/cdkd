import { describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmulatorStrategy } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * What `cdkd local start-alb` hands the engine, captured by running the real
 * command through commander with only `runEcsServiceEmulator` stubbed.
 *
 * Since cdk-local 0.151.0 (go-to-k/cdk-local#699) the engine carries cdkd's
 * `--from-state` fields to a `TargetType: lambda` target group's container
 * environment as well as to the ECS services, so the boot warning cdkd used to
 * add for the Lambda half ([#2602](https://github.com/go-to-k/cdkd/issues/2602))
 * is gone. Pinned here: the registry is cdkd's own, and the strategy the
 * engine receives no longer says `--from-state` misses the Lambda targets.
 */

const captured: { strategy?: EmulatorStrategy; extraStateProviders?: unknown } = {};

vi.mock('../../../src/cli/commands/ecs-service-emulator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/cli/commands/ecs-service-emulator.js')>();
  return {
    ...actual,
    runEcsServiceEmulator: vi.fn(
      async (
        _targets: string[],
        _options: unknown,
        strategy: EmulatorStrategy,
        extraStateProviders: unknown
      ) => {
        captured.strategy = strategy;
        captured.extraStateProviders = extraStateProviders;
      }
    ),
  };
});

const { createLocalStartAlbCommand } = await import(
  '../../../src/cli/commands/local-start-alb.js'
);
const { cdkdExtraStateProviders } = await import(
  '../../../src/cli/commands/local-state-source.js'
);

const template = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/alb-lambda-target/template.json'), 'utf8')
) as Record<string, unknown>;

const stacks = [
  {
    stackName: 'LiveAlbProbeStack',
    displayName: 'LiveAlbProbeStack',
    artifactId: 'LiveAlbProbeStack',
    template,
    dependencyNames: [],
    region: 'us-east-1',
    account: '111122223333',
  },
];

async function strategyHandedToEngine(argv: string[]): Promise<EmulatorStrategy> {
  // cdk-local's `withErrorHandling` ends in `process.exit(1)`; turn it into a
  // throw so a broken action fails the case instead of the worker.
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`the action exited (${code}) instead of reaching the engine`);
  }) as never);
  try {
    captured.strategy = undefined;
    captured.extraStateProviders = undefined;
    await createLocalStartAlbCommand().parseAsync(argv, { from: 'user' });
    if (captured.strategy === undefined) {
      throw new Error('the action never called runEcsServiceEmulator');
    }
    return captured.strategy;
  } finally {
    exit.mockRestore();
  }
}

describe('the strategy `cdkd local start-alb` hands the engine', () => {
  it('hands the engine cdkd state-source registry, not a re-made one', async () => {
    await strategyHandedToEngine(['My/Alb', '--from-state']);
    expect(captured.extraStateProviders).toBe(cdkdExtraStateProviders);
  });

  it('adds no Lambda-target carve-out warning under --from-state (#2602)', async () => {
    const strategy = await strategyHandedToEngine(['My/Alb', '--from-state']);
    // The ALB fixture has BOTH an ECS service target and a Lambda target group.
    const { warnings, frontDoor, boots } = strategy.resolveBoots(stacks as never, ['Alb16C2F182']);
    // Premise: the plan really carries the Lambda target and the ECS boot, so
    // the absence below is not vacuous.
    const lambdaIds = frontDoor!.listeners.flatMap((l) =>
      [l.defaultAction, ...l.rules.map((r) => r.action)].flatMap((a) =>
        a?.kind === 'forward'
          ? a.targets.flatMap((t) => (t.kind === 'lambda' ? [t.lambda.logicalId] : []))
          : []
      )
    );
    expect(lambdaIds).toContain('ApiFnE0725F78');
    expect(boots).toHaveLength(1);
    expect(warnings.join('\n')).not.toContain('does not reach the container environment');
  });
});
