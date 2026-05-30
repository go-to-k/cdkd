import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  parseLbPortOverrides,
  resolveAlbTarget,
  albStrategy,
  createLocalStartAlbCommand,
} from '../../../src/cli/commands/local-start-alb.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import { LocalStartServiceError } from '../../../src/utils/error-handler.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { EcsServiceEmulatorOptions } from '../../../src/cli/commands/ecs-service-emulator.js';
import * as frontDoor from '../../../src/local/elb-front-door-resolver.js';
import * as lambdaResolver from '../../../src/local/lambda-resolver.js';

// Unit coverage for the `cdkd local start-alb` command's pure-functional
// surface: the `--lb-port` parser, the ALB target resolver, and the
// option-builder smoke test (mirrors the agentcore + start-service patterns
// from PR #717 / #466). The end-to-end behavior is exercised by the
// `local-start-alb` real-AWS integ fixture.

describe('parseLbPortOverrides (`--lb-port` parser)', () => {
  it('returns an empty map for undefined input', () => {
    expect(parseLbPortOverrides(undefined)).toEqual({});
  });

  it('returns an empty map for empty array', () => {
    expect(parseLbPortOverrides([])).toEqual({});
  });

  it('parses a single override', () => {
    expect(parseLbPortOverrides(['80=8080'])).toEqual({ 80: 8080 });
  });

  it('parses multiple overrides', () => {
    expect(parseLbPortOverrides(['80=8080', '443=8443'])).toEqual({ 80: 8080, 443: 8443 });
  });

  it('trims surrounding whitespace', () => {
    expect(parseLbPortOverrides(['  80=8080  '])).toEqual({ 80: 8080 });
  });

  it('rejects the empty string', () => {
    expect(() => parseLbPortOverrides([''])).toThrow(LocalStartServiceError);
    expect(() => parseLbPortOverrides([''])).toThrow(/Invalid --lb-port ''/);
  });

  it('rejects malformed values without `=`', () => {
    expect(() => parseLbPortOverrides(['80'])).toThrow(/Invalid --lb-port '80'/);
    expect(() => parseLbPortOverrides(['8080'])).toThrow(/Invalid --lb-port '8080'/);
  });

  it('rejects non-numeric ports', () => {
    expect(() => parseLbPortOverrides(['80=abc'])).toThrow(/Invalid --lb-port '80=abc'/);
    expect(() => parseLbPortOverrides(['abc=8080'])).toThrow(/Invalid --lb-port 'abc=8080'/);
  });

  it('rejects ports <= 0', () => {
    expect(() => parseLbPortOverrides(['0=8080'])).toThrow(/listener port must be 1-65535/);
    expect(() => parseLbPortOverrides(['80=0'])).toThrow(/host port must be 1-65535/);
  });

  it('rejects ports > 65535', () => {
    expect(() => parseLbPortOverrides(['65536=8080'])).toThrow(/listener port must be 1-65535/);
    expect(() => parseLbPortOverrides(['80=65536'])).toThrow(/host port must be 1-65535/);
  });

  it('later entries win on duplicate listener ports (Object overwrite semantics)', () => {
    // Documented behavior: the map key is the listener port, so a repeated
    // `--lb-port 80=...` overwrites. A future PR could reject this as an
    // explicit error, but the current contract is overwrite — pinned here.
    expect(parseLbPortOverrides(['80=8080', '80=9090'])).toEqual({ 80: 9090 });
  });
});

