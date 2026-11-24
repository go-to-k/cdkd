import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS SDK
const mockSend = vi.fn();
const mockDestroy = vi.fn();
vi.mock('@aws-sdk/client-cloudcontrol', () => ({
  CloudControlClient: vi.fn(() => ({
    send: mockSend,
    destroy: mockDestroy,
  })),
  GetResourceCommand: vi.fn((input) => ({
    ...input,
    _type: 'GetResourceCommand',
  })),
  ListResourcesCommand: vi.fn((input) => ({
    ...input,
    _type: 'ListResourcesCommand',
  })),
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { CcApiContextProvider } from '../../../../src/synthesis/context-providers/cc-api-provider.js';

function listed(...models: Array<{ Identifier: string } & Record<string, unknown>>) {
  return {
    ResourceDescriptions: models.map(({ Identifier, ...props }) => ({
      Identifier,
      Properties: JSON.stringify(props),
    })),
    NextToken: undefined,
  };
}

describe('CcApiContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should throw when typeName is not provided', async () => {
    const provider = new CcApiContextProvider({ region: 'us-east-1' });

    await expect(provider.resolve({})).rejects.toThrow(
      'CC API context provider requires typeName property'
    );
  });

  describe('query validation (CDK CLI parity)', () => {
    it.each([
      [
        'exactIdentifier with propertyMatch',
        { exactIdentifier: 'r', propertyMatch: { Name: 'r' } },
        'specify either exactIdentifier or propertyMatch, but not both',
      ],
      ['neither exactIdentifier nor propertyMatch', {}, 'neither exactIdentifier nor propertyMatch'],
      [
        'ignoreErrorOnMissingContext without dummyValue',
        { exactIdentifier: 'r', ignoreErrorOnMissingContext: true },
        'a dummyValue must be supplied',
      ],
      [
        'a non-array dummyValue',
        { exactIdentifier: 'r', dummyValue: { Arn: 'x' } },
        'dummyValue must be an array of objects',
      ],
      [
        'an array dummyValue holding a non-object',
        { exactIdentifier: 'r', dummyValue: ['x'] },
        'dummyValue must be an array of objects',
      ],
    ])('should refuse %s before calling Cloud Control', async (_label, query, message) => {
      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(provider.resolve({ typeName: 'AWS::IAM::Role', ...query })).rejects.toThrow(
        message
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // Issue #6542: aws-cdk-lib's Role / Repository / DatabaseInstance /
  // DatabaseCluster `fromLookup` read `response[0]`, PrefixList checks
  // `response.length !== 1` — a single match must still be an ARRAY.
  it('should return a one-element array with Identifier for an exact identifier', async () => {
    mockSend.mockResolvedValue({
      ResourceDescription: {
        Identifier: 'my-role',
        Properties: JSON.stringify({
          RoleName: 'my-role',
          Arn: 'arn:aws:iam::123456789012:role/my-role',
          RoleId: 'AROAEXAMPLE',
          Path: '/',
        }),
      },
    });

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::IAM::Role',
      exactIdentifier: 'my-role',
      propertiesToReturn: ['Arn', 'RoleName'],
    });

    expect(result).toEqual([
      {
        Arn: 'arn:aws:iam::123456789012:role/my-role',
        RoleName: 'my-role',
        Identifier: 'my-role',
      },
    ]);
    expect(mockSend.mock.calls[0]![0]).toEqual({
      TypeName: 'AWS::IAM::Role',
      Identifier: 'my-role',
      _type: 'GetResourceCommand',
    });
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should fall back to the requested identifier when GetResource omits one', async () => {
    mockSend.mockResolvedValue({
      ResourceDescription: { Properties: JSON.stringify({ Arn: 'arn:x' }) },
    });

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::IAM::Role',
      exactIdentifier: 'my-role',
      propertiesToReturn: ['Arn'],
    });

    expect(result).toEqual([{ Arn: 'arn:x', Identifier: 'my-role' }]);
  });

  it('should return only Identifier when propertiesToReturn is empty', async () => {
    mockSend.mockResolvedValue({
      ResourceDescription: { Identifier: 'my-role', Properties: JSON.stringify({ Arn: 'arn:x' }) },
    });

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({ typeName: 'AWS::IAM::Role', exactIdentifier: 'my-role' });

    expect(result).toEqual([{ Identifier: 'my-role' }]);
  });

  it('should throw when ResourceNotFoundException for exact identifier', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    const provider = new CcApiContextProvider({ region: 'us-east-1' });

    await expect(
      provider.resolve({
        typeName: 'AWS::IAM::Role',
        exactIdentifier: 'nonexistent-role',
        expectedMatchCount: 'exactly-one',
      })
    ).rejects.toThrow('No AWS::IAM::Role resource found with identifier nonexistent-role');
  });

  // Issue #6542: the dummy branch used to sit behind the match-count check,
  // so `mustExist: false` on a missing role failed instead.
  it('should return dummyValue for a missing exact identifier under ignoreErrorOnMissingContext', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('Resource not found'), { name: 'ResourceNotFoundException' })
    );

    const dummyValue = [{ Arn: 'arn:aws:iam::123456789012:role/DUMMY' }];
    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::IAM::Role',
      exactIdentifier: 'nonexistent-role',
      expectedMatchCount: 'exactly-one',
      ignoreErrorOnMissingContext: true,
      dummyValue,
    });

    expect(result).toEqual(dummyValue);
  });

  it('should raise a non-NotFound GetResource error even under ignoreErrorOnMissingContext', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));

    const provider = new CcApiContextProvider({ region: 'us-east-1' });

    await expect(
      provider.resolve({
        typeName: 'AWS::IAM::Role',
        exactIdentifier: 'r',
        ignoreErrorOnMissingContext: true,
        dummyValue: [{}],
      })
    ).rejects.toThrow('denied');
  });

  it('should list and filter resources by property match', async () => {
    mockSend.mockResolvedValue(
      listed(
        { Identifier: 'bucket-a', BucketName: 'bucket-a', Env: 'prod' },
        { Identifier: 'bucket-b', BucketName: 'bucket-b', Env: 'dev' },
        { Identifier: 'bucket-c', BucketName: 'bucket-c', Env: 'prod' }
      )
    );

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::S3::Bucket',
      propertyMatch: { BucketName: 'bucket-b' },
      expectedMatchCount: 'exactly-one',
      propertiesToReturn: ['BucketName', 'Env'],
    });

    expect(result).toEqual([{ BucketName: 'bucket-b', Env: 'dev', Identifier: 'bucket-b' }]);
  });

  it('should pass resourceModel and MaxResults to ListResources', async () => {
    mockSend.mockResolvedValue(listed());

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    await provider.resolve({
      typeName: 'AWS::EC2::PrefixList',
      propertyMatch: { PrefixListName: 'pl' },
      resourceModel: { Scope: 'x' },
    });

    expect(mockSend.mock.calls[0]![0]).toEqual({
      TypeName: 'AWS::EC2::PrefixList',
      ResourceModel: JSON.stringify({ Scope: 'x' }),
      MaxResults: 100,
      _type: 'ListResourcesCommand',
    });
  });

  describe('expectedMatchCount', () => {
    // Issue #6542: the schema default is `any`, not `exactly-one`.
    it('should return every match when unset', async () => {
      mockSend.mockResolvedValue(
        listed({ Identifier: 'r1', Kind: 'k' }, { Identifier: 'r2', Kind: 'k' })
      );

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({
        typeName: 'AWS::SomeType',
        propertyMatch: { Kind: 'k' },
      });

      expect(result).toEqual([{ Identifier: 'r1' }, { Identifier: 'r2' }]);
    });

    it('should return [] for zero matches when unset', async () => {
      mockSend.mockResolvedValue(listed());

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({ typeName: 'AWS::SomeType', propertyMatch: {} });

      expect(result).toEqual([]);
    });

    it('should return [] for zero matches under any, not dummyValue', async () => {
      mockSend.mockResolvedValue(listed());

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({
        typeName: 'AWS::SomeType',
        propertyMatch: {},
        expectedMatchCount: 'any',
        ignoreErrorOnMissingContext: true,
        dummyValue: [{ fallback: true }],
      });

      expect(result).toEqual([]);
    });

    it('should pass for exactly-one when one resource found', async () => {
      mockSend.mockResolvedValue(listed({ Identifier: 'resource-1', Name: 'resource-1' }));

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({
        typeName: 'AWS::SomeType',
        propertyMatch: {},
        expectedMatchCount: 'exactly-one',
        propertiesToReturn: ['Name'],
      });

      expect(result).toEqual([{ Name: 'resource-1', Identifier: 'resource-1' }]);
    });

    it('should throw for exactly-one when multiple resources found', async () => {
      mockSend.mockResolvedValue(listed({ Identifier: 'r1' }, { Identifier: 'r2' }));

      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(
        provider.resolve({
          typeName: 'AWS::SomeType',
          propertyMatch: {},
          expectedMatchCount: 'exactly-one',
        })
      ).rejects.toThrow('Expected exactly one AWS::SomeType, found 2');
    });

    it('should not return dummyValue for too many matches', async () => {
      mockSend.mockResolvedValue(listed({ Identifier: 'r1' }, { Identifier: 'r2' }));

      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(
        provider.resolve({
          typeName: 'AWS::SomeType',
          propertyMatch: {},
          expectedMatchCount: 'exactly-one',
          ignoreErrorOnMissingContext: true,
          dummyValue: [{}],
        })
      ).rejects.toThrow('Expected exactly one AWS::SomeType, found 2');
    });

    it('should pass for at-least-one when multiple resources found', async () => {
      mockSend.mockResolvedValue(listed({ Identifier: 'r1' }, { Identifier: 'r2' }));

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({
        typeName: 'AWS::SomeType',
        propertyMatch: {},
        expectedMatchCount: 'at-least-one',
      });

      expect(result).toEqual([{ Identifier: 'r1' }, { Identifier: 'r2' }]);
    });

    it('should throw for at-least-one when no resources found', async () => {
      mockSend.mockResolvedValue(listed());

      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(
        provider.resolve({
          typeName: 'AWS::SomeType',
          propertyMatch: {},
          expectedMatchCount: 'at-least-one',
        })
      ).rejects.toThrow('Expected at least one AWS::SomeType, found none');
    });

    it('should return dummyValue for exactly-one with no match under ignoreErrorOnMissingContext', async () => {
      mockSend.mockResolvedValue(listed());

      const provider = new CcApiContextProvider({ region: 'us-east-1' });
      const result = await provider.resolve({
        typeName: 'AWS::SomeType',
        propertyMatch: {},
        expectedMatchCount: 'exactly-one',
        ignoreErrorOnMissingContext: true,
        dummyValue: [{ Name: 'dummy' }],
      });

      expect(result).toEqual([{ Name: 'dummy' }]);
    });

    it('should throw for at-most-one when multiple resources found', async () => {
      mockSend.mockResolvedValue(listed({ Identifier: 'r1' }, { Identifier: 'r2' }));

      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(
        provider.resolve({
          typeName: 'AWS::SomeType',
          propertyMatch: {},
          expectedMatchCount: 'at-most-one',
        })
      ).rejects.toThrow('Expected at most one AWS::SomeType, found 2');
    });

    it('should stop paging once at-most-one is exceeded', async () => {
      mockSend.mockResolvedValueOnce({
        ...listed({ Identifier: 'r1' }, { Identifier: 'r2' }),
        NextToken: 'token-1',
      });

      const provider = new CcApiContextProvider({ region: 'us-east-1' });

      await expect(
        provider.resolve({
          typeName: 'AWS::SomeType',
          propertyMatch: {},
          expectedMatchCount: 'at-most-one',
        })
      ).rejects.toThrow('Expected at most one AWS::SomeType, found at least 2');
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  it('should handle pagination in list resources', async () => {
    mockSend
      .mockResolvedValueOnce({ ...listed({ Identifier: 'r1' }), NextToken: 'token-1' })
      .mockResolvedValueOnce(listed({ Identifier: 'r2' }));

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::SomeType',
      propertyMatch: {},
      expectedMatchCount: 'at-least-one',
    });

    expect(result).toEqual([{ Identifier: 'r1' }, { Identifier: 'r2' }]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]![0]).toMatchObject({ NextToken: 'token-1' });
  });

  it('should match by strict equality, so an object filter value never matches (CDK CLI parity)', async () => {
    mockSend.mockResolvedValue(
      listed(
        { Identifier: 'r1', Tags: [{ Key: 'env', Value: 'prod' }] },
        { Identifier: 'r2', Tags: [{ Key: 'env', Value: 'prod' }] }
      )
    );

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::SomeType',
      propertyMatch: { Tags: [{ Key: 'env', Value: 'prod' }] },
      expectedMatchCount: 'at-most-one',
    });

    expect(result).toEqual([]);
  });

  it('should step into a primitive on a dotted path, as findJsonValue does', async () => {
    mockSend.mockResolvedValue(listed({ Identifier: 'r1', Name: 'abcd' }));

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::SomeType',
      propertyMatch: { 'Name.length': 4 },
      propertiesToReturn: ['Name.length'],
    });

    expect(result).toEqual([{ 'Name.length': 4, Identifier: 'r1' }]);
  });

  it('should filter by nested property match and return nested properties', async () => {
    mockSend.mockResolvedValue(
      listed(
        { Identifier: 'r1', Name: 'r1', Config: { Env: 'prod' } },
        { Identifier: 'r2', Name: 'r2', Config: { Env: 'dev' } }
      )
    );

    const provider = new CcApiContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({
      typeName: 'AWS::SomeType',
      propertyMatch: { 'Config.Env': 'prod' },
      expectedMatchCount: 'exactly-one',
      propertiesToReturn: ['Name', 'Config.Env'],
    });

    expect(result).toEqual([{ Name: 'r1', 'Config.Env': 'prod', Identifier: 'r1' }]);
  });
});
