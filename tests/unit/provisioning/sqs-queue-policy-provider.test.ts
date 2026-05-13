import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sqs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { SQSQueuePolicyProvider } from '../../../src/provisioning/providers/sqs-queue-policy-provider.js';

describe('SQSQueuePolicyProvider', () => {
  let provider: SQSQueuePolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SQSQueuePolicyProvider();
  });

  describe('import (queue-URL resolution, closes #351)', () => {
    const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue';
    const FIFO_URL = 'https://sqs.us-west-2.amazonaws.com/123456789012/my-queue.fifo';

    function makeInput(
      overrides: Partial<{
        knownPhysicalId: string;
        properties: Record<string, unknown>;
      }> = {}
    ) {
      const { knownPhysicalId, properties: propOverride, ...rest } = overrides;
      return {
        logicalId: 'MyQueuePolicy',
        resourceType: 'AWS::SQS::QueuePolicy',
        cdkPath: 'MyStack/MyQueuePolicy',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: propOverride ?? {
          Queues: [QUEUE_URL],
          PolicyDocument: { Version: '2012-10-17', Statement: [] },
        },
        ...(knownPhysicalId !== undefined && { knownPhysicalId }),
        ...rest,
      };
    }

    it('returns physicalId when knownPhysicalId is a valid queue URL', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: QUEUE_URL }));

      expect(result).toEqual({ physicalId: QUEUE_URL, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns physicalId when knownPhysicalId is a FIFO queue URL', async () => {
      const result = await provider.import(makeInput({ knownPhysicalId: FIFO_URL }));

      expect(result).toEqual({ physicalId: FIFO_URL, attributes: {} });
    });

    it('falls back to properties.Queues[0] when knownPhysicalId is missing and Queues[0] is a literal queue URL', async () => {
      const result = await provider.import(makeInput());

      expect(result).toEqual({ physicalId: QUEUE_URL, attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('falls back to properties.Queues[0] when knownPhysicalId is the CFn-generated policy NAME (canonical #351 bug repro)', async () => {
      // --migrate-from-cloudformation pre-populates knownPhysicalId from
      // CloudFormation's `DescribeStackResources`. For AWS::SQS::QueuePolicy,
      // CFn returns the policy resource NAME (e.g. `MyStack-MyQueuePolicy-XXX`),
      // which the SQS SDK rejects as an invalid URL. Pre-fix this was returned
      // verbatim and crashed later in `captureObservedForImportedResources`.
      // Post-fix we ignore the unusable knownPhysicalId and derive the queue URL
      // from `properties.Queues[0]`.
      const cfnGeneratedName = 'MyStack-MyQueuePolicy-1ABCDEFGHIJKL';
      const result = await provider.import(
        makeInput({ knownPhysicalId: cfnGeneratedName })
      );

      expect(result).toEqual({ physicalId: QUEUE_URL, attributes: {} });
    });

    it('throws actionable error when knownPhysicalId is a non-URL AND properties.Queues is missing', async () => {
      const cfnGeneratedName = 'MyStack-MyQueuePolicy-1ABCDEFGHIJKL';
      await expect(
        provider.import(
          makeInput({
            knownPhysicalId: cfnGeneratedName,
            properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } },
          })
        )
      ).rejects.toThrow(
        /Cannot determine queue URL for AWS::SQS::QueuePolicy 'MyQueuePolicy'.*MyStack-MyQueuePolicy-1ABCDEFGHIJKL.*--resource MyQueuePolicy=<queueUrl>/s
      );
    });

    it('throws actionable error when knownPhysicalId is missing AND properties.Queues[0] is an unresolved intrinsic ({Ref: ...})', async () => {
      // At import time, intrinsics in `properties` have NOT been resolved yet
      // (resolveImportedProperties runs AFTER provider.import calls). The
      // typical CDK shape `Queues: [{Ref: 'MyQueue'}]` therefore arrives here
      // as a raw object. Hard-erroring with a recovery hint is better than
      // silently dropping to null and baking the intrinsic into state.
      await expect(
        provider.import(
          makeInput({
            properties: {
              Queues: [{ Ref: 'MyQueue' }],
              PolicyDocument: { Version: '2012-10-17', Statement: [] },
            },
          })
        )
      ).rejects.toThrow(
        /Cannot determine queue URL.*Properties\.Queues\[0\]=\{"Ref":"MyQueue"\}.*--resource MyQueuePolicy=<queueUrl>/s
      );
    });

    it('throws actionable error when both knownPhysicalId and properties.Queues are absent', async () => {
      await expect(
        provider.import(
          makeInput({ properties: { PolicyDocument: { Version: '2012-10-17', Statement: [] } } })
        )
      ).rejects.toThrow(
        /Cannot determine queue URL.*Properties\.Queues is missing or empty.*--resource MyQueuePolicy=<queueUrl>/s
      );
    });

    it('does not call AWS in any branch (offline-only import)', async () => {
      await provider.import(makeInput()).catch(() => undefined);
      await provider.import(makeInput({ knownPhysicalId: QUEUE_URL })).catch(() => undefined);
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
});
