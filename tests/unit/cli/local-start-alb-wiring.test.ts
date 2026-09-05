import { describe, expect, it, vi } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
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
 * The bound, and it is stated narrowly because FOUR earlier revisions of this
 * comment each claimed more than they delivered and each was falsified by the
 * next round. What is actually held:
 *
 * - every option the command DECLARES is PASSED, derived from `cmd.options`,
 *   with a coverage case that fails if one is added and not varied;
 * - each is passed with a VALUE its commander default cannot produce, and an
 *   optional-argument option gets a string rather than the bare boolean form;
 * - the variadic positional is driven at zero, one and many.
 *
 * What still escapes, measured rather than guessed: a conditional keyed on a
 * COMBINATION of flags (the matrix is one option at a time), on a SPECIFIC
 * value out of several an option accepts, or on something that is not argv at
 * all (an env var, `isTTY`, the clock). Closing the first two means a
 * combinatorial matrix, which buys less than it costs — the plausible refactor
 * is "the user passed X", and that is what is fenced.
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

/**
 * Every `--long` the command declares, in declaration order.
 *
 * REFUSES a short-only option rather than filtering it away. Round 7 added an
 * `-Z <v>` option plus a conditional keyed on it: the old `.filter()` dropped
 * it, the coverage case never mentioned it, and the mutant was green. A
 * narrowing that silently discards its awkward input is a hole wearing a type
 * guard's clothes — every option this command has today is long-form, so the
 * refusal costs nothing until someone adds one, which is exactly when it
 * should speak up.
 */