describe('resolveAlbTarget', () => {
  // Minimal StackInfo shape sufficient for resolveAlbTarget — only `stackName`
  // and `template.Resources` are read by the function under test.
  function makeStack(stackName: string, resources: Record<string, unknown>): StackInfo {
    return {
      stackName,
      template: { Resources: resources },
    } as unknown as StackInfo;
  }

  const albResource = {
    Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    Properties: {},
  };
  const nonAlbResource = {
    Type: 'AWS::S3::Bucket',
    Properties: {},
  };

  it('throws when no stacks are provided', () => {
    expect(() => resolveAlbTarget('My/Alb', [])).toThrow(/No stacks found/);
  });

  it('resolves a stack:LogicalId target against a single ALB', () => {
    const stack = makeStack('MyStack', { MyAlb: albResource });
    const result = resolveAlbTarget('MyStack:MyAlb', [stack]);
    expect(result.stack.stackName).toBe('MyStack');
    expect(result.albLogicalId).toBe('MyAlb');
  });

  it('rejects a stack:LogicalId target where the resource is not an ALB', () => {
    const stack = makeStack('MyStack', { Bucket: nonAlbResource });
    expect(() => resolveAlbTarget('MyStack:Bucket', [stack])).toThrow(
      /did not match an application Load Balancer/
    );
  });

  it('lists available ALB logical ids when the named resource is missing', () => {
    const stack = makeStack('MyStack', {
      AlbA: albResource,
      AlbB: albResource,
      Bucket: nonAlbResource,
    });
    expect(() => resolveAlbTarget('MyStack:DoesNotExist', [stack])).toThrow(
      /Available load balancers in MyStack: AlbA, AlbB/
    );
  });

  it('reports an empty load-balancer list when the stack declares none', () => {
    const stack = makeStack('MyStack', { Bucket: nonAlbResource });
    expect(() => resolveAlbTarget('MyStack:Anything', [stack])).toThrow(
      /MyStack declares no AWS::ElasticLoadBalancingV2::LoadBalancer resources/
    );
  });

  it('auto-detects the single stack when no stack prefix is given', () => {
    const stack = makeStack('SoleStack', { MyAlb: albResource });
    const result = resolveAlbTarget('MyAlb', [stack]);
    expect(result.stack.stackName).toBe('SoleStack');
    expect(result.albLogicalId).toBe('MyAlb');
  });

  it('rejects an unprefixed target in a multi-stack assembly', () => {
    const a = makeStack('StackA', { MyAlb: albResource });
    const b = makeStack('StackB', { MyAlb: albResource });
    expect(() => resolveAlbTarget('MyAlb', [a, b])).toThrow(
      /has no stack prefix, and the assembly contains 2 stacks/
    );
  });

  it('rejects a stack pattern that matches no stack', () => {
    const stack = makeStack('MyStack', { MyAlb: albResource });
    expect(() => resolveAlbTarget('Other:MyAlb', [stack])).toThrow(
      /No stack matches 'Other'/
    );
  });
});

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

  it('declares the ALB-specific options', () => {
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--lb-port');
    expect(longs).toContain('--tls-cert');
    expect(longs).toContain('--tls-key');
    expect(longs).toContain('--no-verify-auth');
    expect(longs).toContain('--bearer-token');
  });

  it('declares the cdkd state-source options', () => {
    // --from-state / --state-bucket / --state-prefix are the cdkd-specific
    // flags this PR added on top of cdk-local's --from-cfn-stack /
    // --stack-region (which addCommonEcsServiceOptions provides).
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
});

describe('parseLbPortOverrides — port-range boundaries (G3)', () => {
  // The validator's range check is `< 1 || > 65535`. Pin the exact
  // boundaries so a future `<= 0` / `>= 65535` typo cannot silently
  // narrow the accepted range.
  it('accepts port 1 at the low boundary', () => {
    expect(parseLbPortOverrides(['1=1'])).toEqual({ 1: 1 });
  });

  it('accepts port 65535 at the high boundary', () => {
    expect(parseLbPortOverrides(['65535=65535'])).toEqual({ 65535: 65535 });
  });
});

describe('resolveAlbTarget — Stack/Path display-path form (G2)', () => {
  // Every other resolveAlbTarget test covers the `Stack:LogicalId`
  // (`isPath === false`) branch. The display-path branch goes through
  // `buildCdkPathIndex` + `resolveCdkPathToLogicalIds`, which needs each
  // template resource to carry a Metadata['aws:cdk:path'] entry.
  function makePathStack(
    stackName: string,
    resources: Record<string, { Type: string; Metadata?: Record<string, unknown> }>
  ): StackInfo {
    return {
      stackName,
      template: { Resources: resources },
    } as unknown as StackInfo;
  }

  const albResource = (cdkPath: string) => ({
    Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    Properties: {},
    Metadata: { 'aws:cdk:path': cdkPath },
  });

  it('resolves a Stack/Path target to the matching ALB logical id', () => {
    const stack = makePathStack('MyStack', {
      MyAlb01ABCDEF: albResource('MyStack/MyAlb/Resource'),
    });
    const result = resolveAlbTarget('MyStack/MyAlb', [stack]);
    expect(result.albLogicalId).toBe('MyAlb01ABCDEF');
  });

  it('throws when the CDK path matches more than one ALB', () => {
    // Two ALBs whose construct paths both prefix-match the input —
    // the function reports the ambiguity with both logical IDs so the
    // user can pick. Exact behavior pinned here because the only place
    // it surfaces in production is this error.
    const stack = makePathStack('MyStack', {
      MyAlb01ABC: albResource('MyStack/MyAlb/AlbA/Resource'),
      MyAlb02DEF: albResource('MyStack/MyAlb/AlbB/Resource'),
    });
    expect(() => resolveAlbTarget('MyStack/MyAlb', [stack])).toThrow(
      /matches 2 load balancers in MyStack: MyAlb01ABC, MyAlb02DEF/
    );
  });

  it('falls back to the available-ALBs list when the path matches no ALB', () => {
    const stack = makePathStack('MyStack', {
      OtherAlb: albResource('MyStack/OtherAlb/Resource'),
    });
    expect(() => resolveAlbTarget('MyStack/Missing', [stack])).toThrow(
      /Available load balancers in MyStack: OtherAlb/
    );
  });
});

