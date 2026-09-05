import { describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EmulatorStrategy } from '../../../src/cli/commands/ecs-service-emulator.js';

/**
 * Does the strategy `cdkd local start-alb` HANDS THE ENGINE actually warn?
 *
 * This file exists because two weaker answers were measured and defeated:
 *
 * 1. The decorator's own cases (`local-start-alb.test.ts`) call
 *    {@link warnUnresolvedLambdaTargetEnv} directly, so they cannot see a call
 *    site that stopped calling it. Deleting the decorator from the command's
 *    action left 29/29 green (issue [#2602](https://github.com/go-to-k/cdkd/issues/2602),
 *    review round 1).
 * 2. The SOURCE-SHAPE assertion added in response — grep the module text for
 *    `buildAlbEmulatorStrategy(options),` and forbid `albStrategy(` inside the
 *    `runEcsServiceEmulator(` argument list — was defeated in review round 3
 *    by hoisting the bare call one statement up:
 *
 *    ```ts
 *    const chosen = albStrategy(options);
 *    await runEcsServiceEmulator(targets, options, chosen, cdkdExtraStateProviders);
 *    ```
 *
 *    35/35 stayed green while the engine received an UNDECORATED strategy —
 *    i.e. the warning never reaches a user, the exact regression the case was
 *    written for. A whole-file `toContain` has no anchor to the call, and the
 *    negative pattern's `[^)]*` cannot cross the `)` the hoist puts in the way.
 *
 * So the question is answered BEHAVIOURALLY instead: run the real command
 * through commander, capture the third argument the action passes to
 * `runEcsServiceEmulator`, and drive THAT object. Whatever the action builds —
 * inline, hoisted, renamed, or via the named seam — has to emit the warning.
 *
 * `parseAsync` rather than `parse`: the action is async, and
 * `cmd-parse-stub-gate` deliberately exempts the async spelling because the
 * unhandled-rejection trap it guards is specific to the sync one. The action is
 * NOT stubbed here — running it is the entire point.
 */

const captured: { strategy?: EmulatorStrategy; extraStateProviders?: unknown } = {};

vi.mock('../../../src/cli/commands/ecs-service-emulator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/cli/commands/ecs-service-emulator.js')>();
  return {
    ...actual,
    // Everything else stays REAL — `albStrategy` in particular, so the
    // captured object is the production strategy, decorated or not.
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
  captured.strategy = undefined;
  const cmd = createLocalStartAlbCommand();
  await cmd.parseAsync(argv, { from: 'user' });
  // A receipt, not politeness: if the action ever stops reaching the engine,
  // every assertion below would otherwise fail as "cannot read resolveBoots of
  // undefined" and read as a broken mock rather than a broken wiring.
  const { strategy } = captured;
  if (strategy === undefined) {
    throw new Error('the action never called runEcsServiceEmulator');
  }
  return strategy;
}

const warningsFor = (strategy: EmulatorStrategy): string[] =>
  strategy.resolveBoots(stacks as never, ['Alb16C2F182']).warnings;

describe('the strategy `cdkd local start-alb` hands the engine', () => {
  it('warns about the Lambda target group under --from-state', async () => {
    const strategy = await strategyHandedToEngine(['My/Alb', '--from-state']);
    const warned = warningsFor(strategy).join('\n');
    expect(warned).toContain('does not reach the container environment');
    expect(warned).toContain('ApiFnE0725F78');
  });

  it('says the ECS half still works, because this ALB has one', async () => {
    // The `ecsNote` PRESENT branch. Round 3 measured that replacing the
    // literal with '' left 35/35 green — only the OMIT arm was fenced. This
    // plan resolves one ECS boot AND one Lambda, so both halves of the
    // conditional are exercised across this case and its sibling in
    // local-start-alb.test.ts.
    const strategy = await strategyHandedToEngine(['My/Alb', '--from-state']);
    const { boots, warnings } = strategy.resolveBoots(stacks as never, ['Alb16C2F182']);
    expect(boots).toEqual([{ target: 'LiveAlbProbeStack:WebService7F8A1763' }]);
    expect(warnings.join('\n')).toContain(
      'The ECS service targets behind this ALB DO honor --from-state.'
    );
  });

  it('names the working state source in the remedy', async () => {
    // The remedy sentence was reworded in review round 3 (it used to tell the
    // user to add a flag they may already have set); nothing asserted the new
    // tokens.
    const strategy = await strategyHandedToEngine(['My/Alb', '--from-state']);
    const warned = warningsFor(strategy).join('\n');
    expect(warned).toContain('The only state source the Lambda path reads is --from-cfn-stack');
    expect(warned).toContain('--env-vars');
    expect(warned).toContain('go-to-k/cdk-local#707');
  });

  it('stays silent on the same ALB without --from-state', async () => {
    const strategy = await strategyHandedToEngine(['My/Alb']);
    expect(warningsFor(strategy).join('\n')).not.toContain(
      'does not reach the container environment'
    );
  });

  it('hands the engine cdkd state-source registry, not a re-made one', async () => {
    await strategyHandedToEngine(['My/Alb', '--from-state']);
    expect(captured.extraStateProviders).toBe(cdkdExtraStateProviders);
  });
});
