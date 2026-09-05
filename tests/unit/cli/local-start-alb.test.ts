import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartAlbCommand,
  warnUnresolvedLambdaTargetEnv,
} from '../../../src/cli/commands/local-start-alb.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import type {
  EmulatorStrategy,
  FrontDoorPlan,
  PlannedForwardTarget,
  PlannedFrontDoorListener,
} from '../../../src/cli/commands/ecs-service-emulator.js';

// Unit coverage for the cdkd-specific wiring around `cdkd local start-alb`:
// the `--from-state` / `--state-bucket` / `--state-prefix` flags the host
// adds on top of cdk-local's shared option block, and the
// `cdkdExtraStateProviders` singleton that local-start-alb.ts forwards into
// `runEcsServiceEmulator`. The pure-functional helpers (`parseLbPortOverrides`
// / `resolveAlbTarget` / `albStrategy`) and the ALB-specific option block
// (`--lb-port` / `--tls` / `--tls-cert` / `--tls-key` / `--no-verify-auth` /
// `--bearer-token`) live in cdk-local now and are covered by cdk-local's own
// tests; cdkd inherits them via `addAlbSpecificOptions`. End-to-end behavior
// is exercised by the `local-start-alb-from-state` real-AWS integ fixture.

describe('createLocalStartAlbCommand', () => {
  // `cmd.parse([...])` runs the registered `.action(handler)` body. The
  // production handler hits real synthesis / docker; stub to a no-op so
  // parse() only exercises Commander's option parser. The
  // cmd-parse-stub-gate hook enforces this stub for any cmd.parse() in
  // tests.
  const cmd = createLocalStartAlbCommand();
  cmd.action(() => {});

  it('registers the start-alb subcommand name', () => {
    expect(cmd.name()).toBe('start-alb');
  });

  it('accepts variadic positional targets', () => {
    const args = cmd.registeredArguments.map((a) => a.name());
    expect(args).toEqual(['targets']);
    expect(cmd.registeredArguments[0]?.variadic).toBe(true);
  });

  it('inherits the ALB-specific options from addAlbSpecificOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--lb-port');
    expect(longs).toContain('--tls');
    expect(longs).toContain('--tls-cert');
    expect(longs).toContain('--tls-key');
    expect(longs).toContain('--no-verify-auth');
    expect(longs).toContain('--bearer-token');
  });

  it('declares the cdkd state-source options', () => {
    // --from-state / --state-bucket / --state-prefix are the cdkd-specific
    // flags layered on top of cdk-local's --from-cfn-stack / --stack-region
    // (which addCommonEcsServiceOptions provides).
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });

  it('inherits --from-cfn-stack + --stack-region from addCommonEcsServiceOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-cfn-stack');
    expect(longs).toContain('--stack-region');
  });

  it('inherits the common ECS service options from addCommonEcsServiceOptions', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--cluster');
    expect(longs).toContain('--env-vars');
    expect(longs).toContain('--container-host');
    expect(longs).toContain('--max-tasks');
    expect(longs).toContain('--restart-policy');
    expect(longs).toContain('--no-pull');
  });

  it('defaults --from-state to false', () => {
    const opt = cmd.options.find((o) => o.long === '--from-state');
    expect(opt?.defaultValue).toBe(false);
  });

  it("defaults --state-prefix to 'cdkd'", () => {
    const opt = cmd.options.find((o) => o.long === '--state-prefix');
    expect(opt?.defaultValue).toBe('cdkd');
  });

  it('parses --from-state as a flag (no value)', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Alb', '--from-state'], { from: 'user' });
    expect(parsed.opts().fromState).toBe(true);
  });

  it('parses --state-bucket <bucket>', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['node', 'cdkd', 'My/Alb', '--state-bucket', 'cdkd-state-123'],
      { from: 'user' }
    );
    expect(parsed.opts().stateBucket).toBe('cdkd-state-123');
  });

  it('parses --lb-port as a variadic that builds an array', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(
      ['node', 'cdkd', 'My/Alb', '--lb-port', '80=8080', '443=8443'],
      { from: 'user' }
    );
    expect(parsed.opts().lbPort).toEqual(['80=8080', '443=8443']);
  });

  it('parses --tls as a boolean flag (no value)', () => {
    const fresh = createLocalStartAlbCommand();
    fresh.action(() => {});
    const parsed = fresh.parse(['node', 'cdkd', 'My/Alb', '--tls'], { from: 'user' });
    expect(parsed.opts().tls).toBe(true);
  });
});

