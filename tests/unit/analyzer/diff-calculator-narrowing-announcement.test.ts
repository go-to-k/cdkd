import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: childLogger.debug,
      info: childLogger.info,
      warn: childLogger.warn,
      error: childLogger.error,
    }),
  };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { makeCanonicalizePropertiesFn } from '../../../src/provisioning/canonicalize-properties.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * The diff announces a provider narrowing because that path never calls the
 * provider, so without it a template edit to a discarded key produces no output
 * at all (issue #1591).
 *
 * But the announcement was unconditional on "the canonicalizer changed
 * something", and issue #1633 added a narrowing that changes a value IN PLACE
 * rather than dropping a key: an unquoted-YAML `IpProtocol: -1` is stringified
 * to `'-1'` before it is sent. Every clause of the warning is FALSE for that
 * case — the value IS sent, it is NOT ignored, and a change to it DOES take
 * effect — so it fired on every `cdkd diff` and every `cdkd deploy` of an
 * otherwise-unchanged stack, telling the user their template was broken when it
 * was not. (Caught by review of PR #1641; the live proof there asserted only
 * "No changes" and exit 0, so it never looked at the warning.)
 *
 * The discriminator is whether a declared KEY disappeared.
 */
describe('DiffCalculator narrowing announcement is LOSSY-only (#1633)', () => {
  const provider = new EC2Provider();
  const canonicalize = makeCanonicalizePropertiesFn({
    hasProvider: () => true,
    getProvider: () => provider,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
  });

  const stateOf = (resourceType: string, properties: Record<string, unknown>): StackState =>
    ({
      version: 3,
      region: 'us-east-1',
      stackName: 's',
      resources: { R: { physicalId: 'p-1', resourceType, properties, attributes: {} } },
      outputs: {},
      lastModified: 0,
    }) as unknown as StackState;

  const templateOf = (
    resourceType: string,
    properties: Record<string, unknown>
  ): CloudFormationTemplate => ({ Resources: { R: { Type: resourceType, Properties: properties } } });

  const narrowingWarnings = (): string[] =>
    childLogger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('cannot be sent as declared'));

  it('WARNS and names the dropped key when a narrowing DISCARDS one (Route, #1591)', async () => {
    // The case the announcement exists for: the losing destination key is
    // silently discarded, so a user editing it would otherwise see nothing.
    await new DiffCalculator().calculateDiff(
      stateOf('AWS::EC2::Route', { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' }),
      templateOf('AWS::EC2::Route', {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/16',
        DestinationIpv6CidrBlock: '::/0',
      }),
      undefined,
      canonicalize
    );

    const warnings = narrowingWarnings();
    expect(warnings).toHaveLength(1);
    // Naming the key is what makes the message actionable — "part of the
    // declared properties" alone does not tell the user which one.
    expect(warnings[0]).toContain('DestinationIpv6CidrBlock');
  });

  it('does NOT warn when the narrowing only REWRITES a value (SecurityGroupIngress, #1633)', async () => {
    // Same key set on both sides: `-1` becomes `'-1'`. Nothing is discarded, so
    // the "ignored / no effect" message would be a lie.
    await new DiffCalculator().calculateDiff(
      stateOf('AWS::EC2::SecurityGroupIngress', { GroupId: 'sg-1', IpProtocol: '-1' }),
      templateOf('AWS::EC2::SecurityGroupIngress', { GroupId: 'sg-1', IpProtocol: -1 }),
      undefined,
      canonicalize
    );

    expect(narrowingWarnings()).toEqual([]);
  });

  it('the rewritten-value case still compares EQUAL — silence is not a skipped diff', async () => {
    // Fences the row above against passing for the wrong reason: if the
    // canonicalizer had simply not run, there would also be no warning — but
    // the diff would then report a CHANGE (and `IpProtocol` is create-only, so
    // a REPLACEMENT).
    const changes = await new DiffCalculator().calculateDiff(
      stateOf('AWS::EC2::SecurityGroupIngress', { GroupId: 'sg-1', IpProtocol: '-1' }),
      templateOf('AWS::EC2::SecurityGroupIngress', { GroupId: 'sg-1', IpProtocol: -1 }),
      undefined,
      canonicalize
    );

    expect(changes.get('R')?.changeType).toBe('NO_CHANGE');
  });

  it('no canonicalizer at all means no announcement', async () => {
    await new DiffCalculator().calculateDiff(
      stateOf('AWS::EC2::Route', { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' }),
      templateOf('AWS::EC2::Route', {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/16',
        DestinationIpv6CidrBlock: '::/0',
      })
    );

    expect(narrowingWarnings()).toEqual([]);
  });
});