describe('cdkdExtraStateProviders (G4 — engine wiring)', () => {
  // The 4th-arg `extraStateProviders` passed to runEcsServiceEmulator is the
  // whole point of this PR's --from-state plumbing. The action handler is
  // stubbed out in every cmd.parse() unit test, so this block exists to pin
  // the export's shape AND assert local-start-alb.ts imports + forwards
  // exactly this constant (rather than a one-off { fromState: () => ... }).
  it('exports a single `fromState` factory entry', () => {
    expect(Object.keys(cdkdExtraStateProviders).sort()).toEqual(['fromState']);
    expect(typeof cdkdExtraStateProviders.fromState).toBe('function');
  });

  it('is the SAME object reference imported by local-start-alb', async () => {
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

describe('albStrategy.resolveBoots (G1 — listener planning)', () => {
  // The strategy's resolveBoots is the load-bearing logic the integ fixture
  // exercises end-to-end but cannot interrogate at field level. Stub the
  // upstream resolveAlbFrontDoor (a re-export from cdk-local) to control
  // its return value, then call resolveBoots directly + assert the planned
  // boots / front-door listeners / warnings.

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Minimal StackInfo carrying just one ALB row so resolveAlbTarget passes.
  function makeStack(stackName: string): StackInfo {
    return {
      stackName,
      template: {
        Resources: {
          Alb: { Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', Properties: {} },
        },
      },
    } as unknown as StackInfo;
  }

  function makeOptions(over: Partial<EcsServiceEmulatorOptions> = {}): EcsServiceEmulatorOptions {
    return {
      output: 'cdk.out',
      verbose: false,
      cluster: 'cdkd-local',
      containerHost: '127.0.0.1',
      pull: true,
      maxTasks: 3,
      restartPolicy: 'on-failure',
      ...over,
    } as EcsServiceEmulatorOptions;
  }

  // Helpers to build resolver-shaped objects without importing the internal
  // type names (they live in cdk-local/internal but aren't re-exported by
  // cdkd's shim — using `as never` keeps the test self-contained).
  function ecsForward(serviceLogicalId: string, port = 8080, weight = 1) {
    return {
      kind: 'forward' as const,
      targets: [
        {
          kind: 'ecs' as const,
          serviceLogicalId,
          targetGroupLogicalId: `${serviceLogicalId}TG`,
          targetContainerName: 'web',
          targetContainerPort: port,
          weight,
        },
      ],
    };
  }

  function redirect() {
    return { kind: 'redirect' as const, statusCode: 302 as const, host: 'example.com' };
  }

  function fixedResponse(status = 200) {
    return { kind: 'fixed-response' as const, statusCode: status, contentType: 'text/plain' };
  }

  function resolution(
    listeners: Array<{
      listenerPort: number;
      defaultAction?: ReturnType<typeof ecsForward | typeof redirect | typeof fixedResponse>;
    }>,
    warnings: string[] = []
  ) {
    return {
      listeners: listeners.map((l) => ({
        listenerPort: l.listenerPort,
        listenerProtocol: 'HTTP',
        listenerLogicalId: `Listener${l.listenerPort}`,
        defaultAction: l.defaultAction,
        rules: [],
      })),
      warnings,
    } as never;
  }

  it('plans an ECS forward target into a service boot + ecs frontDoor target', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: ecsForward('Orders', 3000) }])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.boots).toEqual([{ target: 'MyStack:Orders' }]);
    expect(out.warnings).toEqual([]);
    expect(out.frontDoor?.listeners).toHaveLength(1);
    const listener = out.frontDoor!.listeners[0]!;
    expect(listener.listenerPort).toBe(80);
    expect(listener.hostPort).toBe(80);
    expect(listener.defaultAction?.kind).toBe('forward');
    expect((listener.defaultAction as { kind: 'forward'; targets: unknown[] }).targets[0]).toEqual({
      kind: 'ecs',
      serviceTarget: 'MyStack:Orders',
      targetContainerName: 'web',
      targetContainerPort: 3000,
      weight: 1,
    });
  });

  it('remaps the host port via --lb-port without changing the listener port', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: ecsForward('Web') }])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions({ lbPort: ['80=8080'] }));

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    const listener = out.frontDoor!.listeners[0]!;
    expect(listener.listenerPort).toBe(80);
    expect(listener.hostPort).toBe(8080);
  });

  it('warns + skips when two listeners would bind the same host port', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([
        { listenerPort: 80, defaultAction: ecsForward('Web') },
        // Without --lb-port, listener 443 also binds host port 443 (default).
        // With --lb-port 443=80, both listeners want host port 80; the 2nd
        // is dropped with a warning.
        { listenerPort: 443, defaultAction: ecsForward('WebTls') },
      ])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions({ lbPort: ['443=80'] }));

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.frontDoor!.listeners).toHaveLength(1);
    expect(out.frontDoor!.listeners[0]!.listenerPort).toBe(80);
    expect(out.warnings.some((w) => /already claimed by listener port 80/.test(w))).toBe(true);
  });

  it('warns when a --lb-port override matches no resolved listener (typo guard)', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: ecsForward('Web') }])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions({ lbPort: ['8080=80'] }));

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.warnings.some((w) => /override for listener port 8080 matched no ALB listener/.test(w))).toBe(
      true
    );
  });

  it('plans a redirect action verbatim (no backing service to boot)', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: redirect() }])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.boots).toEqual([]);
    const action = out.frontDoor!.listeners[0]!.defaultAction as {
      kind: 'redirect';
      statusCode: number;
      host?: string;
    };
    expect(action.kind).toBe('redirect');
    expect(action.statusCode).toBe(302);
    expect(action.host).toBe('example.com');
  });

  it('plans a fixed-response action verbatim (no backing service to boot)', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: fixedResponse(503) }])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.boots).toEqual([]);
    const action = out.frontDoor!.listeners[0]!.defaultAction as {
      kind: 'fixed-response';
      statusCode: number;
      contentType?: string;
    };
    expect(action.kind).toBe('fixed-response');
    expect(action.statusCode).toBe(503);
    expect(action.contentType).toBe('text/plain');
  });

  it('forwards resolver warnings into the boot result', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([{ listenerPort: 80, defaultAction: ecsForward('Web') }], [
        "Listener 'Listener443' on port 443 uses protocol TLS; skipping it.",
      ])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.warnings).toContain("Listener 'Listener443' on port 443 uses protocol TLS; skipping it.");
  });

  it('dedupes service boots when two listeners forward to the same service', () => {
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([
        { listenerPort: 80, defaultAction: ecsForward('Orders') },
        { listenerPort: 8080, defaultAction: ecsForward('Orders') },
      ])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    expect(out.boots).toEqual([{ target: 'MyStack:Orders' }]);
    expect(out.frontDoor!.listeners).toHaveLength(2);
  });

  it('qualifies a Lambda forward target via resolveLambdaTarget', () => {
    // Stub resolveLambdaTarget so we don't need a real ResolvedLambda
    // (which needs synthesis metadata for ZIP / IMAGE classification).
    vi.spyOn(lambdaResolver, 'resolveLambdaTarget').mockReturnValue({
      kind: 'zip',
      stack: { stackName: 'MyStack' },
      logicalId: 'MyFn',
    } as never);
    vi.spyOn(frontDoor, 'resolveAlbFrontDoor').mockReturnValue(
      resolution([
        {
          listenerPort: 80,
          defaultAction: {
            kind: 'forward' as const,
            targets: [
              {
                kind: 'lambda' as const,
                lambdaLogicalId: 'MyFn',
                targetGroupLogicalId: 'MyFnTG',
                multiValueHeaders: false,
                weight: 1,
              },
            ],
          },
        },
      ])
    );
    const stack = makeStack('MyStack');
    const strategy = albStrategy(makeOptions());

    const out = strategy.resolveBoots([stack], ['MyStack:Alb']);
    // No ECS boot — Lambda targets don't go through start-service.
    expect(out.boots).toEqual([]);
    const action = out.frontDoor!.listeners[0]!.defaultAction as {
      kind: 'forward';
      targets: Array<{ kind: string; lambda: unknown; targetGroupArn: string; multiValueHeaders: boolean }>;
    };
    expect(action.targets[0]?.kind).toBe('lambda');
    expect(action.targets[0]?.targetGroupArn).toBe('MyStack:MyFnTG');
    expect(action.targets[0]?.multiValueHeaders).toBe(false);
  });
});
