import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getReadOnlyProperties,
  parseReadOnlyProperties,
  clearSchemaCache,
} from '../../../src/provisioning/schema-cache.js';

// Mock aws-clients
vi.mock('../../../src/utils/aws-clients.js', () => {
  const mockSend = vi.fn();
  return {
    getAwsClients: () => ({
      cloudFormation: { send: mockSend },
    }),
    __mockSend: mockSend,
  };
});

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Import the mock send function for test control
async function getMockSend() {
  const mod = await import('../../../src/utils/aws-clients.js');
  return (mod as unknown as { __mockSend: ReturnType<typeof vi.fn> }).__mockSend;
}

describe('schema-cache', () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    clearSchemaCache();
    mockSend = await getMockSend();
    mockSend.mockReset();
  });

  afterEach(() => {
    clearSchemaCache();
  });

  describe('parseReadOnlyProperties', () => {
    it('should extract top-level property names from readOnlyProperties', () => {
      const schema = JSON.stringify({
        readOnlyProperties: [
          '/properties/Arn',
          '/properties/TableId',
          '/properties/StreamArn',
        ],
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual(['Arn', 'TableId', 'StreamArn']);
    });

    it('should skip nested property paths', () => {
      const schema = JSON.stringify({
        readOnlyProperties: [
          '/properties/Arn',
          '/properties/Config/SubProp',
          '/properties/TableId',
        ],
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual(['Arn', 'TableId']);
    });

    it('should return empty array when readOnlyProperties is missing', () => {
      const schema = JSON.stringify({
        properties: { BucketName: { type: 'string' } },
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual([]);
    });

    it('should return empty array when readOnlyProperties is not an array', () => {
      const schema = JSON.stringify({
        readOnlyProperties: 'not-an-array',
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual([]);
    });

    it('should return empty array for invalid JSON', () => {
      const result = parseReadOnlyProperties('not valid json {{{');
      expect(result).toEqual([]);
    });

    it('should return empty array when readOnlyProperties is empty', () => {
      const schema = JSON.stringify({
        readOnlyProperties: [],
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual([]);
    });

    it('should handle pointers that do not match expected format', () => {
      const schema = JSON.stringify({
        readOnlyProperties: [
          '/properties/Arn',
          '/definitions/SomeDef',
          'properties/NoLeadingSlash',
          '/properties/',
        ],
      });

      const result = parseReadOnlyProperties(schema);
      expect(result).toEqual(['Arn']);
    });
  });

  describe('getReadOnlyProperties', () => {
    it('should fetch and cache schema from CloudFormation Registry', async () => {
      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify({
          readOnlyProperties: ['/properties/Arn', '/properties/TableId'],
        }),
      });

      const result = await getReadOnlyProperties('AWS::DynamoDB::Table');
      expect(result).toEqual(['Arn', 'TableId']);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Second call should use cache
      const result2 = await getReadOnlyProperties('AWS::DynamoDB::Table');
      expect(result2).toEqual(['Arn', 'TableId']);
      expect(mockSend).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should return empty array when schema is not available', async () => {
      mockSend.mockResolvedValueOnce({
        Schema: undefined,
      });

      const result = await getReadOnlyProperties('AWS::Unknown::Resource');
      expect(result).toEqual([]);
    });

    it('should return empty array and cache failure on API error', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('Type not found'), { name: 'TypeNotFoundException' })
      );

      const result = await getReadOnlyProperties('AWS::NonExistent::Type');
      expect(result).toEqual([]);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // Second call should not retry
      const result2 = await getReadOnlyProperties('AWS::NonExistent::Type');
      expect(result2).toEqual([]);
      expect(mockSend).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should handle network errors gracefully', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await getReadOnlyProperties('AWS::Lambda::Function');
      expect(result).toEqual([]);
    });

    it('should send DescribeTypeCommand with correct parameters', async () => {
      mockSend.mockResolvedValueOnce({
        Schema: JSON.stringify({
          readOnlyProperties: ['/properties/FunctionArn'],
        }),
      });

      await getReadOnlyProperties('AWS::Lambda::Function');

      const call = mockSend.mock.calls[0][0];
      expect(call.input).toEqual({
        Type: 'RESOURCE',
        TypeName: 'AWS::Lambda::Function',
      });
    });

    it('should handle different resource types independently', async () => {
      mockSend
        .mockResolvedValueOnce({
          Schema: JSON.stringify({
            readOnlyProperties: ['/properties/Arn'],
          }),
        })
        .mockResolvedValueOnce({
          Schema: JSON.stringify({
            readOnlyProperties: ['/properties/QueueArn', '/properties/QueueUrl'],
          }),
        });

      const lambdaProps = await getReadOnlyProperties('AWS::Lambda::Function');
      const sqsProps = await getReadOnlyProperties('AWS::SQS::Queue');

      expect(lambdaProps).toEqual(['Arn']);
      expect(sqsProps).toEqual(['QueueArn', 'QueueUrl']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearSchemaCache', () => {
    it('should clear cache and allow re-fetching', async () => {
      mockSend.mockResolvedValue({
        Schema: JSON.stringify({
          readOnlyProperties: ['/properties/Arn'],
        }),
      });

      await getReadOnlyProperties('AWS::S3::Bucket');
      expect(mockSend).toHaveBeenCalledTimes(1);

      clearSchemaCache();

      await getReadOnlyProperties('AWS::S3::Bucket');
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('should clear failed types cache allowing retry', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce({
          Schema: JSON.stringify({
            readOnlyProperties: ['/properties/Arn'],
          }),
        });

      // First call fails
      const result1 = await getReadOnlyProperties('AWS::S3::Bucket');
      expect(result1).toEqual([]);

      // Without clearing, it should not retry
      const result2 = await getReadOnlyProperties('AWS::S3::Bucket');
      expect(result2).toEqual([]);
      expect(mockSend).toHaveBeenCalledTimes(1);

      // After clearing, it should retry and succeed
      clearSchemaCache();
      const result3 = await getReadOnlyProperties('AWS::S3::Bucket');
      expect(result3).toEqual(['Arn']);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });
  });
});
