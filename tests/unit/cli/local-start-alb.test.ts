import { describe, expect, it } from 'vite-plus/test';
import {
  parseLbPortOverrides,
  resolveAlbTarget,
  createLocalStartAlbCommand,
} from '../../../src/cli/commands/local-start-alb.js';
import { LocalStartServiceError } from '../../../src/utils/error-handler.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

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
