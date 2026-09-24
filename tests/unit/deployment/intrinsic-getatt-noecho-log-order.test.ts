import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

// go-to-k/cdkd#3659. Every `resolveGetAtt` branch serving a value out of the
// PERSISTED `attributes` bag logged it at debug level BEFORE
// `noteAttributeSecrecy`, the call that puts a `NoEcho` value into the
// CONSUMER's bag as a mask-only needle. The line's `displayMasked` masks
// against that bag, so it printed the plaintext at `--verbose` while state
// stayed masked. Measured on real AWS by `custom-resource-noecho-nested`.
//
// One case per serving branch, each with a CONTROL: the same read of an
// UNdeclared resource prints the value, which is what proves the line renders
// it at all and that the mask, not an absent line, is what the positive case
// observes.

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const NOECHO = 'handler-generated-token-3659';

function debugLines(prefix: string): string[] {
  return logSpies.debug.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith(prefix));
}

function contextFor(
  resource: Pick<ResourceState, 'resourceType' | 'attributes'> &
    Partial<Pick<ResourceState, 'properties' | 'physicalId'>>,
  opts: {
    declared?: true | ReadonlySet<string>;
    attributeHealer?: ResolverContext['attributeHealer'];
  } = {}
): { context: ResolverContext; recordedSecretValues: RecordedSecretValues } {
  const recordedSecretValues: RecordedSecretValues = new Map();
  const template: CloudFormationTemplate = {
    Resources: { Cr: { Type: resource.resourceType, Properties: {} } },
  };
  const context: ResolverContext = {
    template,
    resources: {
      Cr: {
        physicalId: resource.physicalId ?? 'cr-phys',
        resourceType: resource.resourceType,
        properties: resource.properties ?? {},
        attributes: resource.attributes,
        dependencies: [],
      },
    },
    recordedSecretValues,
    ...(opts.declared !== undefined && {
      noEchoAttributeResources: new Map<string, true | ReadonlySet<string>>([
        ['Cr', opts.declared],
      ]),
    }),
    ...(opts.attributeHealer && { attributeHealer: opts.attributeHealer }),
  };
  return { context, recordedSecretValues };
}

describe('Fn::GetAtt notes NoEcho secrecy BEFORE it logs the value (#3659)', () => {
  let resolver: InstanceType<typeof IntrinsicFunctionResolver>;

  beforeEach(() => {
    logSpies.debug.mockClear();
    resetAccountInfoCache();
    resolver = new IntrinsicFunctionResolver('us-east-1');
  });

  describe('the flat attributes read', () => {
    const PREFIX = 'Resolved Fn::GetAtt from attributes: ';

    it('masks a declared value on the debug line and still serves the real value', async () => {
      const { context } = contextFor(
        { resourceType: 'Custom::Thing', attributes: { Value: NOECHO } },
        { declared: true }
      );

      const value = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Value'] }, context);

      expect(value).toBe(NOECHO);
      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Value -> ***`]);
    });

    it('masks a PER-ATTRIBUTE declared nested-stack output, the cross-stack recovery shape', async () => {
      // `NestedStackProvider` hands the parent the recovered plaintext under
      // `Outputs.<Key>` and declares only that name.
      const { context } = contextFor(
        {
          resourceType: 'AWS::CloudFormation::Stack',
          physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child',
          attributes: { 'Outputs.Token': NOECHO, 'Outputs.Plain': 'plain-value-3659' },
        },
        { declared: new Set(['Outputs.Token']) }
      );

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Outputs.Token'] }, context);
      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Outputs.Plain'] }, context);

      expect(debugLines(PREFIX)).toEqual([
        `${PREFIX}Cr.Outputs.Token -> ***`,
        // The undeclared sibling stays readable: per attribute, not per bag.
        `${PREFIX}Cr.Outputs.Plain -> plain-value-3659`,
      ]);
    });

    it('CONTROL: an undeclared value is printed', async () => {
      const { context } = contextFor({
        resourceType: 'Custom::Thing',
        attributes: { Value: NOECHO },
      });

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Value'] }, context);

      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Value -> ${NOECHO}`]);
    });
  });

  describe('the nested-path walk', () => {
    const PREFIX = 'Resolved Fn::GetAtt from nested attributes: ';
    // `Address`, not `Password`: `stringifyAttributeForLog` redacts a
    // credential-NAMED attribute on its own, so a `Password` leaf renders
    // `<redacted>` in both cases and cannot tell the fix from its absence.

    it('masks a declared value on the debug line', async () => {
      const { context } = contextFor(
        { resourceType: 'Custom::Thing', attributes: { Endpoint: { Address: NOECHO } } },
        { declared: true }
      );

      const value = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Endpoint.Address'] }, context);

      expect(value).toBe(NOECHO);
      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Endpoint.Address -> ***`]);
    });

    it('CONTROL: an undeclared value is printed', async () => {
      const { context } = contextFor({
        resourceType: 'Custom::Thing',
        attributes: { Endpoint: { Address: NOECHO } },
      });

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Endpoint.Address'] }, context);

      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Endpoint.Address -> ${NOECHO}`]);
    });
  });

  describe('the Route 53 legacy NameServers normalization', () => {
    const PREFIX = 'Normalized legacy Fn::GetAtt attribute: ';
    const SERVERS = 'ns-secret-one-3659,ns-secret-two-3659';

    it('masks declared list elements on the debug line', async () => {
      const { context } = contextFor(
        { resourceType: 'AWS::Route53::HostedZone', attributes: { NameServers: SERVERS } },
        { declared: true }
      );

      const value = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'NameServers'] }, context);

      expect(value).toEqual(['ns-secret-one-3659', 'ns-secret-two-3659']);
      const lines = debugLines(PREFIX);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('ns-secret-one-3659');
      expect(lines[0]).not.toContain('ns-secret-two-3659');
    });

    it('CONTROL: undeclared list elements are printed', async () => {
      const { context } = contextFor({
        resourceType: 'AWS::Route53::HostedZone',
        attributes: { NameServers: SERVERS },
      });

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'NameServers'] }, context);

      const lines = debugLines(PREFIX);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('ns-secret-one-3659');
    });
  });

  describe('a value the #1852 heal re-read from AWS', () => {
    const PREFIX = 'Resolved Fn::GetAtt from a re-read of AWS (the state record lacked it): ';
    // An SSM parameter record with no `Arn` attribute: the flat lookup misses,
    // the guarded fallback asks the healer, and `serveHealedAttribute` logs it.
    const staleRecord = {
      resourceType: 'AWS::SSM::Parameter',
      physicalId: '/app/config',
      properties: { Name: '/app/config', Type: 'String', Value: 'v' },
      attributes: { Type: 'String', Value: 'v' },
    };
    const healedArn = `arn:aws:ssm:us-east-1:123456789012:parameter/${NOECHO}`;
    const healer = () =>
      vi.fn().mockResolvedValue({ kind: 'read', attributes: { Arn: healedArn } } as const);

    it('masks a declared value on the debug line', async () => {
      const { context } = contextFor(staleRecord, {
        declared: true,
        attributeHealer: healer(),
      });

      const value = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Arn'] }, context);

      expect(value).toBe(healedArn);
      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Arn -> ***`]);
    });

    it('CONTROL: an undeclared value is printed', async () => {
      const { context } = contextFor(staleRecord, { attributeHealer: healer() });

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Arn'] }, context);

      expect(debugLines(PREFIX)).toEqual([`${PREFIX}Cr.Arn -> ${healedArn}`]);
    });
  });
});
