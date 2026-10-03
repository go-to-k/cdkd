import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Deploy-time refusal of a composite physicalId whose segment carries cdkd's
 * `|` separator (issue #1672) — one adopting provider per touched file.
 *
 * Every `throws` case below RECORDED an ambiguous id before the fix and the
 * deploy SUCCEEDED, so each is a regression fence, not a shape assertion. The
 * `expect(send).not.toHaveBeenCalled()` assertions are load-bearing too: the
 * refusal has to run BEFORE the AWS call, or a throw would leave a created
 * resource behind with no state record.
 */

const mockGlueSend = vi.hoisted(() => vi.fn());
const mockS3TablesSend = vi.hoisted(() => vi.fn());
const mockAppSyncSend = vi.hoisted(() => vi.fn());
const mockEc2Send = vi.hoisted(() => vi.fn());
const mockApiGatewaySend = vi.hoisted(() => vi.fn());
const mockLambdaSend = vi.hoisted(() => vi.fn());
const mockRoute53Send = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return {
    ...actual,
    S3TablesClient: vi.fn().mockImplementation(() => ({
      send: mockS3TablesSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockAppSyncSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-route-53', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-route-53')>();
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockRoute53Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
    apiGateway: {
      send: mockApiGatewaySend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
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
  CreateTableCommand,
  DeleteTableCommand,
  GetTableCommand,
  UpdateTableCommand,
} from '@aws-sdk/client-glue';
import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { LambdaEventInvokeConfigProvider } from '../../../src/provisioning/providers/lambda-event-invoke-config-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { compositeIdSeparatorRefusal } from '../../../src/provisioning/composite-id.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/** The context the rollback executor's reverse-replacement create passes. */
const REPLAY = { replayingState: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` does NOT drain a `mockResolvedValueOnce` queue, so every
  // shared send mock is reset outright (issue #1618). Each test that needs a
  // response primes its own, and consumes it.
  mockGlueSend.mockReset();
  mockS3TablesSend.mockReset();
  mockAppSyncSend.mockReset();
  mockEc2Send.mockReset();
  mockApiGatewaySend.mockReset();
  mockLambdaSend.mockReset();
  mockRoute53Send.mockReset();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
});

describe('AWS::Glue::Table composite id guard', () => {
  // Issue #1672: AWS accepts a table named `a|b` and CloudFormation manages it.
  // The decode sites and the `Ref` resolver both place the table name by the
  // recorded `DatabaseName`, so the create no longer refuses it.
  it('accepts a table name containing the separator and records <db>|<name>', async () => {
    mockGlueSend.mockResolvedValueOnce({});
    const provider = new GlueProvider();
    const result = await provider.create('MyTable', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: { Name: 'a|b' },
    });
    expect(result.physicalId).toBe('mydb|a|b');
    const creates = mockGlueSend.mock.calls
      .map(([c]) => c as { input: Record<string, unknown> })
      .filter((c) => c instanceof CreateTableCommand);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({
      DatabaseName: 'mydb',
      TableInput: { Name: 'a|b' },
    });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  // Issue #3892: Glue accepts `|` in a DATABASE name too (live probe through the
  // glue-update-hardening fixture), and every reader anchors on the recorded
  // DatabaseName, so the create refuses neither name.
  it.each([
    ['a database name', 'my|db', 'orders', 'my|db|orders'],
    ['both names', 'my|db', 'a|b', 'my|db|a|b'],
  ])('accepts %s containing the separator and records <db>|<table>', async (_n, db, table, id) => {
    mockGlueSend.mockResolvedValueOnce({});
    const provider = new GlueProvider();
    const result = await provider.create('MyTable', 'AWS::Glue::Table', {
      DatabaseName: db,
      TableInput: { Name: table },
    });
    expect(result.physicalId).toBe(id);
    const creates = mockGlueSend.mock.calls
      .map(([c]) => c as { input: Record<string, unknown> })
      .filter((c) => c instanceof CreateTableCommand);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.input).toMatchObject({ DatabaseName: db, TableInput: { Name: table } });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  // The names are read through unvalidated casts; a non-string would be
  // stringified into an id no reader can place (review of #3942).
  it.each([
    ['DatabaseName', { DatabaseName: ['my|db'], TableInput: { Name: 'orders' } }],
    ['TableInput.Name', { DatabaseName: 'mydb', TableInput: { Name: { Ref: 'X' } } }],
  ])('refuses a non-string %s before CreateTable runs', async (field, props) => {
    const provider = new GlueProvider();
    await expect(provider.create('MyTable', 'AWS::Glue::Table', props)).rejects.toThrow(
      `${field} must be a string`
    );
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('still records a clean composite id', async () => {
    mockGlueSend.mockResolvedValueOnce({});
    const provider = new GlueProvider();
    const result = await provider.create('MyTable', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: { Name: 'orders' },
    });
    expect(result.physicalId).toBe('mydb|orders');
  });

});

describe('AWS::Glue::Table composite id decode', () => {
  // `mydb|a|b` is what a create of a table named `a|b` records (above). A bare
  // split reads it as table `a`.
  const ID = 'mydb|a|b';
  const PROPS = { DatabaseName: 'mydb', TableInput: { Name: 'a|b' } };

  function sent(command: new (...args: never[]) => unknown) {
    return mockGlueSend.mock.calls
      .map(([c]) => c as { input: Record<string, unknown> })
      .filter((c) => c instanceof command)
      .map((c) => c.input);
  }

  it('deletes the table the recorded DatabaseName anchors, not the first segment', async () => {
    mockGlueSend.mockResolvedValue({});
    const result = await new GlueProvider().delete('MyTable', ID, 'AWS::Glue::Table', PROPS);
    expect(result).toBeUndefined();
    expect(sent(DeleteTableCommand)).toEqual([{ DatabaseName: 'mydb', Name: 'a|b' }]);
  });

  it('updates the anchored table, preferring the deployed bag', async () => {
    mockGlueSend.mockResolvedValue({});
    await new GlueProvider().update(
      'MyTable',
      ID,
      'AWS::Glue::Table',
      // Both bags prefix-match; only the deployed one names the recorded table.
      { DatabaseName: 'mydb|a', TableInput: { Name: 'a|b' } },
      PROPS
    );
    expect(sent(GetTableCommand)).toEqual([{ DatabaseName: 'mydb', Name: 'a|b' }]);
    expect(sent(UpdateTableCommand)).toEqual([
      expect.objectContaining({ DatabaseName: 'mydb', TableInput: expect.objectContaining({ Name: 'a|b' }) }),
    ]);
  });

  // `update` passes the previous bag first and the deployed bag second. A
  // previous bag with no usable anchor must not end the search: the second
  // bag's DatabaseName still places the table.
  // ...and a first bag whose DatabaseName is a STRING that does not prefix the
  // id (a renamed database) must not end the search either.
  it('anchors on the second bag when the first bag names a database that does not prefix the id', async () => {
    mockGlueSend.mockResolvedValue({});
    await new GlueProvider().update('MyTable', ID, 'AWS::Glue::Table', PROPS, {
      DatabaseName: 'otherdb',
      TableInput: { Name: 'a|b' },
    });
    expect(sent(UpdateTableCommand)).toEqual([
      expect.objectContaining({ DatabaseName: 'mydb', TableInput: expect.objectContaining({ Name: 'a|b' }) }),
    ]);
  });

  it('anchors on the second bag when the first has no usable DatabaseName', async () => {
    mockGlueSend.mockResolvedValue({});
    await new GlueProvider().update(
      'MyTable',
      ID,
      'AWS::Glue::Table',
      PROPS,
      { DatabaseName: { Ref: 'Db' }, TableInput: { Name: 'a|b' } }
    );
    expect(sent(UpdateTableCommand)).toEqual([
      expect.objectContaining({ DatabaseName: 'mydb', TableInput: expect.objectContaining({ Name: 'a|b' }) }),
    ]);
  });

  it('reads the anchored table for drift', async () => {
    mockGlueSend.mockResolvedValue({ Table: { Name: 'a|b' } });
    const state = await new GlueProvider().readCurrentState(
      ID,
      'MyTable',
      'AWS::Glue::Table',
      PROPS
    );
    expect(sent(GetTableCommand)).toEqual([{ DatabaseName: 'mydb', Name: 'a|b' }]);
    expect(state).toMatchObject({ DatabaseName: 'mydb', Name: 'a|b' });
  });

  it('anchors a database name that itself carries the separator', async () => {
    mockGlueSend.mockResolvedValue({});
    await new GlueProvider().delete('MyTable', 'my|db|orders', 'AWS::Glue::Table', {
      DatabaseName: 'my|db',
    });
    expect(sent(DeleteTableCommand)).toEqual([{ DatabaseName: 'my|db', Name: 'orders' }]);
  });

  it('still decodes a plain two-segment id when the bag has no usable DatabaseName', async () => {
    mockGlueSend.mockResolvedValue({});
    await new GlueProvider().delete('MyTable', 'mydb|orders', 'AWS::Glue::Table', {
      DatabaseName: { Ref: 'Db' },
    });
    expect(sent(DeleteTableCommand)).toEqual([{ DatabaseName: 'mydb', Name: 'orders' }]);
  });

  // Issue #3892: a `|` in the DATABASE name, placed by the recorded anchor at
  // every decode site (delete is pinned above).
  it('updates a table in a database whose name carries the separator', async () => {
    const PIPE_DB = { DatabaseName: 'my|db', TableInput: { Name: 'orders' } };
    mockGlueSend.mockResolvedValue({ Table: { Name: 'orders' } });
    await new GlueProvider().update('MyTable', 'my|db|orders', 'AWS::Glue::Table', PIPE_DB, PIPE_DB);
    expect(sent(UpdateTableCommand)).toEqual([
      expect.objectContaining({ DatabaseName: 'my|db', TableInput: expect.objectContaining({ Name: 'orders' }) }),
    ]);
  });

  // Separate from the update, which sends a GetTable of its own.
  it('reads a table in a database whose name carries the separator', async () => {
    mockGlueSend.mockResolvedValue({ Table: { Name: 'orders' } });
    const state = await new GlueProvider().readCurrentState(
      'my|db|orders',
      'MyTable',
      'AWS::Glue::Table',
      { DatabaseName: 'my|db', TableInput: { Name: 'orders' } }
    );
    expect(sent(GetTableCommand)).toEqual([{ DatabaseName: 'my|db', Name: 'orders' }]);
    expect(state).toMatchObject({ DatabaseName: 'my|db', Name: 'orders' });
  });

  // An id with more than one `|` whose record carries no string DatabaseName
  // (`cdkd import` can leave it unresolved) is usually CORRECT: the message must
  // point at the property, not tell the user to repair the id.
  describe('the message for an id with no usable anchor', () => {
    const warned = () => mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');

    it('names the unresolved DatabaseName on the delete skip', async () => {
      const result = await new GlueProvider().delete('MyTable', 'my|db|orders', 'AWS::Glue::Table', {
        DatabaseName: { Ref: 'Db' },
      });
      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(warned()).toContain("set the record's properties.DatabaseName in state.json");
      // The skipping head already ends a sentence: no doubled full stop.
      expect(warned()).toContain('by hand. NOTE: this id');
      expect(warned()).not.toContain('.. NOTE');
    });

    it('names it on the update refusal too', async () => {
      await expect(
        new GlueProvider().update(
          'MyTable',
          'my|db|orders',
          'AWS::Glue::Table',
          { DatabaseName: { Ref: 'Db' }, TableInput: {} },
          { DatabaseName: { Ref: 'Db' } }
        )
      ).rejects.toThrow(/set the record's properties\.DatabaseName in state\.json/);
    });

    // The note must not run into the id: the non-skipping head ends `got "..."`.
    it('separates the note from the id with a full stop', async () => {
      await expect(
        new GlueProvider().update(
          'MyTable',
          'my|db|orders',
          'AWS::Glue::Table',
          { DatabaseName: { Ref: 'Db' }, TableInput: {} },
          { DatabaseName: { Ref: 'Db' } }
        )
      ).rejects.toThrow(/got "my\|db\|orders"\. NOTE:/);
    });

    // A redaction mask is no anchor either, so it gets the note.
    it('names a masked DatabaseName the same way', async () => {
      await new GlueProvider().delete('MyTable', 'my|db|orders', 'AWS::Glue::Table', {
        DatabaseName: SECRET_MASK,
      });
      expect(warned()).toContain("set the record's properties.DatabaseName in state.json");
    });

    // The note needs EVERY bag anchorless: one string bag that does not prefix
    // the id means the record names another database, and the id is what is off.
    it('keeps the plain wording when only one of the update bags is anchorless', async () => {
      await expect(
        new GlueProvider().update(
          'MyTable',
          'my|db|orders',
          'AWS::Glue::Table',
          { DatabaseName: { Ref: 'Db' }, TableInput: {} },
          { DatabaseName: 'other' }
        )
      ).rejects.toThrow(/^(?![\s\S]*NOTE: this id)[\s\S]*Invalid physicalId format/);
    });

    // A string DatabaseName that does not anchor, or a one-`|` id, keeps the
    // plain malformed-id wording: there the id IS what is wrong.
    it.each([
      ['a one-separator id', 'mydb|', { DatabaseName: { Ref: 'Db' } }],
      ['a string DatabaseName that does not anchor', 'my|db|orders', { DatabaseName: 'other' }],
    ])('keeps the plain wording for %s', async (_n, id, props) => {
      await new GlueProvider().delete('MyTable', id, 'AWS::Glue::Table', props);
      expect(warned()).toContain('Invalid physicalId format for Glue Table MyTable');
      expect(warned()).not.toContain('properties.DatabaseName in state.json');
    });
  });

  describe('with no anchor, an id with more than one separator is ambiguous', () => {
    // Before the fix each of these acted on `mydb.a` — a table the record does not name.
    it('delete skips instead of deleting the first-segment table', async () => {
      const result = await new GlueProvider().delete('MyTable', ID, 'AWS::Glue::Table', {
        DatabaseName: 'elsewhere',
      });
      expect(result).toMatchObject({ outcome: 'skipped' });
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('update refuses', async () => {
      await expect(
        new GlueProvider().update('MyTable', ID, 'AWS::Glue::Table', { TableInput: {} }, {})
      ).rejects.toThrow(/Invalid physicalId format for Glue Table MyTable/);
      expect(mockGlueSend).not.toHaveBeenCalled();
    });

    it('read returns undefined', async () => {
      await expect(
        new GlueProvider().readCurrentState(ID, 'MyTable', 'AWS::Glue::Table')
      ).resolves.toBeUndefined();
      expect(mockGlueSend).not.toHaveBeenCalled();
    });
  });
});

describe('AWS::S3Tables::* composite id guard', () => {
  it('downgrades a namespace refusal to a warning on a state replay', async () => {
    // `S3TablesProvider.create` gained its `CreateContext` parameter for this:
    // the refusal is structurally unreachable, but a MISSING parameter is its
    // own failure mode (no type error, no warning, a refusal that still fires
    // on a replay), so the wiring is pinned rather than reasoned about.
    mockS3TablesSend.mockResolvedValueOnce({});
    const provider = new S3TablesProvider();
    const result = await provider.create(
      'Ns',
      'AWS::S3Tables::Namespace',
      {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'a|b',
      },
      REPLAY
    );
    expect(result.physicalId).toBe('arn:aws:s3tables:us-east-1:123456789012:bucket/b|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("namespace 'a|b'"));
  });

  it('downgrades a table refusal to a warning on a state replay', async () => {
    mockS3TablesSend.mockResolvedValueOnce({
      tableARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
    });
    const provider = new S3TablesProvider();
    const result = await provider.create(
      'Tbl',
      'AWS::S3Tables::Table',
      {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'analytics',
        TableName: 'a|b',
        OpenTableFormat: 'ICEBERG',
      },
      REPLAY
    );
    expect(result.physicalId).toBe(
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics|a|b'
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("name 'a|b'"));
  });

  it('skips an importNamespace whose composite carries the separator', async () => {
    // Unreachable through `parseNamespaceCompositeId`'s exact-two-part split,
    // so the guard is driven directly to prove it is wired at all — deleting it
    // would otherwise be undetectable.
    const provider = new S3TablesProvider();
    const refusal = compositeIdSeparatorRefusal('AWS::S3Tables::Namespace', 'Ns', [
      { name: 'tableBucketARN', value: 'arn:aws:s3tables:us-east-1:1:bucket/b' },
      { name: 'namespace', value: 'a|b' },
    ]);
    expect(refusal).toContain("namespace 'a|b'");

    // And the reachable half: a well-formed composite still adopts, so the
    // guard cannot be "passing" by refusing everything.
    mockS3TablesSend.mockResolvedValueOnce({});
    const result = await provider.import({
      logicalId: 'Ns',
      resourceType: 'AWS::S3Tables::Namespace',
      knownPhysicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result?.physicalId).toBe(
      'arn:aws:s3tables:us-east-1:123456789012:bucket/b|analytics'
    );
  });

  it('refuses a namespace containing the separator, before CreateNamespace runs', async () => {
    const provider = new S3TablesProvider();
    await expect(
      provider.create('Ns', 'AWS::S3Tables::Namespace', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'a|b',
      })
    ).rejects.toThrow(/namespace 'a\|b'/);
    expect(mockS3TablesSend).not.toHaveBeenCalled();
  });

  it('refuses a table name containing the separator, before CreateTable runs', async () => {
    const provider = new S3TablesProvider();
    await expect(
      provider.create('Tbl', 'AWS::S3Tables::Table', {
        TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
        Namespace: 'analytics',
        TableName: 'a|b',
        OpenTableFormat: 'ICEBERG',
      })
    ).rejects.toThrow(/name 'a\|b'/);
    expect(mockS3TablesSend).not.toHaveBeenCalled();
  });

  it('skips an import whose GetTable-derived identity carries the separator', async () => {
    // The import path warns and returns null (`skipped-not-found`) rather than
    // throwing: that is this method's answer to every other unusable id, and a
    // throw would abort the whole `cdkd import` over one row.
    mockS3TablesSend.mockResolvedValueOnce({
      tableARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
      namespace: ['a|b'],
      name: 'orders',
    });
    const provider = new S3TablesProvider();
    const result = await provider.import({
      logicalId: 'Tbl',
      resourceType: 'AWS::S3Tables::Table',
      knownPhysicalId: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b/table/t1',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("namespace 'a|b'"));
  });
});

describe('AWS::AppSync::* composite id guard', () => {
  it('refuses a DataSource name containing the separator, before CreateDataSource runs', async () => {
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Ds', 'AWS::AppSync::DataSource', {
        ApiId: 'api1',
        Name: 'a|b',
        Type: 'NONE',
      })
    ).rejects.toThrow(/name 'a\|b'/);
    expect(mockAppSyncSend).not.toHaveBeenCalled();
  });

  it('refuses a Resolver FieldName containing the separator', async () => {
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Rs', 'AWS::AppSync::Resolver', {
        ApiId: 'api1',
        TypeName: 'Query',
        FieldName: 'a|b',
      })
    ).rejects.toThrow(/fieldName 'a\|b'/);
    expect(mockAppSyncSend).not.toHaveBeenCalled();
  });

  it('downgrades a DataSource refusal to a warning on a state replay', async () => {
    mockAppSyncSend.mockResolvedValueOnce({});
    const provider = new AppSyncProvider();
    const result = await provider.create(
      'Ds',
      'AWS::AppSync::DataSource',
      { ApiId: 'api1', Name: 'a|b', Type: 'NONE' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("name 'a|b'"));
  });

  it('downgrades a Resolver refusal to a warning on a state replay', async () => {
    mockAppSyncSend.mockResolvedValueOnce({});
    const provider = new AppSyncProvider();
    const result = await provider.create(
      'Rs',
      'AWS::AppSync::Resolver',
      { ApiId: 'api1', TypeName: 'Query', FieldName: 'a|b' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|Query|a|b');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("fieldName 'a|b'"));
  });

  it('guards createApiKey, whose apiKeyId only exists after CreateApiKey', async () => {
    // The post-call site. Both segments are AWS-generated, so the refusal is
    // driven by an AWS response carrying a separator rather than by a template.
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2|xyz' } });
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' })
    ).rejects.toThrow(/apiKeyId 'da2\|xyz'/);
  });

  it('reports the createApiKey refusal AS a refusal, not as a creation failure', async () => {
    // The pack sits OUTSIDE the try whose catch re-wraps as
    // `Failed to create ApiKey …`. Inside it, the message below would name an
    // AWS failure for a key AWS had in fact created.
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2|xyz' } });
    const provider = new AppSyncProvider();
    await expect(
      provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' })
    ).rejects.toThrow(/^(?!.*Failed to create ApiKey)/s);
  });

  it('still records a clean ApiKey composite id', async () => {
    mockAppSyncSend.mockResolvedValueOnce({ apiKey: { id: 'da2-abc' } });
    const provider = new AppSyncProvider();
    const result = await provider.create('Key', 'AWS::AppSync::ApiKey', { ApiId: 'api1' });
    expect(result.physicalId).toBe('api1|da2-abc');
    expect(result.attributes?.['ApiKey']).toBe('da2-abc');
  });
});

describe('AWS::EC2::SecurityGroupIngress composite id guard', () => {
  it('refuses an IpProtocol containing the separator, before authorizing', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Ingress', 'AWS::EC2::SecurityGroupIngress', {
        GroupId: 'sg-1',
        IpProtocol: 'a|b',
        FromPort: 80,
        ToPort: 80,
        CidrIp: '0.0.0.0/0',
      })
    ).rejects.toThrow(/ipProtocol 'a\|b'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('WARNS instead of throwing on the update path, where the rule is already revoked', async () => {
    // `updateSecurityGroupIngress` revokes then re-creates, and passes the
    // callback UNCONDITIONALLY — a throw here would strand the rule deleted
    // from AWS with no template-side remedy.
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.update(
      'Ingress',
      'sg-1|tcp|80|80',
      'AWS::EC2::SecurityGroupIngress',
      { GroupId: 'sg-1', IpProtocol: 'a|b', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
      { GroupId: 'sg-1', IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' }
    );
    expect(result.physicalId).toBe('sg-1|a|b|80|80');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("ipProtocol 'a|b'"));
  });

  it('refuses an EC2 Route destination containing the separator, before CreateRoute runs', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Rt', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/16|x',
        GatewayId: 'igw-1',
      })
    ).rejects.toThrow(/destination '10\.0\.0\.0\/16\|x'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('downgrades the Route refusal on a state replay (create-dispatch ternary)', async () => {
    // Pins the `context?.replayingState === true ? cb : undefined` ternary in
    // `create()`'s dispatch: mutate it to a bare `undefined` and a rollback
    // replay THROWS with no template-side remedy, while every other test stays
    // green.
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.create(
      'Rt',
      'AWS::EC2::Route',
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16|x', GatewayId: 'igw-1' },
      REPLAY
    );
    expect(result.physicalId).toBe('rtb-1|10.0.0.0/16|x');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("destination '10.0.0.0/16|x'")
    );
  });

  it('downgrades the SecurityGroupIngress refusal on a state replay (create-dispatch ternary)', async () => {
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.create(
      'Ingress',
      'AWS::EC2::SecurityGroupIngress',
      { GroupId: 'sg-1', IpProtocol: 'a|b', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
      REPLAY
    );
    expect(result.physicalId).toBe('sg-1|a|b|80|80');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("ipProtocol 'a|b'"));
  });

  it('WARNS on updateRoute, where the route is already deleted', async () => {
    // `updateRoute` deletes then re-creates and passes the callback
    // UNCONDITIONALLY, so the separator refusal stays a warning even on the
    // template path — by decision (issue #3728), not for want of a signal:
    // both segments are createOnly, so the id an update packs is the one the
    // recorded route already carries, and a throw here would strand a deleted
    // route. (This row changes the destination only to put a `|` in play; in
    // production that change is a replacement and never reaches `update()`.)
    mockEc2Send.mockResolvedValue({});
    const provider = new EC2Provider();
    const result = await provider.update(
      'Rt',
      'rtb-1|10.0.0.0/16',
      'AWS::EC2::Route',
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16|x', GatewayId: 'igw-2' },
      { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-1' }
    );
    expect(result.physicalId).toBe('rtb-1|10.0.0.0/16|x');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("destination '10.0.0.0/16|x'")
    );
  });

  it('refuses a VPCGatewayAttachment segment containing the separator, before attaching', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Attach', 'AWS::EC2::VPCGatewayAttachment', {
        VpcId: 'vpc-1',
        InternetGatewayId: 'igw|1',
      })
    ).rejects.toThrow(/internetGatewayId 'igw\|1'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('refuses a NetworkAclEntry segment containing the separator, before CreateNetworkAclEntry runs', async () => {
    const provider = new EC2Provider();
    await expect(
      provider.create('Entry', 'AWS::EC2::NetworkAclEntry', {
        NetworkAclId: 'acl|1',
        RuleNumber: 100,
        Protocol: 6,
        RuleAction: 'allow',
        Egress: false,
      })
    ).rejects.toThrow(/networkAclId 'acl\|1'/);
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('stringifies the NetworkAclEntry number and boolean segments', async () => {
    // The only guarded site with non-string segments — pins that they survive
    // the pack unchanged rather than being coerced or refused.
    mockEc2Send.mockResolvedValueOnce({});
    const provider = new EC2Provider();
    const result = await provider.create('Entry', 'AWS::EC2::NetworkAclEntry', {
      NetworkAclId: 'acl-1',
      RuleNumber: 100,
      Protocol: 6,
      RuleAction: 'allow',
      Egress: false,
    });
    expect(result.physicalId).toBe('acl-1|100|false');
  });
});

describe('AWS::EC2::EIP composite id guard', () => {
  it('refuses an allocation whose AWS-returned segments carry the separator', async () => {
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    await expect(
      provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' })
    ).rejects.toThrow(/allocationId 'eipalloc\|1'/);
  });

  it('reports the createEip refusal AS a refusal, not as an allocation failure', async () => {
    // The pack sits OUTSIDE the try whose catch re-wraps as
    // `Failed to create EIP …` — inside it, an address AWS had already handed
    // out would be reported as an allocation failure.
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    await expect(provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' })).rejects.toThrow(
      /^(?!.*Failed to create EIP)/s
    );
  });

  it('still records a clean EIP composite id', async () => {
    mockEc2Send.mockResolvedValueOnce({ AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' });
    const provider = new EC2Provider();
    const result = await provider.create('Eip', 'AWS::EC2::EIP', { Domain: 'vpc' });
    expect(result.physicalId).toBe('1.2.3.4|eipalloc-1');
  });

  it('SKIPS an import whose DescribeAddresses segments carry the separator', async () => {
    // Warn-and-skip, matching the S3 Tables import arms — adopting a knowingly
    // ambiguous id is the destructive direction.
    mockEc2Send.mockResolvedValueOnce({
      Addresses: [{ AllocationId: 'eipalloc|1', PublicIp: '1.2.3.4' }],
    });
    const provider = new EC2Provider();
    const result = await provider.import({
      logicalId: 'Eip',
      resourceType: 'AWS::EC2::EIP',
      knownPhysicalId: '1.2.3.4',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result).toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("allocationId 'eipalloc|1'")
    );
  });

  it('still adopts a clean EIP on import', async () => {
    mockEc2Send.mockResolvedValueOnce({
      Addresses: [{ AllocationId: 'eipalloc-1', PublicIp: '1.2.3.4' }],
    });
    const provider = new EC2Provider();
    const result = await provider.import({
      logicalId: 'Eip',
      resourceType: 'AWS::EC2::EIP',
      knownPhysicalId: '1.2.3.4',
      properties: {},
      stackName: 'TestStack',
      region: 'us-east-1',
    });
    expect(result?.physicalId).toBe('1.2.3.4|eipalloc-1');
  });
});

describe('AWS::ApiGateway::Method composite id guard', () => {
  it('refuses an HttpMethod containing the separator, before PutMethod runs', async () => {
    const provider = new ApiGatewayProvider();
    await expect(
      provider.create('Method', 'AWS::ApiGateway::Method', {
        RestApiId: 'api1',
        ResourceId: 'res1',
        HttpMethod: 'GE|T',
      })
    ).rejects.toThrow(/httpMethod 'GE\|T'/);
    expect(mockApiGatewaySend).not.toHaveBeenCalled();
  });

  it('downgrades to a warning on a state replay', async () => {
    mockApiGatewaySend.mockResolvedValue({});
    const provider = new ApiGatewayProvider();
    const result = await provider.create(
      'Method',
      'AWS::ApiGateway::Method',
      { RestApiId: 'api1', ResourceId: 'res1', HttpMethod: 'GE|T' },
      REPLAY
    );
    expect(result.physicalId).toBe('api1|res1|GE|T');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("httpMethod 'GE|T'"));
  });
});

describe('AWS::Lambda::EventInvokeConfig composite id guard', () => {
  it('refuses a FunctionName containing the separator, before the Put runs', async () => {
    const provider = new LambdaEventInvokeConfigProvider();
    await expect(
      provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'fn|x',
        Qualifier: 'live',
      })
    ).rejects.toThrow(/functionName 'fn\|x'/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('refuses a Qualifier containing the separator', async () => {
    const provider = new LambdaEventInvokeConfigProvider();
    await expect(
      provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: 'fn',
        Qualifier: 'li|ve',
      })
    ).rejects.toThrow(/qualifier 'li\|ve'/);
    expect(mockLambdaSend).not.toHaveBeenCalled();
  });

  it('still records a clean composite id', async () => {
    mockLambdaSend.mockResolvedValueOnce({});
    const provider = new LambdaEventInvokeConfigProvider();
    const result = await provider.create('Cfg', 'AWS::Lambda::EventInvokeConfig', {
      FunctionName: 'fn',
      Qualifier: 'live',
    });
    expect(result.physicalId).toBe('fn|live');
  });

  it('downgrades to a warning on a state replay', async () => {
    mockLambdaSend.mockResolvedValueOnce({});
    const provider = new LambdaEventInvokeConfigProvider();
    const result = await provider.create(
      'Cfg',
      'AWS::Lambda::EventInvokeConfig',
      { FunctionName: 'fn|x', Qualifier: 'live' },
      REPLAY
    );
    expect(result.physicalId).toBe('fn|x|live');
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("functionName 'fn|x'"));
  });
});

describe('AWS::Route53::RecordSet composite id', () => {
  const RECORD_TYPE = 'AWS::Route53::RecordSet';
  const PIPE_ID = 'Z1D633PJN98FT9|a|b.example.com.|A';
  const sentCommand = (index: number) =>
    mockRoute53Send.mock.calls[index]?.[0] as {
      constructor: { name: string };
      input: Record<string, unknown> & {
        HostedZoneId?: string;
        StartRecordName?: string;
        ChangeBatch?: { Changes?: { ResourceRecordSet?: { Name?: string } }[] };
      };
    };

  // Issue #3890: Route 53 accepts `|` in a record name, so cdkd records it
  // instead of refusing it. Every reader anchors the name on `Name` / `Type`.
  it('creates a record whose Name contains the separator and records the id', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.create('MyRecord', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    expect(result.physicalId).toBe(PIPE_ID);
    expect(sentCommand(0).input.ChangeBatch?.Changes?.[0]?.ResourceRecordSet?.Name).toBe(
      'a|b.example.com.'
    );
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('still records a clean composite id', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.create('MyRecord', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'www.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    expect(result.physicalId).toBe('Z1D633PJN98FT9|www.example.com.|A');
  });

  it('updates a record whose Name already contains the separator, with no warning', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.update(
      'MyRecord',
      PIPE_ID,
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
        TTL: '600',
        ResourceRecords: ['1.2.3.4'],
      },
      { HostedZoneId: 'Z1D633PJN98FT9', Name: 'a|b.example.com.', Type: 'A', TTL: '300' }
    );
    expect(result.physicalId).toBe(PIPE_ID);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockRoute53Send).toHaveBeenCalledTimes(1);
  });

  it('a template rename INTO the separator is applied, not refused', async () => {
    // A rename looks the old record up first, then writes (issue #3741).
    mockRoute53Send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.update(
      'MyRecord',
      'Z1D633PJN98FT9|www.example.com.|A',
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      },
      { HostedZoneId: 'Z1D633PJN98FT9', Name: 'www.example.com.', Type: 'A' }
    );
    expect(result.physicalId).toBe(PIPE_ID);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockRoute53Send).toHaveBeenCalledTimes(2);
  });

  it('update still records a clean composite id', async () => {
    mockRoute53Send.mockResolvedValueOnce({});
    const provider = new Route53Provider();
    const result = await provider.update(
      'MyRecord',
      'Z1D633PJN98FT9|www.example.com.|A',
      RECORD_TYPE,
      {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'www.example.com.',
        Type: 'A',
        TTL: '600',
        ResourceRecords: ['1.2.3.4'],
      },
      { HostedZoneId: 'Z1D633PJN98FT9', Name: 'www.example.com.', Type: 'A', TTL: '300' }
    );
    expect(result.physicalId).toBe('Z1D633PJN98FT9|www.example.com.|A');
  });

  it('delete decodes an ANCHORED id whose name contains the separator, with no zone lookup', async () => {
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', PIPE_ID, RECORD_TYPE, {
      HostedZoneId: 'ZSHOULDNOTBEUSED',
      Name: 'A|B.example.com',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    // Sourced from the id, not from the properties: the composite path ran.
    expect(sentCommand(0).input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  // An id longer than three segments is only a CANDIDATE split; without both
  // anchors the delete addresses the record from the recorded properties.
  it.each([
    ['the recorded Type disagrees', { Name: 'a|b.example.com.', Type: 'CNAME' }],
    ['the recorded Name disagrees', { Name: 'other.example.com.', Type: 'A' }],
    ['the recorded Name is an unresolved intrinsic', { Name: { Ref: 'P' }, Type: 'A' }],
    ['the recorded Type is an unresolved intrinsic', { Name: 'a|b.example.com.', Type: { Ref: 'P' } }],
    ['the recorded Name is empty', { Name: '', Type: 'A' }],
  ])('delete does not trust the candidate split when %s', async (_label, recorded) => {
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', PIPE_ID, RECORD_TYPE, {
      HostedZoneId: 'ZFROMPROPERTIES',
      ...recorded,
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    expect(sentCommand(0).input.HostedZoneId).toBe('ZFROMPROPERTIES');
  });

  it("CloudFormation's scalar id with three pipes is never decoded as a composite", async () => {
    // The record name itself, recorded beside the same `Name`: the middle of
    // a longer id is strictly shorter than the id, so the Name anchor fails.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|c|A', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b|c|A',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });
    expect(sentCommand(0).input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('a read with no recorded bag never trusts a name containing the separator', async () => {
    // Nothing to anchor the candidate split on, so nothing is read.
    const provider = new Route53Provider();
    await expect(provider.readCurrentState(PIPE_ID, 'MyRecord', RECORD_TYPE)).resolves.toBeUndefined();
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });

  it('a read whose bag does not anchor the candidate resolves the record from the bag', async () => {
    // The recorded Type disagrees with the id's last segment, so the read
    // takes the zone, Name and Type from the recorded properties.
    mockRoute53Send.mockResolvedValueOnce({ ResourceRecordSets: [] });
    const provider = new Route53Provider();
    await provider.readCurrentState(PIPE_ID, 'MyRecord', RECORD_TYPE, {
      HostedZoneId: 'ZFROMPROPERTIES',
      Name: 'a|b.example.com.',
      Type: 'CNAME',
    });
    expect(sentCommand(0).input.HostedZoneId).toBe('ZFROMPROPERTIES');
    expect(sentCommand(0).input.StartRecordType).toBe('CNAME');
  });

  it('drift reads the record by its escaped name and reports it under the template spelling', async () => {
    // Route 53 stores and returns `|` as `\174`; the list start key must use
    // that spelling, or the record sorts before the window and is missed.
    mockRoute53Send.mockResolvedValueOnce({
      ResourceRecordSets: [
        { Name: 'a\\174b.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
      ],
    });
    const provider = new Route53Provider();
    const observed = await provider.readCurrentState(PIPE_ID, 'MyRecord', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b.example.com.',
      Type: 'A',
    });
    expect(sentCommand(0).input.HostedZoneId).toBe('Z1D633PJN98FT9');
    expect(sentCommand(0).input.StartRecordName).toBe('a\\174b.example.com.');
    expect(observed).toMatchObject({ Name: 'a|b.example.com.', Type: 'A', TTL: 300 });
  });

  it('a record NAME that merely LOOKS like a composite is not decoded as one', async () => {
    // The blocker a reviewer found. `parseRecordSetCompositeId` asks only for
    // three non-empty segments, so a two-pipe record name — exactly the CFn
    // physicalId `--migrate-from-cloudformation` pre-populates — parsed as a
    // "valid" composite meaning zone 'a', name 'b', type 'c.example.com.'.
    //
    // The IMPORT return value cannot fence this: both the bug and the fix
    // adopt the same STRING, and they differ only in what the id is taken to
    // MEAN. DELETE is where that costs something, so this drives the delete
    // and asserts the zone actually targeted.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|c.example.com.', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b|c.example.com.',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    // Before the fix this was 'a' — a zone that does not exist, so the delete
    // took the NoSuchHostedZone arm and reported success with the record live.
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('a look-alike whose TYPE segment coincidentally matches is not decoded either', async () => {
    // The residual the Type cross-check alone leaves: `a|b|A` on a record whose
    // Type really is 'A' agrees on the type and still decodes to zone 'a'.
    // Only the NAME check rejects it.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|A', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: 'a|b|A',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('the TYPE check alone discriminates when the NAME is an unresolved intrinsic', async () => {
    // Found by review: deleting the TYPE check failed NOTHING, because the NAME
    // check subsumes it for every look-alike the other rows use. The TYPE check
    // is the sole discriminator exactly when the template NAME is unusable — an
    // unresolved intrinsic — and the type still disagrees.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|MX', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: { Ref: 'SomeParam' },
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('a GENUINE composite is still decoded, with no zone lookup', async () => {
    // The control the cross-check must not break. The name compare is case- and
    // trailing-dot-insensitive, so a template spelling the name without CDK's
    // trailing dot still takes the composite path.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'Z1D633PJN98FT9|www.example.com.|A', RECORD_TYPE, {
      HostedZoneId: 'ZSHOULDNOTBEUSED',
      Name: 'WWW.example.com',
      Type: 'A',
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as {
      input: { HostedZoneId?: string };
    };
    // Sourced from the composite, NOT from the properties — which is what
    // proves the composite path was taken rather than the fallback.
    expect(change.input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it('accepted bound: BOTH template fields unusable leaves the mis-decode reachable', async () => {
    // Pinned as a DECISION rather than left as an accident (review finding).
    // With neither `Name` nor `Type` readable there is nothing to check the
    // parse against, so `compositeAgreesWithTemplate` returns true and the
    // look-alike IS decoded — zone 'a'. The alternative is refusing every id on
    // a bag cdkd cannot read, which would break the pre-#1711 behavior for
    // templates that resolve fine at deploy time. If this row ever starts
    // failing, the bound was tightened on purpose and the JSDoc must follow.
    mockRoute53Send.mockResolvedValue({});
    const provider = new Route53Provider();
    await provider.delete('MyRecord', 'a|b|c.example.com.', RECORD_TYPE, {
      HostedZoneId: 'Z1D633PJN98FT9',
      Name: { Ref: 'NameParam' },
      Type: { Ref: 'TypeParam' },
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    });

    const change = mockRoute53Send.mock.calls[0]?.[0] as { input: { HostedZoneId?: string } };
    expect(change.input.HostedZoneId).toBe('a');
  });

  it('a look-alike resolved from HostedZoneName REFUSES an ambiguous split-horizon pair', async () => {
    // The population this change NEWLY routes into the fallback (review
    // finding 4): before it, a look-alike short-circuited on the parse and
    // never resolved a zone at all. The fallback runs with
    // `requireUnambiguousZoneName`, so a public + private pair of the same name
    // must THROW rather than guess — deleting from the wrong zone is
    // unrecoverable. Untested before this row, and it is a behavior this PR
    // introduced rather than inherited.
    mockRoute53Send.mockResolvedValueOnce({
      HostedZones: [
        { Id: '/hostedzone/ZPUBLIC1', Name: 'example.com.', Config: { PrivateZone: false } },
        { Id: '/hostedzone/ZPRIVATE1', Name: 'example.com.', Config: { PrivateZone: true } },
      ],
      IsTruncated: false,
    });
    const provider = new Route53Provider();
    await expect(
      provider.delete('MyRecord', 'a|b|c.example.com.', RECORD_TYPE, {
        HostedZoneName: 'example.com.',
        Name: 'a|b|c.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      })
    ).rejects.toThrow(/matches 2 hosted zones/);

    // The refusal happens BEFORE any ChangeResourceRecordSets — only the
    // lookup went out, so nothing was deleted from either zone.
    const changes = mockRoute53Send.mock.calls.filter(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name ===
        'ChangeResourceRecordSetsCommand'
    );
    expect(changes).toHaveLength(0);
  });

  it("import canonicalizes CloudFormation's scalar id for a name containing the separator", async () => {
    // Before issue #3890 this adopted the scalar verbatim, refusing to pack it.
    mockRoute53Send.mockResolvedValueOnce({
      ResourceRecordSets: [
        { Name: 'a\\174b.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
      ],
    });
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'a|b.example.com.',
      properties: {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b.example.com.',
        Type: 'A',
      },
    });
    expect(result).toEqual({ physicalId: PIPE_ID, attributes: {} });
    expect(sentCommand(0).input.StartRecordName).toBe('a\\174b.example.com.');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('import canonicalizes a three-part look-alike to the composite, never the mis-decode', async () => {
    mockRoute53Send.mockResolvedValueOnce({
      ResourceRecordSets: [
        { Name: 'a\\174b\\174c.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
      ],
    });
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'a|b|c.example.com.',
      properties: {
        HostedZoneId: 'Z1D633PJN98FT9',
        Name: 'a|b|c.example.com.',
        Type: 'A',
      },
    });
    // Zone 'a' / name 'b' / type 'c.example.com.' is what the bare parse said.
    expect(result).toEqual({ physicalId: 'Z1D633PJN98FT9|a|b|c.example.com.|A', attributes: {} });
    expect(sentCommand(0).input.HostedZoneId).toBe('Z1D633PJN98FT9');
  });

  it.each([
    ['an unresolved intrinsic', { 'Fn::Join': ['', ['a|b.', 'example.com.']] }],
    ['a parameter Ref', { Ref: 'RecordNameParam' }],
  ])(
    'import keeps the verbatim id when the template Name is %s and the record name contains the separator',
    async (_label, templateName) => {
      // The composite would carry a `|` name no later read can anchor on the
      // recorded Name, so drift would read nothing; the scalar falls back to
      // the properties instead.
      const provider = new Route53Provider();
      const result = await provider.import({
        logicalId: 'MyRecord',
        resourceType: RECORD_TYPE,
        stackName: 'TestStack',
        region: 'us-east-1',
        knownPhysicalId: 'a|b.example.com.',
        properties: { HostedZoneId: 'Z1D633PJN98FT9', Name: templateName, Type: 'A' },
      });
      expect(result).toEqual({ physicalId: 'a|b.example.com.', attributes: {} });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('not a plain string to anchor it on')
      );
      expect(mockRoute53Send).not.toHaveBeenCalled();
    }
  );

  it('import still packs a separator-free record whose template Name is an unresolved intrinsic', async () => {
    // The verbatim branch is for a name carrying `|` only: a plain record
    // with an intrinsic Name packs and verifies as before issue #3890.
    mockRoute53Send.mockResolvedValueOnce({
      ResourceRecordSets: [
        { Name: 'www.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
      ],
    });
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'www.example.com.',
      properties: { HostedZoneId: 'Z1D633PJN98FT9', Name: { Ref: 'P' }, Type: 'A' },
    });
    expect(result).toEqual({ physicalId: 'Z1D633PJN98FT9|www.example.com.|A', attributes: {} });
    expect(mockLoggerWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('not a plain string to anchor it on')
    );
    expect(sentCommand(0).constructor.name).toBe('ListResourceRecordSetsCommand');
    expect(sentCommand(0).input.StartRecordName).toBe('www.example.com.');
  });

  it('import keeps the verbatim id when the template Name is empty and the record name contains the separator', async () => {
    // Unreachable through `resolveRecordSetIdentity` today (an empty Name
    // resolves no identity), so the identity is stubbed: the guard itself must
    // not count an empty Name as one the anchor can match.
    const provider = new Route53Provider();
    const spy = vi
      .spyOn(
        provider as unknown as { resolveRecordSetIdentity: (...a: unknown[]) => unknown },
        'resolveRecordSetIdentity'
      )
      .mockResolvedValue({ hostedZoneId: 'Z1D633PJN98FT9', name: 'a|b.example.com.', type: 'A' });
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: 'a|b.example.com.',
      properties: { HostedZoneId: 'Z1D633PJN98FT9', Name: '', Type: 'A' },
    });
    expect(spy).toHaveBeenCalled();
    expect(result).toEqual({ physicalId: 'a|b.example.com.', attributes: {} });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('not a plain string to anchor it on')
    );
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });

  it('a weighted record whose Name and SetIdentifier both contain the separator is read and deleted', async () => {
    // SetIdentifier is not part of the id, and Route 53 stores it as given,
    // so it goes out raw in both the read's start key and the DELETE.
    const recorded = {
      HostedZoneId: 'ZSHOULDNOTBEUSED',
      Name: 'a|b.example.com.',
      Type: 'A',
      SetIdentifier: 'x|y',
      Weight: 10,
      TTL: '300',
      ResourceRecords: ['1.2.3.4'],
    };
    mockRoute53Send.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: 'a\\174b.example.com.',
          Type: 'A',
          SetIdentifier: 'x|y',
          Weight: 10,
          TTL: 300,
          ResourceRecords: [{ Value: '1.2.3.4' }],
        },
      ],
    });
    const provider = new Route53Provider();
    const observed = await provider.readCurrentState(PIPE_ID, 'MyRecord', RECORD_TYPE, recorded);
    expect(sentCommand(0).input.HostedZoneId).toBe('Z1D633PJN98FT9');
    expect(sentCommand(0).input.StartRecordName).toBe('a\\174b.example.com.');
    expect(sentCommand(0).input['StartRecordIdentifier']).toBe('x|y');
    expect(observed).toMatchObject({ Name: 'a|b.example.com.', Type: 'A' });

    mockRoute53Send.mockReset();
    mockRoute53Send.mockResolvedValue({});
    await provider.delete('MyRecord', PIPE_ID, RECORD_TYPE, recorded);
    const change = mockRoute53Send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: Record<string, unknown> })
      .find((c) => c.constructor.name === 'ChangeResourceRecordSetsCommand');
    expect(change?.input['HostedZoneId']).toBe('Z1D633PJN98FT9');
    const deleted = (
      change?.input['ChangeBatch'] as {
        Changes: { Action: string; ResourceRecordSet: { Name?: string; SetIdentifier?: string } }[];
      }
    ).Changes[0];
    expect(deleted?.Action).toBe('DELETE');
    expect(deleted?.ResourceRecordSet).toMatchObject({ Name: 'a|b.example.com.', SetIdentifier: 'x|y' });
  });

  it('import accepts an anchored composite override whose name contains the separator', async () => {
    const provider = new Route53Provider();
    const result = await provider.import({
      logicalId: 'MyRecord',
      resourceType: RECORD_TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      knownPhysicalId: PIPE_ID,
      properties: { HostedZoneId: 'Z1D633PJN98FT9', Name: 'a|b.example.com.', Type: 'A' },
    });
    expect(result).toEqual({ physicalId: PIPE_ID, attributes: {} });
    expect(mockRoute53Send).not.toHaveBeenCalled();
  });
});
