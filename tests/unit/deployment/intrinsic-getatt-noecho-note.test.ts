import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  SECRET_MASK,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

// Issue #2274 review round 2, minor 7. `noteAttributeSecrecy` is reached from
// THREE attribute-serving returns in `resolveGetAtt`, and only the flat-key one
// had a test. Each is its own `return`, so a fix landing on one says nothing
// about the others — which is exactly the sibling-site shape the repo's own
// implement guidance warns about, and how the Route 53 branch shipped without
// the note at all.
const NOECHO = 'handler-generated-secret-note-2274';
const CR_TYPE = 'Custom::Thing';

function contextFor(
  attributes: Record<string, unknown>,
  opts: {
    declared?: true | ReadonlySet<string>;
    resourceType?: string;
    recordedSecretValues?: RecordedSecretValues;
    redactedAttributeReads?: string[];
  } = {}
): ResolverContext {
  const resourceType = opts.resourceType ?? CR_TYPE;
  const template: CloudFormationTemplate = {
    Resources: { Cr: { Type: resourceType, Properties: {} } },
  };
  return {
    template,
    resources: {
      Cr: {
        physicalId: 'cr-phys',
        resourceType,
        properties: {},
        attributes,
        dependencies: [],
      },
    },
    ...(opts.declared !== undefined && {
      noEchoAttributeResources: new Map<string, true | ReadonlySet<string>>([
        ['Cr', opts.declared],
      ]),
    }),
    ...(opts.recordedSecretValues && { recordedSecretValues: opts.recordedSecretValues }),
    ...(opts.redactedAttributeReads && { redactedAttributeReads: opts.redactedAttributeReads }),
  };
}

describe('Fn::GetAtt notes attribute secrecy on every state-served branch (#2274)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
  });

  describe('the NESTED-PATH arm (issue #381 walk)', () => {
    // A Cloud Control provider stores nested attributes as real nested objects,
    // so `Endpoint.Password` misses the flat-key lookup and is served by the
    // dot-path walk. A handler answering
    // `{"Data": {"Endpoint": {"Password": "..."}}}` lands a sensitive leaf on
    // exactly that walk.
    it('registers a mask-only needle for a value served through the dot-path walk', async () => {
      const recordedSecretValues: RecordedSecretValues = new Map();
      const context = contextFor(
        { Endpoint: { Password: NOECHO } },
        { declared: true, recordedSecretValues }
      );

      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Cr', 'Endpoint.Password'] },
        context
      );

      // The REAL value is what reaches AWS...
      expect(value).toBe(NOECHO);
      // ...and the consumer's record persists the mask.
      expect(redactSecretsForState({ Value: NOECHO }, recordedSecretValues)).toEqual({
        Value: SECRET_MASK,
      });
    });

    it('records a REDACTED read served through the dot-path walk', async () => {
      const redactedAttributeReads: string[] = [];
      const context = contextFor(
        { Endpoint: { Password: SECRET_MASK } },
        { redactedAttributeReads }
      );

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Endpoint.Password'] }, context);

      expect(redactedAttributeReads).toEqual(['Cr.Endpoint.Password']);
    });
  });

  describe('the Route 53 legacy NameServers arm', () => {
    // The branch normalizes a comma-delimited legacy state value into a list
    // and returns it. It reads the SAME persisted `attributes` bag as the two
    // arms above and shipped with no note, which is why this method's doc no
    // longer claims the pass-through shape makes a skip impossible.
    it('records a REDACTED read rather than serving the mask silently', async () => {
      const redactedAttributeReads: string[] = [];
      const context = contextFor(
        { NameServers: SECRET_MASK },
        { resourceType: 'AWS::Route53::HostedZone', redactedAttributeReads }
      );

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'NameServers'] }, context);

      expect(redactedAttributeReads).toEqual(['Cr.NameServers']);
    });

    it('still normalizes an ORDINARY legacy value and records nothing', async () => {
      const redactedAttributeReads: string[] = [];
      const context = contextFor(
        { NameServers: 'ns-1.example.com,ns-2.example.com' },
        { resourceType: 'AWS::Route53::HostedZone', redactedAttributeReads }
      );

      const value = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'NameServers'] }, context);

      expect(value).toEqual(['ns-1.example.com', 'ns-2.example.com']);
      expect(redactedAttributeReads).toEqual([]);
    });
  });

  describe('a PER-ATTRIBUTE declaration', () => {
    // `NestedStackProvider` declares only the outputs it recovered, so an
    // ordinary sibling attribute must stay unregistered. A whole-bag reading
    // of the declaration would mask it into every consumer's record.
    it('registers the named attribute and leaves its sibling alone', async () => {
      const recordedSecretValues: RecordedSecretValues = new Map();
      const context = contextFor(
        { 'Outputs.Token': NOECHO, 'Outputs.BucketName': 'my-bucket' },
        { declared: new Set(['Outputs.Token']), recordedSecretValues }
      );

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Outputs.Token'] }, context);
      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Outputs.BucketName'] }, context);

      expect(recordedSecretValues.get(NOECHO)).toBe(SECRET_MASK);
      expect(recordedSecretValues.get('my-bucket')).toBeUndefined();
    });
  });

  describe('the NO_CHANGE claim the design rests on', () => {
    // `redactedAttributeReads` RECORDS instead of throwing, and the reason is
    // that the DIFF pass resolves the same leaf: a throw there would fail every
    // later deploy of such a stack, while recording leaves `***` compared
    // against `***`. That claim was argued in a comment and unfenced.
    it('serves the mask back UNCHANGED, so the diff compares *** against ***', async () => {
      const redactedAttributeReads: string[] = [];
      const context = contextFor({ Secret: SECRET_MASK }, { redactedAttributeReads });

      const desired = await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Secret'] }, context);

      // The desired side equals the persisted side, which is what makes the
      // resource NO_CHANGE rather than perpetually CHANGED-and-then-failed.
      expect(desired).toBe(SECRET_MASK);
      // The note is still taken — recording is not the same as ignoring.
      expect(redactedAttributeReads).toEqual(['Cr.Secret']);
    });

    it('records a read ONCE however many times the same attribute is resolved', async () => {
      const redactedAttributeReads: string[] = [];
      const context = contextFor({ Secret: SECRET_MASK }, { redactedAttributeReads });

      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Secret'] }, context);
      await resolver.resolve({ 'Fn::GetAtt': ['Cr', 'Secret'] }, context);

      expect(redactedAttributeReads).toEqual(['Cr.Secret']);
    });
  });
});
