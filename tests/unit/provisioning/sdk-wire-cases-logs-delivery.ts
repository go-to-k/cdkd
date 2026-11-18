import {
  ACCOUNT,
  createOnlyOf,
  setOutputOverrides,
  TAG_THROWS,
  type TypeCase,
} from './sdk-wire-harness.js';
import { LogsDeliverySourceProvider } from '../../../src/provisioning/providers/logs-delivery-source-provider.js';
import { LogsDeliveryDestinationProvider } from '../../../src/provisioning/providers/logs-delivery-destination-provider.js';
import { LogsDeliveryProvider } from '../../../src/provisioning/providers/logs-delivery-provider.js';

/**
 * Wire cases for the CloudWatch Logs delivery providers (#3723), run by
 * `sdk-wire-coverage-logs-delivery.test.ts`: `AWS::Logs::DeliverySource`,
 * `AWS::Logs::DeliveryDestination`, `AWS::Logs::Delivery`.
 */

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/** A required member refused when absent: there is no default to send. */
const required = (key: string) => ({
  why: `${key} is required by the schema and has no default`,
  says: new RegExp(`${key} must be a non-empty string`),
});
const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];
const tagTargets = (arn: string) =>
  [0, 1].map((i) => ({
    path: ['Tags', i],
    command: 'UntagResourceCommand',
    names: `k${i + 1}`,
    notNames: `k${2 - i}`,
    where: arn,
  }));

const SOURCE_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:delivery-source:src`;
const DEST_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:delivery-destination:dst`;
const DELIVERY_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:delivery:abc123`;
const BUS_ARN = `arn:aws:events:us-east-1:${ACCOUNT}:event-bus/bus`;
const GROUP_ARN = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/vendedlogs/bus`;

/**
 * The harness arms a create with an empty bag and an update with the previous
 * one: the create's name probe answers not-found, an update's read the live
 * resource's ARN.
 */
function armNamed(getCommand: string, field: string, arn: string) {
  return (_physicalId: string, bag: Record<string, unknown>): void => {
    const creating = Object.keys(bag).length === 0;
    setOutputOverrides({
      [getCommand]: () => {
        if (creating) {
          throw Object.assign(new Error('not found'), {
            name: 'ResourceNotFoundException',
            $fault: 'client',
            $metadata: {},
          });
        }
        return { [field]: { name: 'n', arn } };
      },
    });
  };
}

export const CASES_LOGS_DELIVERY: TypeCase[] = [
  {
    resourceType: 'AWS::Logs::DeliverySource',
    provider: () => new LogsDeliverySourceProvider(),
    physicalId: 'src',
    createOnly: createOnlyOf('AWS::Logs::DeliverySource'),
    arm: armNamed('GetDeliverySourceCommand', 'deliverySource', SOURCE_ARN),
    exempt: {},
    targets: tagTargets(SOURCE_ARN),
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'src',
          ResourceArn: BUS_ARN,
          LogType: 'ERROR_LOGS',
          DeliverySourceConfiguration: { k1: 'v1', k2: 'v2' },
          Tags: TAGS,
        },
        variants: { LogType: 'INFO_LOGS' },
        expectedRemovalThrows: {
          'create:Name': required('Name'),
          'create:ResourceArn': required('ResourceArn'),
          'update-remove:ResourceArn': required('ResourceArn'),
          'create:LogType': required('LogType'),
          'update-remove:LogType': required('LogType'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::Logs::DeliveryDestination',
    provider: () => new LogsDeliveryDestinationProvider(),
    physicalId: 'dst',
    createOnly: createOnlyOf('AWS::Logs::DeliveryDestination'),
    arm: armNamed('GetDeliveryDestinationCommand', 'deliveryDestination', DEST_ARN),
    exempt: {},
    nestedExempt: {
      'DeliveryDestinationPolicy.DeliveryDestinationName':
        "names the destination itself: the policy is put on this destination's Name, and a block naming another one is refused before any call (logs-delivery-providers.test.ts)",
    },
    targets: tagTargets(DEST_ARN),
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 'dst',
          DestinationResourceArn: GROUP_ARN,
          DeliveryDestinationType: 'CWL',
          OutputFormat: 'json',
          DeliveryDestinationPolicy: {
            DeliveryDestinationPolicy: { Version: '2012-10-17', Statement: [] },
          },
          Tags: TAGS,
        },
        variants: { 'DeliveryDestinationPolicy.DeliveryDestinationPolicy.Version': '2008-10-17' },
        expectedRemovalThrows: {
          'create:Name': required('Name'),
          ...Object.fromEntries(
            ALL_DIRECTIONS.map((d) => [
              `${d}:DeliveryDestinationPolicy.DeliveryDestinationPolicy`,
              {
                why: 'a policy block without its document is refused: there is nothing to attach',
                says: /DeliveryDestinationPolicy must be a policy document/,
              },
            ])
          ),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::Logs::Delivery',
    provider: () => new LogsDeliveryProvider(),
    physicalId: 'abc123',
    createOnly: createOnlyOf('AWS::Logs::Delivery'),
    arm: () =>
      setOutputOverrides({
        CreateDeliveryCommand: () => ({ delivery: { id: 'abc123', arn: DELIVERY_ARN } }),
        GetDeliveryCommand: () => ({ delivery: { id: 'abc123', arn: DELIVERY_ARN } }),
      }),
    exempt: {},
    targets: tagTargets(DELIVERY_ARN),
    bags: [
      {
        name: 'every declared property',
        bag: {
          DeliverySourceName: 'src',
          DeliveryDestinationArn: DEST_ARN,
          RecordFields: ['a', 'b'],
          FieldDelimiter: ',',
          S3SuffixPath: 'p/',
          S3EnableHiveCompatiblePath: true,
          Tags: TAGS,
        },
        variants: { FieldDelimiter: '|' },
        expectedSilent: Object.fromEntries(
          ['RecordFields', 'FieldDelimiter', 'S3SuffixPath', 'S3EnableHiveCompatiblePath'].map(
            (key) => [
              `update-remove:${key}`,
              'UpdateDeliveryConfiguration cannot clear a member: the live value is kept and the update warns',
            ]
          )
        ),
        expectedRemovalThrows: {
          'create:DeliverySourceName': required('DeliverySourceName'),
          'create:DeliveryDestinationArn': required('DeliveryDestinationArn'),
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
        },
      },
    ],
  },
];
