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
 *    // NOTE: historically this read buildAlbEmulatorStrategy(options), here.
 *    const chosen = albStrategy(options);
 *    await runEcsServiceEmulator(targets, options, chosen, cdkdExtraStateProviders);
 *    ```
 *
 *    The comment line is part of the mutation, not decoration: it is what
 *    satisfied the positive `toContain`, since the module's only other
 *    occurrence of that call text is the call the mutation removes.
 *
 *    35/35 stayed green while the engine received an UNDECORATED strategy —
 *    i.e. the warning never reaches a user, the exact regression the case was
 *    written for. A whole-file `toContain` has no anchor to the call, and the
 *    negative pattern's `[^)]*` cannot cross the `)` the hoist puts in the way.
 *
 * So the question is answered BEHAVIOURALLY instead: run the real command
 * through commander, capture the third argument the action passes to
 * `runEcsServiceEmulator`, and drive THAT object. However the action builds it
 * — inline, hoisted, renamed, no-op-wrapped, or via the named seam — the
 * object that reaches the engine has to emit the warning. Measured against ten
 * such spellings in review round 4; every one reddens.
 *
 * The bound, stated because an over-claim here is the same defect as a fence
 * that cannot see: this is ARGV-DRIVEN, so it sees only the argv it drives. A
 * conditional keyed on a flag no case varies escapes it, and round 5 measured
 * exactly that — `--env-vars` slipped past the first parameterisation. The
 * cases below now vary every flag a branch would plausibly key on; a
 * conditional keyed on something OUTSIDE the argv (an env var, `isTTY`, the
 * clock) still gets through, and no argv-driven case can close that.
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
  // cdk-local wraps this action in `withErrorHandling`, whose `handleError`
  // ends in `process.exit(1)`. Unspied, a regression that makes the action
  // THROW would take the vitest worker down instead of failing the case — the
  // run would report a crashed worker, not a broken wiring, which is exactly
  // the diagnosis the receipt below exists to give. Convert the exit into a
  // throw so it surfaces as a normal failure.
  const exit = vi
    .spyOn(process, 'exit')
    .mockImplementation(((code?: number) => {
      throw new Error(`the action exited (${code}) instead of reaching the engine`);
    }) as never);
  try {
    captured.strategy = undefined;
    captured.extraStateProviders = undefined;
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
  } finally {
    exit.mockRestore();
  }
}

const warningsFor = (strategy: EmulatorStrategy): string[] =>
  strategy.resolveBoots(stacks as never, ['Alb16C2F182']).warnings;

/**
 * The exact text a user sees on this ALB, which has BOTH an ECS service target
 * and a Lambda target group. Its Lambda-only sibling (the same string without
 * the ECS sentence) is asserted in `local-start-alb.test.ts`; keeping the two
 * literals apart is deliberate — a reword must be made in both places, which
 * is the point for a message that is the entire remedy.
 */
const EXPECTED_WARNING_WITH_ECS_NOTE =
  "--from-state does not reach the container environment of this ALB's Lambda target " +
  'group(s): ApiFnE0725F78. Their Environment.Variables keep any Ref / Fn::GetAtt / ' +
  'Fn::Sub / Fn::ImportValue intrinsics unresolved, and each is then dropped with its own ' +
  'warning. The ECS service targets behind this ALB DO honor --from-state. The only state ' +
  'source the Lambda path reads is --from-cfn-stack <name>, which REPLACES --from-state ' +
  '(the two are mutually exclusive) and reaches both target kinds on a ' +
  'CloudFormation-deployed stack; otherwise override the affected variables with ' +
  '--env-vars. Tracked as go-to-k/cdkd#2602 (upstream go-to-k/cdk-local#707).';

describe('the strategy `cdkd local start-alb` hands the engine', () => {
  // An argv-driven fence only sees the argv it drives. Review round 4 measured
  // that a conditional keyed on a flag this file never varied —
  // `options.watch ? albStrategy(options) : buildAlbEmulatorStrategy(options)`
  // — survived the whole `tests/unit/cli` suite, so `start-alb --from-state
  // --watch` would hand the engine an undecorated strategy. These are the
  // flags a branch would plausibly key on, driven alongside `--from-state`.
  //
  // The residual bound is real and worth stating rather than papering over: a
  // conditional keyed on something else entirely (a random value, an env var,
  // `isTTY`) still escapes. What this closes is the plausible-refactor class,
  // not every conceivable one.
  //
  // `--env-vars` is here because round 5 measured it surviving the first
  // parameterisation, and it is the MOST plausible key of the lot: "don't nag
  // if they already overrode the variables" is a refactor someone would write
  // on purpose, keyed on the very flag this warning's remedy names.
  const FLAG_COMBINATIONS: string[][] = [
    [],
    ['--watch'],
    ['--tls'],
    ['--lb-port', '80=8080'],
    ['--no-pull'],
    ['--env-vars', 'overrides.json'],
    ['--profile', 'dev'],
    ['--stack-region', 'us-west-2'],
    ['--bearer-token', 'jwt'],
    ['--no-verify-auth'],
  ];

  it.each(FLAG_COMBINATIONS)(
    'warns about the Lambda target group under --from-state %s',
    async (...extra: string[]) => {
      const strategy = await strategyHandedToEngine(['My/Alb', '--from-state', ...extra]);
      const warned = warningsFor(strategy).join('\n');
      expect(warned).toContain('does not reach the container environment');
      expect(warned).toContain('ApiFnE0725F78');
    }
  );

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
    // Asserted WHOLE, not as a span. A span was tried and covered 3 of the
    // source's 9 concatenation seams — and the first seam it missed sat
    // directly beside the one it covered, so `(upstreamgo-to-k/cdk-local#707)`
    // shipped green. A `toContain` can only ever fence the seams inside it;
    // equality fences all of them, and this string IS the remedy, so coupling
    // a reword to a test edit is the right trade.
    expect(warned).toBe(EXPECTED_WARNING_WITH_ECS_NOTE);
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
