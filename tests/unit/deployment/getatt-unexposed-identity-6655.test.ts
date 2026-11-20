import { describe, it, expect, vi } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { SURVIVOR_IDENTITY_ATTRIBUTES } from '../../../src/deployment/recorded-identity-attributes.js';
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import { WRITABLE_GETATT_ATTRIBUTES } from '../../../src/provisioning/getatt-attributes.generated.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

/**
 * go-to-k/cdkd#6655: whether CloudFormation exposes each identity id cdkd
 * records, read from the resource specification's attribute list
 * (`@aws-cdk/aws-service-spec` 0.1.231), NOT from the committed schema the
 * code reads -- so a drift between the two fails here. UserId / GroupId /
 * InstanceProfileId are listed ahead of their table entries (go-to-k/cdkd#6693)
 * so the entry cannot land unclassified.
 */
const CFN_EXPOSES: Readonly<Record<string, readonly [string, boolean]>> = {
  'AWS::IAM::Role': ['RoleId', true],
  'AWS::IAM::ManagedPolicy': ['PolicyId', true],
  'AWS::RDS::DBInstance': ['DbiResourceId', true],
  'AWS::RDS::DBCluster': ['DBClusterResourceId', true],
  'AWS::DynamoDB::Table': ['TableId', false],
  'AWS::IAM::User': ['UserId', false],
  'AWS::IAM::Group': ['GroupId', false],
  'AWS::IAM::InstanceProfile': ['InstanceProfileId', false],
};

const resolveAttr = (
  type: string,
  attribute: string,
  attributes: Record<string, unknown> | undefined,
  strictGetAtt = false
): Promise<unknown> => {
  const context: ResolverContext = {
    template: { Resources: { X: { Type: type, Properties: {} } } },
    resources: {
      X: {
        physicalId: 'phys-x',
        resourceType: type,
        properties: {},
        ...(attributes && { attributes }),
        dependencies: [],
      },
    },
  };
  return new IntrinsicFunctionResolver('us-east-1', { strictGetAtt }).resolve(
    { 'Fn::GetAtt': ['X', attribute] },
    context
  );
};

const committedLists = (type: string, attribute: string): boolean =>
  getPropertyCoverage(type)!.readOnly.has(attribute) ||
  (WRITABLE_GETATT_ATTRIBUTES[type] ?? []).includes(attribute);

describe('Fn::GetAtt of a recorded identity id CloudFormation does not expose (#6655)', () => {
  it('every recorded identity attribute is classified, and the committed schema agrees', () => {
    for (const [type, attribute] of Object.entries(SURVIVOR_IDENTITY_ATTRIBUTES)) {
      expect(CFN_EXPOSES[type]?.[0], type).toBe(attribute);
    }
    for (const [type, [attribute, exposed]] of Object.entries(CFN_EXPOSES)) {
      expect(getPropertyCoverage(type), type).toBeDefined();
      expect(committedLists(type, attribute), `${type}.${attribute}`).toBe(exposed);
    }
  });

  // Both polarities, over every entry of the table as it stands.
  const entries = Object.entries(SURVIVOR_IDENTITY_ATTRIBUTES);
  it.each(entries.filter(([type]) => CFN_EXPOSES[type]?.[1] === false))(
    '%s.%s is refused although the record holds it, with and without --strict-getatt',
    async (type, attribute) => {
      for (const strict of [false, true]) {
        for (const attributes of [{ [attribute]: 'AIDAEXAMPLEID', Arn: 'arn:x' }, undefined]) {
          const err = await resolveAttr(type, attribute, attributes, strict).then(
            () => undefined,
            (e: unknown) => e
          );
          expect(err).toBeInstanceOf(IntrinsicResolutionRefusalError);
          expect(isMarkedNonRetryable(err)).toBe(true);
          expect((err as Error).message).toBe(
            `Cannot resolve Fn::GetAtt [X, ${attribute}] for ${type}: CloudFormation does not ` +
              `expose ${attribute} as an attribute of this type and rejects the template. cdkd ` +
              `records it for its own identity checks only. Read an attribute the type exposes, ` +
              `or use Ref.`
          );
        }
      }
    }
  );
  it('the refused polarity is reached by at least one current table entry', () => {
    expect(entries.some(([type]) => CFN_EXPOSES[type]?.[1] === false)).toBe(true);
  });

  it.each(entries.filter(([type]) => CFN_EXPOSES[type]?.[1] === true))(
    '%s.%s (exposed) keeps resolving from the record, also under --strict-getatt',
    async (type, attribute) => {
      for (const strict of [false, true]) {
        await expect(resolveAttr(type, attribute, { [attribute]: 'ID-123' }, strict)).resolves.toBe(
          'ID-123'
        );
      }
    }
  );

  it('a non-identity recorded attribute of a type with an unexposed id is served as before', async () => {
    await expect(
      resolveAttr('AWS::DynamoDB::Table', 'StreamArn', { TableId: 'tid', StreamArn: 'arn:s' })
    ).resolves.toBe('arn:s');
    // Not in the committed schema either, and still served: only the identity key is refused.
    await expect(
      resolveAttr('AWS::DynamoDB::Table', 'SomeRecordedKey', { SomeRecordedKey: 'v' })
    ).resolves.toBe('v');
  });

  it('an identity attribute name on a type that does not record it is not refused', async () => {
    // `TableId` IS an attribute of AWS::DynamoDB::GlobalTable.
    await expect(
      resolveAttr('AWS::DynamoDB::GlobalTable', 'TableId', { TableId: 'gt-id' })
    ).resolves.toBe('gt-id');
  });
});