describe('cdkdExtraStateProviders (engine wiring)', () => {
  // The 4th-arg `extraStateProviders` passed to runEcsServiceEmulator is the
  // whole point of the --from-state plumbing. Pin the export's shape AND
  // assert local-start-alb.ts imports + forwards exactly this constant
  // (rather than a one-off { fromState: () => ... }).
  it('exports a single `fromState` factory entry', () => {
    expect(Object.keys(cdkdExtraStateProviders).sort()).toEqual(['fromState']);
    expect(typeof cdkdExtraStateProviders.fromState).toBe('function');
  });

  it('is the SAME object reference imported by local-state-source', async () => {
    // Identity check: tsdown / rolldown's ESM bundling preserves named-export
    // identity, so an accidental re-construction in local-start-alb.ts (e.g.
    // `runEcsServiceEmulator(..., { fromState: fromStateFactory })`) would
    // make a NEW object and fail this assertion. The wiring contract is
    // "forward the exported singleton verbatim" — pin it.
    const { cdkdExtraStateProviders: viaStateSource } = await import(
      '../../../src/cli/commands/local-state-source.js'
    );
    expect(viaStateSource).toBe(cdkdExtraStateProviders);
  });
});

describe('warnUnresolvedLambdaTargetEnv (issue #2602)', () => {
  // `--from-state` is PARTIAL on start-alb: the ECS service targets honor it,
  // a `TargetType: lambda` target group's container env does not, because
  // cdk-local's `resolveAlbLambdaTargetEnv` hands the shared Lambda env
  // resolver a six-key allow-list that drops `fromState` / `stateBucket` /
  // `statePrefix` (cdk-local@0.147.7 `dist/local-studio-BBtUAVNy.js:26619`).
  // The wrapper turns that silence into a boot warning naming the affected
  // functions. cdkd cannot make the path WORK -- that is upstream
  // go-to-k/cdk-local#707 -- so what is fenced here is the warning's TRIGGER
  // (a Lambda target AND --from-state), its non-trigger cases, and that it
  // never replaces the strategy's own warnings.

  const ecsTarget = (serviceTarget: string): PlannedForwardTarget => ({
    kind: 'ecs',
    serviceTarget,
    targetContainerName: 'web',
    targetContainerPort: 80,
    weight: 1,
  });

  // Only `lambda.logicalId` is read by the collector; the rest of
  // `ResolvedLambda` is irrelevant to it, hence the narrow cast at this one
  // fixture boundary rather than a 20-field stub whose extra fields would
  // suggest the collector reads them.
  const lambdaTarget = (logicalId: string): PlannedForwardTarget =>
    ({
      kind: 'lambda',
      lambda: { logicalId },
      targetGroupArn: `Stack:${logicalId}Tg`,
      multiValueHeaders: false,
      weight: 1,
    }) as unknown as PlannedForwardTarget;

  const listener = (opts: {
    defaultTargets?: PlannedForwardTarget[];
    ruleTargets?: PlannedForwardTarget[];
  }): PlannedFrontDoorListener => ({
    listenerPort: 80,
    hostPort: 8080,
    protocol: 'HTTP',
    ...(opts.defaultTargets !== undefined && {
      defaultAction: { kind: 'forward', targets: opts.defaultTargets },
    }),
    rules:
      opts.ruleTargets === undefined
        ? []
        : [
            {
              priority: 10,
              pathPatterns: ['/api/*'],
              hostPatterns: [],
              httpHeaderConditions: [],
              httpRequestMethods: [],
              queryStringConditions: [],
              sourceIpCidrs: [],
              action: { kind: 'forward', targets: opts.ruleTargets },
            },
          ],
  });

  /**
   * A stand-in `EmulatorStrategy` that records how many times `resolveBoots`
   * was called and returns the supplied plan + warnings. Deliberately NOT
   * `albStrategy(...)`: the wrapper's contract is "decorate whatever the
   * inner strategy returned", and driving the inner one through a real
   * synthesized stack would make the test about cdk-local's ALB resolver.
   */
  const stubStrategy = (
    frontDoor: FrontDoorPlan | undefined,
    warnings: string[] = []
  ): EmulatorStrategy & { calls: number } => {
    const strategy = {
      calls: 0,
      pickEntries: () => [],
      pickerMessage: 'pick',
      pickerNoun: 'noun',
      onMissing: () => new Error('missing') as never,
      lbPortOverrides: { 80: 8080 },
      supportsWatch: true,
      resolveBoots: (_stacks: never[], chosenTargets: string[]) => {
        strategy.calls += 1;
        return {
          boots: chosenTargets.map((target) => ({ target })),
          ...(frontDoor !== undefined && { frontDoor }),
          warnings: [...warnings],
        };
      },
    };
    return strategy as unknown as EmulatorStrategy & { calls: number };
  };

  const run = (strategy: EmulatorStrategy, fromState: boolean) =>
    warnUnresolvedLambdaTargetEnv(strategy, { fromState }).resolveBoots(
      [] as never,
      ['Stack/Alb']
    );

  const lambdaWarnings = (warnings: string[]): string[] =>
    warnings.filter((w) => w.includes('does not reach the container environment'));

  it('warns and names the Lambda a listener default action forwards to', () => {
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [lambdaTarget('ApiFn')] })],
    };
    const warned = lambdaWarnings(run(stubStrategy(plan), true).warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('ApiFn');
  });

  it('walks listener RULE actions too, not just the default action', () => {
    // The discriminator for a collector that only reads `defaultAction`: the
    // ONLY Lambda in this plan hangs off a path-pattern rule, and the default
    // action forwards to an ECS service. A defaultAction-only walk returns []
    // here and emits nothing.
    const plan: FrontDoorPlan = {
      listeners: [
        listener({
          defaultTargets: [ecsTarget('Stack:Web')],
          ruleTargets: [lambdaTarget('RuleOnlyFn')],
        }),
      ],
    };
    const warned = lambdaWarnings(run(stubStrategy(plan), true).warnings);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('RuleOnlyFn');
  });

  it('names every distinct Lambda once, sorted, across listeners', () => {
    const plan: FrontDoorPlan = {
      listeners: [
        listener({ defaultTargets: [lambdaTarget('ZFn'), lambdaTarget('AFn')] }),
        // `ZFn` again on a second listener -- deduplicated, not repeated.
        listener({ defaultTargets: [lambdaTarget('ZFn')] }),
      ],
    };
    const warned = lambdaWarnings(run(stubStrategy(plan), true).warnings);
    expect(warned).toHaveLength(1);
    // Substring-matched on the rendered LIST, so a collector that emitted
    // duplicates or reverse order fails here rather than passing on a
    // set-equality check the rendering never performs.
    expect(warned[0]).toContain('target group(s): AFn, ZFn.');
  });

  it('stays SILENT on an ALB whose only targets are ECS services', () => {
    // The over-warning arm: `--from-state` DOES work for these, so a wrapper
    // that warned whenever the flag is set would be wrong on the common case.
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [ecsTarget('Stack:Web')] })],
    };
    expect(lambdaWarnings(run(stubStrategy(plan), true).warnings)).toEqual([]);
  });

  it('stays SILENT without --from-state, even with a Lambda target', () => {
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [lambdaTarget('ApiFn')] })],
    };
    expect(lambdaWarnings(run(stubStrategy(plan), false).warnings)).toEqual([]);
  });

  it('returns the inner strategy UNWRAPPED without --from-state', () => {
    // Identity, not behavior: the non-state path must carry no decorator at
    // all, so a future change to the wrapper cannot affect it.
    const inner = stubStrategy(undefined);
    expect(warnUnresolvedLambdaTargetEnv(inner, { fromState: false })).toBe(inner);
    expect(warnUnresolvedLambdaTargetEnv(inner, { fromState: true })).not.toBe(inner);
  });

  it('APPENDS to the strategy warnings rather than replacing them', () => {
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [lambdaTarget('ApiFn')] })],
    };
    const { warnings } = run(stubStrategy(plan, ['upstream said this']), true);
    expect(warnings[0]).toBe('upstream said this');
    expect(warnings).toHaveLength(2);
  });

  it('passes boots and the front-door plan through untouched', () => {
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [lambdaTarget('ApiFn')] })],
    };
    const strategy = stubStrategy(plan);
    const resolved = run(strategy, true);
    expect(resolved.boots).toEqual([{ target: 'Stack/Alb' }]);
    expect(resolved.frontDoor).toBe(plan);
    // One inner call per wrapper call -- the wrapper must not re-resolve the
    // plan to find the Lambda targets (a second synth-backed resolve is the
    // cost this design exists to avoid).
    expect(strategy.calls).toBe(1);
  });

  it('tolerates a plan with no front door at all', () => {
    expect(lambdaWarnings(run(stubStrategy(undefined), true).warnings)).toEqual([]);
  });

  it('preserves the non-resolveBoots strategy surface', () => {
    // The wrapper spreads the inner strategy; a wrapper built from scratch
    // would silently drop `lbPortOverrides` (`--lb-port` stops working) or
    // `supportsWatch` (`--watch` stops working).
    const wrapped = warnUnresolvedLambdaTargetEnv(stubStrategy(undefined), {
      fromState: true,
    });
    expect(wrapped.lbPortOverrides).toEqual({ 80: 8080 });
    expect(wrapped.supportsWatch).toBe(true);
    expect(wrapped.pickerNoun).toBe('noun');
  });

  it('points at the working alternatives and both tracking issues', () => {
    const plan: FrontDoorPlan = {
      listeners: [listener({ defaultTargets: [lambdaTarget('ApiFn')] })],
    };
    const [warned] = lambdaWarnings(run(stubStrategy(plan), true).warnings);
    // The message is the whole remedy here -- cdkd cannot fix the path -- so
    // the escape hatches and the upstream pointer are part of the contract.
    expect(warned).toContain('--from-cfn-stack');
    expect(warned).toContain('--env-vars');
    expect(warned).toContain('go-to-k/cdkd#2602');
    expect(warned).toContain('go-to-k/cdk-local#707');
  });
});

describe('start-alb --from-state help text', () => {
  it('records the Lambda-target carve-out', () => {
    // The flag is advertised unqualified everywhere else; go-to-k/cdkd#2602 is
    // that the advertisement was wider than the behavior.
    const help = createLocalStartAlbCommand()
      .options.find((o) => o.long === '--from-state')
      ?.description;
    expect(help).toContain('Lambda target group');
    expect(help).toContain('go-to-k/cdk-local#707');
  });
});
