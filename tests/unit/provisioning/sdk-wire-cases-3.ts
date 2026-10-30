import AdmZip from 'adm-zip';
import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  setOutputOverrides,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import { DLMLifecyclePolicyProvider } from '../../../src/provisioning/providers/dlm-lifecycle-policy-provider.js';
import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';

/**
 * The third batch of wire cases (#3723): IAM instance profile / managed
 * policy / inline policy / access key, Budgets budget, CodeCommit repository,
 * DLM lifecycle policy and EventBridge Scheduler schedule. Run by
 * `sdk-wire-coverage-3.test.ts`, which mocks the clients these providers
 * reach; the ledger in `sdk-wire-coverage.test.ts` counts them as covered.
 */

const DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:t`;
const QUEUE = (name: string) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;
const KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k`;
const TWO_TAGS = [
  { Key: 'k1', Value: 'v1' },
  { Key: 'k2', Value: 'v2' },
];

/** `<Property> is required for ...`: refused when absent, before any call. */
const REQUIRED = (property: string, says = `${property} is required for`): Throw => ({
  why: `${property} is refused when absent, before any call`,
  says: new RegExp(says),
});

/**
 * The repository's `Code` seed: `GetObject` answers a zip whose one file
 * names the object it was read as, so a removed `ObjectVersion` (or a changed
 * Bucket / Key) changes the seed commit's `putFiles`, which is on the wire.
 */
function armSeedObject(): void {
  setOutputOverrides({
    GetObjectCommand: (input) => {
      const zip = new AdmZip();
      zip.addFile('seed.txt', Buffer.from(JSON.stringify(input)));
      const bytes = new Uint8Array(zip.toBuffer());
      return { Body: { transformToByteArray: async () => bytes } };
    },
  });
}

const BUDGET_ENTRY_REFUSED: Throw = {
  why: 'a NotificationsWithSubscribers entry missing a required member is refused before any call',
  says: /is not a list of entries with a Notification/,
};
const BUDGET_TAG_REFUSED: Throw = {
  why: 'a ResourceTags entry without its Key is refused before any call (go-to-k/cdkd#3989)',
  says: /ResourceTags of budget L is not a list of tags/,
};
/** The Budget refusals; with `full`, those of the notification and tag lists too. */
const BUDGET_THROWS = (full: boolean): Record<string, Throw> => ({
  // Only on create: removing `Budget` removes its create-only `BudgetName`, a
  // replacement, so no update probe removes it.
  'create:Budget': REQUIRED('Budget', 'The Budget property is required for'),
  ...(full
    ? {
        ...Object.fromEntries(
          [
            'Notification',
            'Notification.ComparisonOperator',
            'Notification.NotificationType',
            'Notification.Threshold',
            'Subscribers.0.Address',
            'Subscribers.0.SubscriptionType',
          ].map((p) => [`create:NotificationsWithSubscribers.0.${p}`, BUDGET_ENTRY_REFUSED])
        ),
        ...Object.fromEntries(
          ['create', 'update-add', 'update-remove'].flatMap((d) =>
            [0, 1].map((i) => [`${d}:ResourceTags.${i}.Key`, BUDGET_TAG_REFUSED])
          )
        ),
      }
    : {}),
});

const REPO_TAG_REFUSED: Throw = {
  why: 'a Tags entry without its Key is refused before any call (go-to-k/cdkd#3989)',
  says: /Tags of CodeCommit Repository L is not a list of tags/,
};
const REPO_TRIGGER_REFUSED: Throw = {
  why: 'a Triggers entry without its Name or DestinationArn is refused before any call',
  says: /Triggers of CodeCommit Repository L is not a list of triggers/,
};
const SEED_REFUSED: Throw = {
  why: 'a Code.S3 without its Bucket or Key fails the seed, and the new repository is deleted',
  says: /Code\.S3 requires string Bucket and Key/,
};
// Not a gap: CloudFormation ignores `Code` on update, and so does update().
const CODE_CREATE_ONLY = 'the seed commit is made on create only; update() ignores Code, as CFn does';

