import { TAG_THROWS, createOnlyOf, setOutputOverrides, type TypeCase } from './sdk-wire-harness.js';
import { AppConfigEnvironmentProvider } from '../../../src/provisioning/providers/appconfig-environment-provider.js';

/**
 * Wire cases for `AppConfigEnvironmentProvider` (`AWS::AppConfig::Environment`,
 * go-to-k/cdkd#5875). Run by `sdk-wire-coverage-appconfig.test.ts`, which mocks
 * the clients the provider builds; the ledger in `sdk-wire-coverage.test.ts`
 * counts it as covered.
 */

const TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

const ENVIRONMENT_ID = 'env456';
const PHYSICAL_ID = `app123|${ENVIRONMENT_ID}`;

/**
 * `DeletionProtectionCheck` is a parameter of `DeleteEnvironment` and nothing
 * the environment stores, so create and update never send it; only a destroy
 * does (`appconfig-environment-provider.test.ts` pins that call).
 */
/**
 * UpdateEnvironment replaces the whole Monitors list, so `update()` sends the
 * desired list as it stands; only removing the whole property reads the
 * previous one (to send an empty list).
 */
const MONITORS_WHOLE = 'the desired Monitors list is re-sent whole; a member removal reaches the wire through it';

const DELETE_ONLY =
  'a parameter of DeleteEnvironment, stored nowhere: create and update never send it, delete does';

export const CASES_APPCONFIG: TypeCase[] = [
  {
    resourceType: 'AWS::AppConfig::Environment',
    provider: () => new AppConfigEnvironmentProvider(),
    physicalId: PHYSICAL_ID,
    createOnly: createOnlyOf('AWS::AppConfig::Environment'),
    arm: () =>
      setOutputOverrides({
        CreateEnvironmentCommand: () => ({ Id: ENVIRONMENT_ID }),
        GetCallerIdentityCommand: () => ({ Account: '111122223333' }),
      }),
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          ApplicationId: 'app123',
          Name: 'env',
          Description: 'd',
          Monitors: [{ AlarmArn: 'arn:aws:cloudwatch:us-east-1:111122223333:alarm:a', AlarmRoleArn: 'arn:aws:iam::111122223333:role/r' }],
          Tags: TAGS,
          DeletionProtectionCheck: 'BYPASS',
        },
        expectedSilent: {
          'create:DeletionProtectionCheck': DELETE_ONLY,
          'create-vary:DeletionProtectionCheck': DELETE_ONLY,
          'update-remove:Monitors.0': MONITORS_WHOLE,
          'update-remove:Monitors.0.AlarmArn': MONITORS_WHOLE,
          'update-remove:Monitors.0.AlarmRoleArn': MONITORS_WHOLE,
          'update-remove:Name':
            'Name is required by the CloudFormation schema, so no deployable template removes it; update() sends it only when declared',
          'update-add:DeletionProtectionCheck': DELETE_ONLY,
          'update-remove:DeletionProtectionCheck': DELETE_ONLY,
          'update-vary:DeletionProtectionCheck': DELETE_ONLY,
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(ALL_DIRECTIONS, 2),
          'create:ApplicationId': {
            why: 'the schema requires ApplicationId; refused before any call',
            says: /ApplicationId and Name are required/,
          },
          'create:Name': {
            why: 'the schema requires Name; refused before any call',
            says: /ApplicationId and Name are required/,
          },
        },
      },
    ],
  },
];