function declaredLongs(command: Command): string[] {
  return command.options.map((option) => {
    if (typeof option.long !== 'string') {
      throw new Error(
        `start-alb declares a short-only option (${option.flags}); the wiring matrix keys on ` +
          '`--long`, so give it a long form or teach declaredLongs how to drive it.'
      );
    }
    return option.long;
  });
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
  // An argv-driven fence only sees the argv it drives, and a hand-written flag
  // list is a treadmill: review caught `--watch` slipping past the
  // unparameterised version, then `--env-vars` slipping past the first
  // hand-written list, then `--from-cfn-stack` and seven more slipping past
  // the second. Three rounds of adding one flag at a time is the signal to
  // change instrument, so the combinations are DERIVED from the command's own
  // option set instead of enumerated.
  //
  // `--from-cfn-stack` is why this matters rather than being tidiness. It is
  // the same refactor `--env-vars` was — "don't nag if they already passed the
  // working source" — keyed on the other flag named in the very same sentence
  // of the warning. A hand-written list will always be one plausible flag
  // short of the one someone actually writes.
  const cmd = createLocalStartAlbCommand();

  /**
   * A usable value per value-taking option. Two of these are parsed at PARSE
   * time by commander `argParser`s (`--max-tasks`, `--restart-policy`) and one
   * inside the real `albStrategy` (`--lb-port`), so a junk value would throw
   * before the wiring is ever exercised and the case would fail for the wrong
   * reason. The rest are consumed inside the mocked engine and never read.
   */
  const SAMPLE_VALUES: Record<string, string> = {
    '--state-bucket': 'cdkd-state-111122223333',
    // NOT the commander default `cdkd` — see the sample-vs-default case below.
    '--state-prefix': 'custom-prefix',
    // Optional-argument options (`[arg]`). Passed BARE, commander sets them to
    // boolean `true`, and every `typeof options.x === 'string'` conditional
    // survives — which is the shape a real refactor keyed on one of these
    // takes, since it wants the NAME, not the flag's presence.
    '--from-cfn-stack': 'DeployedStack',
    '--assume-role': 'arn:aws:iam::111122223333:role/Task',
    '--assume-task-role': 'arn:aws:iam::111122223333:role/LegacyTask',
    '--image-override': 'Svc=Dockerfile',
    '--image-build-arg': 'KEY=VAL',
    '--image-build-secret': 'id=src',
    '--image-target': 'build',
    '--lb-port': '80=8080',
    '--tls-cert': 'cert.pem',
    '--tls-key': 'key.pem',
    '--bearer-token': 'jwt',
    '--cluster': 'cdkd-local',
    '--env-vars': 'overrides.json',
    '--container-host': '127.0.0.2',
    '--ecr-role-arn': 'arn:aws:iam::111122223333:role/EcrPull',
    '--platform': 'linux/amd64',
    '--max-tasks': '5',
    '--restart-policy': 'none',
    '--stack-region': 'us-west-2',
    '--shadow-ready-timeout': '1000',
    '--profile': 'dev',
    '--role-arn': 'arn:aws:iam::111122223333:role/Deploy',
    '--app': 'cdk.out',
    '--output': 'other-cdk-out',
    '--context': 'key=value',
    '--region': 'us-west-2',
  };

  /**
   * Options deliberately not varied, each with the reason — and PINNED, not
   * merely documented. Probed: without the identity assertion below, adding an
   * entry here for a real flag silences the coverage check for it, so the
   * escape hatch quietly becomes the hole. One entry is expected; a second is
   * a decision someone has to make out loud.
   */
  const NOT_VARIED: Record<string, string> = {
    '--from-state': 'the subject of every case; it is always passed.',
  };
  const EXPECTED_NOT_VARIED = ['--from-state'];

  const FLAG_COMBINATIONS: string[][] = [
    [],
    ...declaredLongs(cmd)
      .filter((long) => NOT_VARIED[long] === undefined)
      .map((long) => {
        const value = SAMPLE_VALUES[long];
        return value === undefined ? [long] : [long, value];
      }),
  ];

  it('varies every option the command declares', () => {
    // The half that makes DERIVING worth more than enumerating: an option
    // added upstream (this command inherits most of its block from cdk-local)
    // enters the matrix on its own, and one that cannot be varied has to say
    // why here rather than being quietly absent.
    const declared = declaredLongs(cmd);
    const varied = new Set(FLAG_COMBINATIONS.flatMap((argv) => argv.slice(0, 1)));
    expect(
      declared.filter((long) => !varied.has(long) && NOT_VARIED[long] === undefined).sort(),
      'These options are declared by `start-alb` but never varied, so a conditional keyed on ' +
        'one would hand the engine an undecorated strategy with this file green. Add a value ' +
        'to SAMPLE_VALUES (or nothing, for a boolean), or record why in NOT_VARIED.'
    ).toEqual([]);
    // ...and a stale SAMPLE_VALUES / NOT_VARIED entry for an option that no
    // longer exists is dead weight that outlives the flag it described.
    const declaredSet = new Set(declared);
    expect(
      [...Object.keys(SAMPLE_VALUES), ...Object.keys(NOT_VARIED)]
        .filter((long) => !declaredSet.has(long))
        .sort(),
      'These SAMPLE_VALUES / NOT_VARIED entries name options `start-alb` no longer declares.'
    ).toEqual([]);
    // A sample equal to the option's own default varies PRESENCE but not
    // VALUE, so every `options.x !== <default>` conditional survives. Round 7
    // measured three of them shipping that way (`--state-prefix` `cdkd`,
    // `--output` `cdk.out`, `--container-host` `127.0.0.1`) and showed the
    // class was systematic by planting a fourth: nothing compared a sample
    // against `option.defaultValue`. Now something does.
    const defaultsByLong = new Map(
      cmd.options.map((option) => [option.long, option.defaultValue] as const)
    );
    expect(
      Object.entries(SAMPLE_VALUES)
        .filter(([long, value]) => String(defaultsByLong.get(long) ?? '\u0000') === value)
        .map(([long]) => long)
        .sort(),
      'These SAMPLE_VALUES equal their option\'s commander default, so the case varies whether ' +
        'the flag was PASSED but not what it was set to — a conditional keyed on the value ' +
        'differing from the default would survive. Pick a value the default cannot produce.'
    ).toEqual([]);

    // NOT_VARIED is the one way to opt an option OUT of the check above, so it
    // is pinned rather than trusted. Measured: without this, excusing a real
    // flag (`--watch`) passed silently.
    expect(
      Object.keys(NOT_VARIED).sort(),
      'The set of options excused from variation has changed. Excusing one turns off the ' +
        'coverage check for it, which is exactly how a conditional keyed on that flag would ' +
        'hand the engine an undecorated strategy with this file green.'
    ).toEqual(EXPECTED_NOT_VARIED);
    // Anti-vacuity: an empty or truncated option list would satisfy the
    // assertions above while varying nothing.
    expect(declared.length).toBeGreaterThanOrEqual(35);
  });

  it('warns with no <targets> at all (the interactive-picker path)', async () => {
    // The positional is argv too, and a `targets.length === 0` conditional
    // survived the option-derived matrix — every case passed a target. Omitting
    // it is a real invocation: in a TTY the engine multi-selects interactively.
    const strategy = await strategyHandedToEngine(['--from-state']);
    expect(warningsFor(strategy).join('\n')).toContain('ApiFnE0725F78');
  });

  it('warns with MULTIPLE <targets>', async () => {
    // The positional is variadic, and closing `targets.length === 0` left
    // `targets.length > 1` one line away — measured surviving in round 7. Both
    // ends of the count are now driven.
    const strategy = await strategyHandedToEngine(['My/Alb', 'My/OtherAlb', '--from-state']);
    expect(warningsFor(strategy).join('\n')).toContain('ApiFnE0725F78');
  });

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
