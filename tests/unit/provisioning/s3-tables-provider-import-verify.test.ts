import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteTableCommand,
  GetNamespaceCommand,
  GetTableCommand,
  NotFoundException,
} from '@aws-sdk/client-s3tables';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-s3tables')>(
    '@aws-sdk/client-s3tables'
  );
  class MockS3TablesClient {
    config = { region: () => Promise.resolve('us-east-1') };
    send = mockSend;
  }
  return { ...actual, S3TablesClient: MockS3TablesClient };
});

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
  S3TablesProvider,
  parseNamespaceCompositeId,
  parseTableCompositeId,
} from '../../../src/provisioning/providers/s3-tables-provider.js';

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:111122223333:bucket/my-bucket';
const TABLE_ARN = `${BUCKET_ARN}/table/abc-123`;

function notFound(): NotFoundException {
  return new NotFoundException({ message: 'not found', $metadata: {} });
}

describe('S3Tables import: verify the composite before adopting (issue #1668)', () => {
  let provider: S3TablesProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3TablesProvider();
  });

  describe('composite id parsers', () => {
    it('accepts the exact arity and rejects everything else', () => {
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|ns`)).toEqual({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
      });
      expect(parseNamespaceCompositeId(BUCKET_ARN)).toBeUndefined();
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|ns|extra`)).toBeUndefined();
      expect(parseNamespaceCompositeId(`${BUCKET_ARN}|`)).toBeUndefined();

      expect(parseTableCompositeId(`${BUCKET_ARN}|ns|tbl`)).toEqual({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
        name: 'tbl',
      });
      expect(parseTableCompositeId(`${BUCKET_ARN}|ns`)).toBeUndefined();
      expect(parseTableCompositeId(TABLE_ARN)).toBeUndefined();
    });
  });

  describe('AWS::S3Tables::Namespace', () => {
    const input = {
      logicalId: 'MyNamespace',
      resourceType: 'AWS::S3Tables::Namespace',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { TableBucketARN: BUCKET_ARN, Namespace: 'ns' },
    };

    it('verifies a well-formed composite against AWS before adopting', async () => {
      mockSend.mockResolvedValueOnce({ namespace: ['ns'] });

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toEqual({ physicalId: `${BUCKET_ARN}|ns`, attributes: {} });
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(GetNamespaceCommand);
      expect(call.input).toMatchObject({ tableBucketARN: BUCKET_ARN, namespace: 'ns' });
    });

    it('REFUSES a wrong-arity override rather than recording it verbatim', async () => {
      // Pre-#1668 this bare id landed in state and broke every later op.
      // CloudFormation uses the SAME two-field composite for this type, so a
      // bare name names no namespace cdkd can verify — and silently
      // substituting the template's identity would adopt a resource the user
      // did not name (knownPhysicalId is documented ground truth).
      const result = await provider.import({ ...input, knownPhysicalId: 'ns' });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when the namespace does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toBeNull();
    });

    it('adopts a composite id regardless of the template property shapes', async () => {
      // The CDK shape: Namespace / TableBucketARN are unresolved intrinsics at
      // import time. The composite alone must be sufficient.
      mockSend.mockResolvedValueOnce({ namespace: ['ns'] });

      const result = await provider.import({
        ...input,
        properties: { TableBucketARN: { 'Fn::GetAtt': ['B', 'TableBucketARN'] } },
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toEqual({ physicalId: `${BUCKET_ARN}|ns`, attributes: {} });
    });

    it('declines with no override (override-only)', async () => {
      const result = await provider.import(input);
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // The route detection at import time is deliberately imprecise (the
  // allow-set, unresolved `Fn::If` keys and coverage-table drift can all make
  // it disagree with the deploy-time router). That is SAFE only because every
  // SDK path accepts BOTH id shapes — these tests pin that tolerance, without
  // which a CC-routed row would make `cdkd destroy` fail and orphan the table.
  describe('SDK paths accept CloudFormation\'s bare TableARN', () => {
    it('deletes a table recorded as a bare ARN', async () => {
      mockSend
        .mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' })
        .mockResolvedValueOnce({});

      await provider.delete('MyTable', TABLE_ARN, 'AWS::S3Tables::Table', {});

      const del = mockSend.mock.calls[1]?.[0];
      expect(del).toBeInstanceOf(DeleteTableCommand);
      expect(del.input).toMatchObject({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
        name: 'tbl',
      });
    });

    it('reads drift for a table recorded as a bare ARN', async () => {
      mockSend
        .mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' })
        .mockResolvedValueOnce({ tableARN: TABLE_ARN, name: 'tbl', namespace: ['ns'] })
        .mockResolvedValueOnce({ tags: {} });

      const result = await provider.readCurrentState(
        TABLE_ARN,
        'MyTable',
        'AWS::S3Tables::Table'
      );

      expect(result).toBeDefined();
    });

    it('treats an ALREADY-GONE bare-ARN row as deleted rather than unparseable', async () => {
      // "already deleted" and "cannot parse" must not collapse: a re-run after
      // an interrupted destroy, or an out-of-band console delete, otherwise
      // fails with "Invalid physicalId format" for a perfectly valid id and
      // leaves the stack un-destroyable.
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('MyTable', TABLE_ARN, 'AWS::S3Tables::Table', {})
      ).resolves.toBeUndefined();

      // Only the resolution attempt ran — no DeleteTable was issued.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('still refuses a genuinely unparseable id', async () => {
      await expect(
        provider.delete('MyTable', 'not-an-id', 'AWS::S3Tables::Table', {})
      // The bare prefix matches EVERY constant, so it could not tell one site's
      // format from another's — pin the shape (issue #1657 PR review).
      ).rejects.toThrow(
        'expected "<tableBucketARN>|<namespace>|<name>" or a table ARN'
      );
    });

    it('still deletes a table recorded as the composite (no extra lookup)', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('MyTable', `${BUCKET_ARN}|ns|tbl`, 'AWS::S3Tables::Table', {});

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(DeleteTableCommand);
    });
  });

  describe('AWS::S3Tables::Table', () => {
    const input = {
      logicalId: 'MyTable',
      resourceType: 'AWS::S3Tables::Table',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { TableBucketARN: BUCKET_ARN, Namespace: 'ns', TableName: 'tbl' },
    };

    it("canonicalizes CloudFormation's TableARN by resolving identity from AWS (#1668)", async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      // The registry declares a single-field primaryIdentifier of TableARN,
      // so this is what --migrate-from-cloudformation supplies.
      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(GetTableCommand);
      // Resolved BY ARN — not by template-derived parts.
      expect(call.input).toEqual({ tableArn: TABLE_ARN });
    });

    it('canonicalizes the ARN when TableBucketARN is an unresolved Fn::GetAtt (the CDK shape)', async () => {
      // The shape that actually occurs: import.ts substitutes only single-key
      // {Ref}, and full intrinsic resolution runs AFTER provider.import().
      // A template-derived fallback is `undefined` here, which is why the
      // identity must come from AWS.
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        properties: {
          TableBucketARN: { 'Fn::GetAtt': ['TableBucket', 'TableBucketARN'] },
          Namespace: { Ref: 'MyNamespace' },
          TableName: 'tbl',
        },
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
    });

    it('adopts when Namespace was SUBSTITUTED with the sibling composite id (#1668)', async () => {
      // The migration path this fix targets. `import.ts` substitutes a
      // single-key {Ref} with the referenced resource's PHYSICAL ID before
      // provider.import() runs, and for AWS::S3Tables::Namespace that id is
      // the 2-field composite `<bucketArn>|<namespace>`. Comparing it RAW
      // against the resolved field refused the adoption on exactly the
      // canonical CDK spelling (`namespace: ns.ref`) -- so the table was
      // silently not adopted and the next deploy tried to CREATE it.
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        properties: {
          TableBucketARN: { 'Fn::GetAtt': ['TableBucket', 'TableBucketARN'] },
          Namespace: `${BUCKET_ARN}|ns`,
          TableName: 'tbl',
        },
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
    });

    it('still refuses a substituted composite naming a DIFFERENT namespace (#1668)', async () => {
      // The other polarity: relaxing the comparison must not disable it. The
      // last segment is still compared, so a genuine disagreement is refused.
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        properties: {
          TableBucketARN: { 'Fn::GetAtt': ['TableBucket', 'TableBucketARN'] },
          Namespace: `${BUCKET_ARN}|someone-elses-namespace`,
          TableName: 'tbl',
        },
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toBeNull();
    });

    it('refuses when the resolved bucket disagrees with a LITERAL template bucket ARN', async () => {
      const otherBucket = 'arn:aws:s3tables:us-east-1:111122223333:bucket/other-bucket';
      mockSend.mockResolvedValueOnce({
        tableARN: `${otherBucket}/table/abc-123`,
        namespace: ['ns'],
        name: 'tbl',
      });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('refuses when GetTable returns no tableARN (unverifiable)', async () => {
      mockSend.mockResolvedValueOnce({ namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('keeps the bare TableARN for a Cloud-Control-routed table (#614 routing)', async () => {
      // `IcebergMetadata` is a silent-drop property, so this table auto-routes
      // to Cloud Control, whose Identifier is the bare TableARN. cdkd import
      // records provisionedBy: 'sdk' but only 'cc-api' is STICKY, so the next
      // deploy/destroy re-derives the route — canonicalizing here would hand
      // CC 'arn|ns|name'.
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        properties: { ...input.properties, IcebergMetadata: { SchemaDefinition: {} } },
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toEqual({ physicalId: TABLE_ARN, attributes: { TableARN: TABLE_ARN } });
    });

    it('pins the request shape for a composite id (must NOT go through tableArn)', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      await provider.import({ ...input, knownPhysicalId: `${BUCKET_ARN}|ns|tbl` });

      expect(mockSend.mock.calls[0]?.[0].input).toEqual({
        tableBucketARN: BUCKET_ARN,
        namespace: 'ns',
        name: 'tbl',
      });
    });

    it('refuses when the ARN resolves to a different table NAME than the template', async () => {
      mockSend.mockResolvedValueOnce({
        tableARN: TABLE_ARN,
        namespace: ['ns'],
        name: 'a-different-table',
      });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('refuses when GetTable returns an empty namespace list', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: [], name: 'tbl' });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('refuses when the returned ARN has no /table/ segment to split on', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: BUCKET_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('propagates a non-NotFound error as a failure rather than a skip', async () => {
      mockSend.mockRejectedValueOnce(new Error('AccessDeniedException'));

      await expect(
        provider.import({ ...input, knownPhysicalId: TABLE_ARN })
      ).rejects.toThrow(/AccessDenied/);
    });

    it('refuses when the ARN resolves to a different NAMESPACE than the template', async () => {
      mockSend.mockResolvedValueOnce({
        tableARN: TABLE_ARN,
        namespace: ['a-different-namespace'],
        name: 'tbl',
      });

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('refuses an override that is neither a composite nor an ARN', async () => {
      // knownPhysicalId is documented ground truth, so silently substituting
      // the template's identity would adopt a resource the user did not name.
      const result = await provider.import({ ...input, knownPhysicalId: 'just_a_name' });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('verifies and adopts a well-formed composite, caching the real ARN', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns|tbl`,
      });

      expect(result).toEqual({
        physicalId: `${BUCKET_ARN}|ns|tbl`,
        attributes: { TableARN: TABLE_ARN },
      });
    });

    it('refuses a wrong-arity override rather than recording it verbatim', async () => {
      // Pre-#1668 a 2-segment id fell through to verbatim adoption. It is not
      // a composite and not an ARN-only id, so it names nothing verifiable.
      const result = await provider.import({
        ...input,
        knownPhysicalId: `${BUCKET_ARN}|ns`,
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns null when the table does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      const result = await provider.import({ ...input, knownPhysicalId: TABLE_ARN });

      expect(result).toBeNull();
    });

    it('adopts by ARN even when the template carries no usable properties', async () => {
      mockSend.mockResolvedValueOnce({ tableARN: TABLE_ARN, namespace: ['ns'], name: 'tbl' });

      const result = await provider.import({
        ...input,
        properties: {},
        knownPhysicalId: TABLE_ARN,
      });

      expect(result).toMatchObject({ physicalId: `${BUCKET_ARN}|ns|tbl` });
    });

    it('declines with no override (override-only)', async () => {
      const result = await provider.import(input);
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