const DEFAULT_POLICY_REFUSED: Throw = {
  why: 'UpdateLifecyclePolicy has no DefaultPolicy: any change is refused in place (a replacement)',
  says: /DefaultPolicy cannot be changed in place/,
};

const GROUP_MOVE_REFUSED: Throw = {
  why: 'GroupName addresses the schedule: any change is refused in place (a replacement)',
  says: /GroupName addresses the schedule/,
};
// Target is schema-required, so CloudFormation rejects a template without
// it first. Its absence fails in the Target conversion, before any write, as
// a TypeError rather than a named refusal. PROVISIONAL: this needle pins a
// crash, not a refusal; replace it when the provider names the property.
const TARGET_ABSENT: Throw = {
  why: 'a schema-required Target that is absent fails before any write',
  says: /reading 'EcsParameters'/,
};

/** A DLM tag Key / Value removal: refused before any call (go-to-k/cdkd#3994). */
const DLM_TAG_THROWS = TAG_THROWS(['create', 'update-add', 'update-remove'], 2);

export const CASES_3: TypeCase[] = [
  {
    resourceType: 'AWS::IAM::InstanceProfile',
    provider: () => new IAMInstanceProfileProvider(),
    physicalId: 'ip',
    createOnly: createOnlyOf('AWS::IAM::InstanceProfile'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { InstanceProfileName: 'ip', Path: '/p/', Roles: ['r1'] },
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::ManagedPolicy',
    provider: () => new IAMManagedPolicyProvider(),
    physicalId: `arn:aws:iam::${ACCOUNT}:policy/p/mp`,
    createOnly: createOnlyOf('AWS::IAM::ManagedPolicy'),
    exempt: {},
    targets: [
      { path: ['Groups', 0], command: 'DetachGroupPolicyCommand', names: 'g1', notNames: 'g2' },
      { path: ['Roles', 1], command: 'DetachRolePolicyCommand', names: 'r2', notNames: 'r1' },
      { path: ['Users', 0], command: 'DetachUserPolicyCommand', names: 'u1', notNames: 'u2' },
      { path: ['Tags', 0], command: 'UntagPolicyCommand', names: 'k1', notNames: 'k2' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          ManagedPolicyName: 'mp',
          Description: 'd',
          Path: '/p/',
          PolicyDocument: DOC,
          Groups: ['g1', 'g2'],
          Roles: ['r1', 'r2'],
          Users: ['u1', 'u2'],
          Tags: TWO_TAGS,
        },
        expectedSilent: {
          // Not a gap: PolicyDocument is schema-required, so a template
          // without it is not one CloudFormation accepts; create() refuses it
          // (below), and update() leaves the live default version alone.
          'update-remove:PolicyDocument':
            'a required property: update() keeps the live default version rather than creating an empty one',
        },
        expectedRemovalThrows: {
          'create:PolicyDocument': REQUIRED('PolicyDocument'),
          ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::Policy',
    provider: () => new IAMPolicyProvider(),
    physicalId: 'pol',
    createOnly: createOnlyOf('AWS::IAM::Policy'),
    // Put{Role,Group,User}Policy replaces the whole document.
    wholeFromNext: {
      keys: (k) => k === 'PolicyDocument',
      reason: 'Put*Policy replaces the whole document from next; prev is not read',
    },
    exempt: {},
    targets: [
      { path: ['Groups', 0], command: 'DeleteGroupPolicyCommand', names: 'g1', notNames: 'g2' },
      { path: ['Roles', 1], command: 'DeleteRolePolicyCommand', names: 'r2', notNames: 'r1' },
      { path: ['Users', 0], command: 'DeleteUserPolicyCommand', names: 'u1', notNames: 'u2' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          PolicyName: 'pol',
          PolicyDocument: DOC,
          Groups: ['g1', 'g2'],
          Roles: ['r1', 'r2'],
          Users: ['u1', 'u2'],
        },
        expectedSilent: {
          // Not a gap: the name the principals hold the policy under is read
          // from the physical id (here the recorded PolicyName itself), so
          // dropping the recorded copy renames from the same name.
          'update-remove:PolicyName':
            'the old name is read from the physical id, which is the recorded PolicyName',
        },
        expectedRemovalThrows: Object.fromEntries(
          ['create', 'update-add', 'update-remove'].map((d) => [
            `${d}:PolicyDocument`,
            REQUIRED('PolicyDocument'),
          ])
        ),
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::AccessKey',
    provider: () => new IAMAccessKeyProvider(),
    physicalId: 'AKIAFAKE',
    createOnly: createOnlyOf('AWS::IAM::AccessKey'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { UserName: 'u', Serial: 1, Status: 'Inactive' },
        expectedSilent: {
          // Not a gap: Serial is create-only, so a change replaces the key,
          // and no IAM API takes the integer itself.
          'create:Serial': 'a replacement trigger with no API counterpart; never sent',
          'create-vary:Serial': 'a replacement trigger with no API counterpart; never sent',
          // An absent Status resets to CloudFormation's default `Active`
          // from next alone, so the recorded value changes nothing.
          'update-remove:Status': 'an absent Status is reset to Active from next; prev is not read',
        },
        expectedRemovalThrows: {
          'create:UserName': REQUIRED('UserName', 'requires UserName'),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::Budgets::Budget',
    provider: () => new BudgetsBudgetProvider(),
    physicalId: 'b',
    createOnly: createOnlyOf('AWS::Budgets::Budget'),
    // UpdateBudget sends `NewBudget` whole from next.
    wholeFromNext: {
      keys: (k) => k === 'Budget',
      reason: 'UpdateBudget sends NewBudget whole from next; prev is not read',
    },
    exempt: {},
    targets: [
      { path: ['ResourceTags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    ],
    bags: [
      {
        name: 'a fixed limit, legacy filters',
        bag: {
          Budget: {
            BudgetName: 'b',
            BudgetType: 'COST',
            TimeUnit: 'MONTHLY',
            BudgetLimit: { Amount: 100, Unit: 'USD' },
            BillingViewArn: `arn:aws:billing::${ACCOUNT}:billingview/primary`,
            CostFilters: { Region: ['us-east-1'] },
            CostTypes: {
              IncludeCredit: true,
              IncludeDiscount: true,
              IncludeOtherSubscription: true,
              IncludeRecurring: true,
              IncludeRefund: true,
              IncludeSubscription: true,
              IncludeSupport: true,
              IncludeTax: true,
              IncludeUpfront: true,
              UseAmortized: true,
              UseBlended: true,
            },
            TimePeriod: { Start: '2030-01-01T00:00:00Z', End: '2031-01-01T00:00:00Z' },
            AutoAdjustData: {
              AutoAdjustType: 'HISTORICAL',
              HistoricalOptions: { BudgetAdjustmentPeriod: 3 },
            },
          },
          NotificationsWithSubscribers: [
            {
              Notification: {
                ComparisonOperator: 'GREATER_THAN',
                NotificationType: 'ACTUAL',
                Threshold: 80,
                ThresholdType: 'PERCENTAGE',
              },
              Subscribers: [{ Address: 'a@example.com', SubscriptionType: 'EMAIL' }],
            },
          ],
          ResourceTags: TWO_TAGS,
        },
        // A varied date must still be a date: `-alt` would be refused.
        variants: {
          'Budget.TimePeriod.Start': '2030-02-01T00:00:00Z',
          'Budget.TimePeriod.End': '2031-02-01T00:00:00Z',
        },
        expectedRemovalThrows: BUDGET_THROWS(true),
      },
      {
        name: 'planned limits, a filter expression',
        bag: {
          Budget: {
            BudgetName: 'b',
            BudgetType: 'COST',
            TimeUnit: 'MONTHLY',
            PlannedBudgetLimits: { '1893456000': { Amount: 100, Unit: 'USD' } },
            Metrics: ['UnblendedCost'],
            FilterExpression: {
              Dimensions: { Key: 'SERVICE', Values: ['s1'], MatchOptions: ['EQUALS'] },
              Tags: { Key: 't', Values: ['tv'], MatchOptions: ['EQUALS'] },
              CostCategories: { Key: 'cc', Values: ['cv'], MatchOptions: ['EQUALS'] },
              And: [{ Dimensions: { Key: 'REGION', Values: ['us-east-1'] } }],
              Or: [{ Dimensions: { Key: 'REGION', Values: ['us-west-2'] } }],
              Not: { Dimensions: { Key: 'REGION', Values: ['eu-west-1'] } },
            },
          },
        },
        expectedRemovalThrows: BUDGET_THROWS(false),
      },
    ],
  },
  {
    resourceType: 'AWS::CodeCommit::Repository',
    provider: () => new CodeCommitRepositoryProvider(),
    physicalId: 'repo',
    createOnly: createOnlyOf('AWS::CodeCommit::Repository'),
    arm: armSeedObject,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    ],
    bags: [
      {
        name: 'every declared property',
        bag: {
          RepositoryName: 'repo',
          RepositoryDescription: 'd',
          KmsKeyId: 'alias/k',
          Tags: TWO_TAGS,
          Code: { BranchName: 'dev', S3: { Bucket: 'b', Key: 'k.zip', ObjectVersion: 'v1' } },
          Triggers: [
            {
              Name: 't',
              DestinationArn: TOPIC,
              Events: ['all'],
              Branches: ['main'],
              CustomData: 'c',
            },
          ],
        },
        expectedSilent: {
          ...Object.fromEntries(
            ['update-add', 'update-remove']
              .flatMap((d) =>
                ['', '.BranchName', '.S3', '.S3.Bucket', '.S3.Key', '.S3.ObjectVersion'].map(
                  (p) => `${d}:Code${p}`
                )
              )
              .concat(
                ['BranchName', 'S3.Bucket', 'S3.Key', 'S3.ObjectVersion'].map(
                  (p) => `update-vary:Code.${p}`
                )
              )
              .map((label) => [label, CODE_CREATE_ONLY])
          ),
          // Not a gap: the update addresses the repository by its physical
          // id. The declared name IS that id (no rename), and a removed one
          // (schema-required, so not a template CFn accepts) renames nothing.
          ...Object.fromEntries(
            ['update-add', 'update-remove'].map((d) => [
              `${d}:RepositoryName`,
              'the physical id is the deployed name; only a different declared name renames',
            ])
          ),
        },
        expectedRemovalThrows: {
          ...Object.fromEntries(
            ['create', 'update-add', 'update-remove'].flatMap((d) => [
              ...[0, 1].map((i) => [`${d}:Tags.${i}.Key`, REPO_TAG_REFUSED]),
              ...['Name', 'DestinationArn'].map((p) => [
                `${d}:Triggers.0.${p}`,
                REPO_TRIGGER_REFUSED,
              ]),
            ])
          ),
          ...Object.fromEntries(
            ['', '.Bucket', '.Key'].map((p) => [`create:Code.S3${p}`, SEED_REFUSED])
          ),
        },
      },
    ],
  },
  {
    resourceType: 'AWS::DLM::LifecyclePolicy',
    provider: () => new DLMLifecyclePolicyProvider(),
    physicalId: 'policy-1',
    createOnly: createOnlyOf('AWS::DLM::LifecyclePolicy'),
    // UpdateLifecyclePolicy sends only what next declares: a removed
    // top-level is left as it is live, which a CloudFormation A/B showed is
    // what CFn does too (#5004 for the shorthand fields, #5546 for
    // Description, ExecutionRoleArn, State and PolicyDetails; `update()`
    // names each kept removal in a warning), and a declared PolicyDetails / Exclusions is
    // replaced whole. Tags are diffed against prev (Untag on removal).
    wholeFromNext: {
      keys: (k) => k !== 'Tags',
      reason: 'sent from next only; a removed member is kept live, as CloudFormation keeps it',
    },
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    ],
    bags: [
      {
        name: 'a custom policy',
        bag: {
          Description: 'd',
          ExecutionRoleArn: ROLE,
          State: 'ENABLED',
          PolicyDetails: {
            PolicyLanguage: 'STANDARD',
            PolicyType: 'EBS_SNAPSHOT_MANAGEMENT',
            ResourceType: 'VOLUME',
            ResourceTypes: ['VOLUME'],
            ResourceLocations: ['CLOUD'],
            TargetTags: [{ Key: 'tk', Value: 'tv' }],
            Parameters: {
              ExcludeBootVolume: true,
              NoReboot: true,
              ExcludeDataVolumeTags: [{ Key: 'xk', Value: 'xv' }],
            },
            CopyTags: true,
            CreateInterval: 2,
            RetainInterval: 9,
            ExtendDeletion: true,
            CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
            Exclusions: {
              ExcludeBootVolumes: true,
              ExcludeVolumeTypes: ['gp2'],
              ExcludeTags: [{ Key: 'ek', Value: 'ev' }],
            },
            EventSource: {
              Type: 'MANAGED_CWE',
              Parameters: {
                EventType: 'shareSnapshot',
                SnapshotOwner: ['111111111111'],
                DescriptionRegex: '^.*$',
              },
            },
            Actions: [
              {
                Name: 'copy',
                CrossRegionCopy: [
                  {
                    Target: 'us-west-2',
                    EncryptionConfiguration: { Encrypted: true, CmkArn: KEY },
                    RetainRule: { Interval: 2, IntervalUnit: 'DAYS' },
                  },
                ],
              },
            ],
            Schedules: [
              {
                Name: 's',
                CopyTags: true,
                CreateRule: {
                  CronExpression: 'cron(0 9 * * ? *)',
                  Interval: 12,
                  IntervalUnit: 'HOURS',
                  Location: 'CLOUD',
                  Times: ['09:00'],
                  Scripts: [
                    {
                      ExecuteOperationOnScriptFailure: true,
                      ExecutionHandler: 'AWS_VSS_BACKUP',
                      ExecutionHandlerService: 'AWS_SYSTEMS_MANAGER',
                      ExecutionTimeout: 60,
                      MaximumRetryCount: 1,
                      Stages: ['PRE'],
                    },
                  ],
                },
                RetainRule: { Count: 3, Interval: 4, IntervalUnit: 'DAYS' },
                DeprecateRule: { Count: 2, Interval: 5, IntervalUnit: 'DAYS' },
                ArchiveRule: {
                  RetainRule: {
                    RetentionArchiveTier: { Count: 1, Interval: 6, IntervalUnit: 'MONTHS' },
                  },
                },
                FastRestoreRule: {
                  AvailabilityZoneIds: ['use1-az1'],
                  AvailabilityZones: ['us-east-1a'],
                  Count: 1,
                  Interval: 7,
                  IntervalUnit: 'DAYS',
                },
                CrossRegionCopyRules: [
                  {
                    CmkArn: KEY,
                    CopyTags: true,
                    Encrypted: true,
                    Target: 'arn:aws:s3:::b',
                    TargetRegion: 'us-west-2',
                    RetainRule: { Interval: 8, IntervalUnit: 'DAYS' },
                    DeprecateRule: { Interval: 9, IntervalUnit: 'DAYS' },
                  },
                ],
                ShareRules: [
                  {
                    TargetAccounts: ['222222222222'],
                    UnshareInterval: 10,
                    UnshareIntervalUnit: 'DAYS',
                  },
                ],
                TagsToAdd: [{ Key: 'ak', Value: 'av' }],
                VariableTags: [{ Key: 'vk', Value: '$(instance-id)' }],
              },
            ],
          },
          Tags: TWO_TAGS,
        },
        expectedRemovalThrows: DLM_TAG_THROWS,
      },
      {
        name: 'a default policy',
        bag: {
          Description: 'd',
          ExecutionRoleArn: ROLE,
          State: 'ENABLED',
          DefaultPolicy: 'VOLUME',
          CopyTags: true,
          CreateInterval: 2,
          RetainInterval: 9,
          ExtendDeletion: true,
          CrossRegionCopyTargets: [{ TargetRegion: 'us-west-2' }],
          Exclusions: {
            ExcludeBootVolumes: true,
            ExcludeVolumeTypes: ['gp2'],
            ExcludeTags: [{ Key: 'ek', Value: 'ev' }],
          },
        },
        expectedSilent: {
          'update-vary:DefaultPolicy': DEFAULT_POLICY_REFUSED.why,
        },
        expectedRemovalThrows: {
          'update-add:DefaultPolicy': DEFAULT_POLICY_REFUSED,
          'update-remove:DefaultPolicy': DEFAULT_POLICY_REFUSED,
        },
      },
    ],
  },
  {
    resourceType: 'AWS::Scheduler::Schedule',
    provider: () => new SchedulerScheduleProvider(),
    physicalId: 's',
    createOnly: createOnlyOf('AWS::Scheduler::Schedule'),
    // UpdateSchedule is a full replace: update() sends the whole desired
    // configuration from next, and a member next omits is reset by AWS.
    wholeFromNext: {
      keys: () => true,
      reason: 'UpdateSchedule replaces the whole schedule from next; prev is not read',
    },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          Name: 's',
          GroupName: 'grp',
          Description: 'd',
          ScheduleExpression: 'rate(5 minutes)',
          ScheduleExpressionTimezone: 'Asia/Tokyo',
          StartDate: '2030-01-01T00:00:00Z',
          EndDate: '2031-01-01T00:00:00Z',
          State: 'ENABLED',
          KmsKeyArn: KEY,
          FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 5 },
          Target: {
            Arn: QUEUE('q'),
            RoleArn: ROLE,
            Input: '{}',
            RetryPolicy: { MaximumEventAgeInSeconds: 60, MaximumRetryAttempts: 1 },
            DeadLetterConfig: { Arn: QUEUE('dlq') },
            SqsParameters: { MessageGroupId: 'm' },
            KinesisParameters: { PartitionKey: 'pk' },
            EventBridgeParameters: { DetailType: 'dt', Source: 'src' },
            SageMakerPipelineParameters: {
              PipelineParameterList: [{ Name: 'pn', Value: 'pv' }],
            },
            EcsParameters: {
              TaskDefinitionArn: `arn:aws:ecs:us-east-1:${ACCOUNT}:task-definition/td:1`,
              TaskCount: 2,
              LaunchType: 'FARGATE',
              PlatformVersion: 'LATEST',
              Group: 'g',
              EnableECSManagedTags: true,
              EnableExecuteCommand: true,
              PropagateTags: 'TASK_DEFINITION',
              ReferenceId: 'ref',
              Tags: [{ tk: 'tv' }],
              NetworkConfiguration: {
                AwsvpcConfiguration: {
                  AssignPublicIp: 'ENABLED',
                  SecurityGroups: ['sg-1'],
                  Subnets: ['subnet-1'],
                },
              },
              CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1, Base: 1 }],
              PlacementConstraints: [{ Type: 'memberOf', Expression: 'attribute:x == y' }],
              PlacementStrategy: [{ Type: 'spread', Field: 'attribute:az' }],
            },
          },
        },
        expectedSilent: { 'update-vary:GroupName': GROUP_MOVE_REFUSED.why },
        expectedRemovalThrows: {
          'update-add:GroupName': GROUP_MOVE_REFUSED,
          'update-remove:GroupName': GROUP_MOVE_REFUSED,
          ...Object.fromEntries(
            ['create', 'update-add', 'update-remove'].map((d) => [`${d}:Target`, TARGET_ABSENT])
          ),
        },
      },
    ],
  },
];
