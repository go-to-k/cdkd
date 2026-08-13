import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

/**
 * Every guard under test is the FIRST statement after a `logger.debug`, so no
 * SDK response has to be primed — but the clients still get constructed, so
 * each module is stubbed to keep the suite off the network.
 *
 * `vi.hoisted` is required: the `vi.mock` factories are hoisted above ordinary
 * module scope, so a plain `const stubClient = ...` is in its TDZ when they run.
 */
const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-s3tables', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-s3tables');
  return { ...actual, S3TablesClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-api-gateway', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-api-gateway');
  return { ...actual, APIGatewayClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-glue', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-glue');
  return { ...actual, GlueClient: vi.fn().mockImplementation(stubClient) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';
import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';

/**
 * Issue #1657, PR review finding: the helper's own unit tests build SYNTHETIC
 * `CompositeIdFormat` literals, and only the AppSync + Glue-delete sites had a
 * behavioral test. So none of the production constants outside those was pinned
 * anywhere, and a mutation swapping one site's constant for a sibling's passed
 * the whole suite.
 *
 * That is not a hypothetical class of defect — it is the one this PR shipped:
 * `EC2_VPC_GATEWAY_ATTACHMENT_ID_FORMAT` named a segment `IGW`, a token no
 * packer emits, and nothing failed. These assertions are therefore EXACT
 * strings, and each expected shape is written to match the type's
 * `packCompositeId` segment names.
 */
describe('composite-id decode messages, per site (issue #1657)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const noSend = () => expect(send).not.toHaveBeenCalled();

  describe('EC2Provider', () => {
    const provider = () => new EC2Provider();

    it('VPCGatewayAttachment delete names the REAL packer segments, never a fixed token', async () => {
      await expect(
        provider().delete('MyAttach', 'lonely', 'AWS::EC2::VPCGatewayAttachment')
      ).rejects.toThrow(
        'Invalid physicalId format for VPCGatewayAttachment MyAttach: ' +
          'expected "<internetGatewayId>|<vpcId>", got "lonely"'
      );
      noSend();
    });

    it('Route delete', async () => {
      await expect(provider().delete('MyRoute', 'lonely', 'AWS::EC2::Route')).rejects.toThrow(
        'Invalid physicalId format for Route MyRoute: ' +
          'expected "<routeTableId>|<destination>", got "lonely"'
      );
      noSend();
    });

    it('SecurityGroupIngress delete', async () => {
      await expect(
        provider().delete('MyIngress', 'a|b', 'AWS::EC2::SecurityGroupIngress')
      ).rejects.toThrow(
        'Invalid physicalId format for SecurityGroupIngress MyIngress: ' +
          'expected "<groupId>|<ipProtocol>|<fromPort>|<toPort>", got "a|b"'
      );
      noSend();
    });

    it('NetworkAclEntry delete WARNS (and says the resource survives) instead of throwing', async () => {
      await provider().delete('MyEntry', 'acl-123', 'AWS::EC2::NetworkAclEntry');

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(
        'Invalid physicalId format for NetworkAclEntry MyEntry: ' +
          'expected "<networkAclId>|<ruleNumber>|<egress>", got "acl-123"'
      );
      expect(warned).toContain('LEFT IN PLACE');
      noSend();
    });
  });

  describe('S3TablesProvider', () => {
    const provider = () => new S3TablesProvider();

    it('Namespace delete', async () => {
      await expect(
        provider().delete('MyNs', 'lonely', 'AWS::S3Tables::Namespace')
      ).rejects.toThrow(
        'Invalid physicalId format for S3 Tables Namespace MyNs: ' +
          'expected "<tableBucketARN>|<namespace>", got "lonely"'
      );
      noSend();
    });

    it('Table delete keeps the second accepted form in the message', async () => {
      await expect(provider().delete('MyTbl', 'lonely', 'AWS::S3Tables::Table')).rejects.toThrow(
        'Invalid physicalId format for S3 Tables Table MyTbl: ' +
          'expected "<tableBucketARN>|<namespace>|<name>" or a table ARN, got "lonely"'
      );
      noSend();
    });

    it('the applyTableTagsDiff arm — the 17th site, reached from update()', async () => {
      // `resolveTableParts` answers 'unparseable' from pure string inspection
      // for an id with no separator that is not an ARN, and `applyTableTagsDiff`
      // is the first statement of the Table update — so this needs no priming.
      // The trailing clause is unique to this site and would otherwise be the
      // one message in the family that nothing pins.
      await expect(
        provider().update(
          'MyTbl',
          'not-an-id',
          'AWS::S3Tables::Table',
          { Tags: [{ Key: 'a', Value: '1' }] },
          {}
        )
      ).rejects.toThrow(
        'applyTableTagsDiff: Invalid physicalId format for S3 Tables Table MyTbl: ' +
          'expected "<tableBucketARN>|<namespace>|<name>" or a table ARN, got "not-an-id". ' +
          'Cannot derive the table ARN for the tag update'
      );
      noSend();
    });
  });

  describe('ApiGatewayProvider', () => {
    const provider = () => new ApiGatewayProvider();

    it('Method update', async () => {
      await expect(
        provider().update('MyMethod', 'a|b', 'AWS::ApiGateway::Method', {}, {})
      ).rejects.toThrow(
        'Invalid physicalId format for API Gateway Method MyMethod: ' +
          'expected "<restApiId>|<resourceId>|<httpMethod>", got "a|b"'
      );
      noSend();
    });

    it('Method delete', async () => {
      await expect(
        provider().delete('MyMethod', 'a|b', 'AWS::ApiGateway::Method')
      ).rejects.toThrow(
        'Invalid physicalId format for API Gateway Method MyMethod: ' +
          'expected "<restApiId>|<resourceId>|<httpMethod>", got "a|b"'
      );
      noSend();
    });
  });

  describe('GlueProvider', () => {
    it('Table update', async () => {
      await expect(
        new GlueProvider().update(
          'MyTable',
          'lonely',
          'AWS::Glue::Table',
          { DatabaseName: 'db', TableInput: { Name: 't' } },
          { DatabaseName: 'db', TableInput: { Name: 't' } }
        )
      ).rejects.toThrow(
        'Invalid physicalId format for Glue Table MyTable: ' +
          'expected "<databaseName>|<tableName>", got "lonely"'
      );
      noSend();
    });
  });
});
