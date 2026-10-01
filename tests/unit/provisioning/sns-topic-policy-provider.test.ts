import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';
import { SNSTopicPolicyProvider } from '../../../src/provisioning/providers/sns-topic-policy-provider.js';

describe('SNSTopicPolicyProvider', () => {
  let provider: SNSTopicPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SNSTopicPolicyProvider();
  });

  describe('import (topic-ARN resolution, closes #356)', () => {
    const TOPIC_ARN = 'arn:aws:sns:us-east-1:123456789012:my-topic';
    const TOPIC_ARN_2 = 'arn:aws:sns:us-east-1:123456789012:other-topic';
    const FIFO_TOPIC_ARN = 'arn:aws:sns:us-west-2:123456789012:my-topic.fifo';

    function makeInput(
      overrides: Partial<{
        knownPhysicalId: string;
        properties: Record<string, unknown>;
      }> = {}
    ) {
      const { knownPhysicalId, properties: propOverride, ...rest } = overrides;
      return {
        logicalId: 'MyTopicPolicy',
        resourceType: 'AWS::SNS::TopicPolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: propOverride ?? {
          Topics: [TOPIC_ARN],
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        ...(knownPhysicalId !== undefined && { knownPhysicalId }),
        ...rest,
      };
    }

    it('returns physicalId when knownPhysicalId is a valid topic ARN', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: TOPIC_ARN }));

      expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns physicalId when knownPhysicalId is a FIFO topic ARN', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: FIFO_TOPIC_ARN }));

      expect(result).toEqual({ physicalId: FIFO_TOPIC_ARN, attributes: {} });
    });

    it('returns physicalId when knownPhysicalId is a comma-joined list of topic ARNs', async () => {
      const joined = `${TOPIC_ARN},${TOPIC_ARN_2}`;
      const result = await provider.import(makeInput({ knownPhysicalId: joined }));

      expect(result).toEqual({ physicalId: joined, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to properties.Topics when knownPhysicalId is missing and Topics are literal ARNs', async () => {
      const result = await provider.import(
        makeInput({
          properties: {
            Topics: [TOPIC_ARN, TOPIC_ARN_2],
            PolicyDocument: { Version: '2012-10-17', Statement: [] },
          },
        })
      );

      expect(result).toEqual({
        physicalId: `${TOPIC_ARN},${TOPIC_ARN_2}`,
        attributes: {},
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to properties.Topics when knownPhysicalId is the CFn-generated policy NAME (canonical #356 bug repro)', async () => {
      // --migrate-from-cloudformation pre-populates knownPhysicalId from
      // CloudFormation's `DescribeStackResources`. For AWS::SNS::TopicPolicy,
      // CFn returns the policy resource NAME (e.g. `MyStack-MyTopicPolicy-XXX`),
      // which the SNS SDK rejects as an invalid topic ARN. Pre-fix this was
      // returned verbatim and baked an unusable name into cdkd state.
      // Post-fix we ignore the unusable knownPhysicalId and derive the
      // topic-ARN list from `properties.Topics`.
      const cfnGeneratedName = 'MyStack-MyTopicPolicy-1ABCDEFGHIJKL';
      const result = await provider.import(makeInput({ knownPhysicalId: cfnGeneratedName }));

      expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
    });

    it('rejects knownPhysicalId where one segment is not an SNS ARN (partial-valid mixture)', async () => {
      // A mixture of one valid ARN and a CFn-generated suffix should fall
      // through to the properties-based resolution, not bake a half-bad
      // list into state.
      const mixed = `${TOPIC_ARN},MyStack-MyTopicPolicy-XXX`;
      const result = await provider.import(makeInput({ knownPhysicalId: mixed }));

      // The fallback uses properties.Topics, which is a valid single ARN.
      expect(result).toEqual({ physicalId: TOPIC_ARN, attributes: {} });
    });

    it('throws actionable error when knownPhysicalId is a non-ARN AND properties.Topics is missing', async () => {
      const cfnGeneratedName = 'MyStack-MyTopicPolicy-1ABCDEFGHIJKL';
      await expect(
        provider.import(
          makeInput({
            knownPhysicalId: cfnGeneratedName,
            properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
          })
        )
      ).rejects.toThrow(
        /Cannot determine topic ARNs for AWS::SNS::TopicPolicy MyTopicPolicy\..*MyStack-MyTopicPolicy-1ABCDEFGHIJKL.*--resource MyTopicPolicy='<comma-joined-topic-ARNs>'/s
      );
    });

    it('throws actionable error when knownPhysicalId is missing AND properties.Topics[0] is an unresolved intrinsic ({Ref: ...})', async () => {
      // At import time, intrinsics in `properties` have NOT been resolved yet
      // (resolveImportedProperties runs AFTER provider.import calls). The
      // typical CDK shape `Topics: [{Ref: 'MyTopic'}]` therefore arrives here
      // as a raw object. Hard-erroring with a recovery hint is better than
      // silently dropping to null and baking the intrinsic into state.
      await expect(
        provider.import(
          makeInput({
            properties: {
              Topics: [{ Ref: 'MyTopic' }],
              PolicyDocument: { Version: '2012-10-17', Statement: [] },
            },
          })
        )
      ).rejects.toThrow(
        /Cannot determine topic ARNs.*Properties\.Topics=\[\{"Ref":"MyTopic"\}\].*--resource MyTopicPolicy='<comma-joined-topic-ARNs>'/s
      );
    });

    it('throws actionable error when both knownPhysicalId and properties.Topics are absent', async () => {
      await expect(
        provider.import(
          makeInput({ properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } } })
        )
      ).rejects.toThrow(
        /Cannot determine topic ARNs.*Properties\.Topics is missing or empty.*--resource MyTopicPolicy='<comma-joined-topic-ARNs>'/s
      );
    });

    it('does not call AWS in any branch (offline-only import)', async () => {
      await provider.import(makeInput()).catch(() => undefined);
      await provider.import(makeInput({ knownPhysicalId: TOPIC_ARN })).catch(() => undefined);
      await provider
        .import(
          makeInput({
            knownPhysicalId: 'MyStack-X-1',
            properties: { PolicyDocument: {} },
          })
        )
        .catch(() => undefined);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
  describe('import refusal paste safety (go-to-k/cdkd#4226)', () => {
    async function refusal(overrides: Record<string, unknown>): Promise<string> {
      const input = {
        logicalId: 'P',
        resourceType: 'AWS::SNS::TopicPolicy',
        stackName: 'S',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
      const err: unknown = await provider.import(input as never).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err, JSON.stringify(overrides)).toBeInstanceOf(Error);
      return (err as Error).message;
    }

    it('shows no payload logical id, type, region, supplied id or Topics value beside its --resource remedy', async () => {
      // The refusal ends in a `--resource` remedy. Pre-fix it printed the
      // logical id inside cdkd's own `'...'` and raw in the fragment, the
      // supplied id inside `'...'`, and the Topics value JSON-quoted, where a
      // shell still expands `$( )`; each payload family ran when pasted.
      for (const { value } of PASTE_PAYLOADS) {
        const byId = await refusal({ logicalId: value });
        const byType = await refusal({ resourceType: value });
        // The region comes from the cloud assembly's environment, unvalidated.
        const byRegion = await refusal({ region: value });
        const bySupplied = await refusal({ knownPhysicalId: value });
        const byLiteral = await refusal({ properties: { Topics: [value] } });
        const byIntrinsic = await refusal({ properties: { Topics: [{ Ref: value }] } });
        expect(byId, value).toContain('AWS::SNS::TopicPolicy a logical id that is not a plain identifier.');
        expect(byId, value).toContain("--resource '<logicalId>'='<comma-joined-topic-ARNs>'");
        expect(byType, value).toContain(
          'for (resource type not shown: it is not a plain identifier) P.'
        );
        expect(byRegion, value).toContain("'<region>'");
        expect(bySupplied, value).toContain(
          'Got knownPhysicalId=(not shown: it is not a plain identifier)'
        );
        for (const message of [byLiteral, byIntrinsic]) {
          expect(message, value).toContain('Properties.Topics (not shown: it is not a plain identifier)');
        }
        withPasteDir((dir) => {
          for (const message of [byId, byType, byRegion, bySupplied, byLiteral, byIntrinsic]) {
            expectNoCommandBesideDisplay(message, value);
            expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
          }
        });
      }
    }, 120_000);
  });
});
