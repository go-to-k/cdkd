import { ACCOUNT, createOnlyOf, setOutputOverrides, type TypeCase } from './sdk-wire-harness.js';
import { ConnectInstanceProvider } from '../../../src/provisioning/providers/connect-instance-provider.js';

/**
 * The Connect instance wire case (go-to-k/cdkd#6912). Run by
 * `sdk-wire-coverage-connect.test.ts`, which mocks the client the provider
 * builds; the ledger in `sdk-wire-coverage.test.ts` counts it as covered.
 * `DescribeInstance` answers ACTIVE, so the create's waits read once.
 */

// Not a gap: a removed Attributes member keeps its live value (warned), since
// the type documents no value to reset it to.
const ATTRIBUTE_KEPT_ON_REMOVAL =
  'a removed Attributes member keeps its live value; the type documents no default to reset it to';
const ATTRIBUTES_REQUIRED = 'Attributes is required by the schema';
const CALLS_REQUIRED = 'the schema requires Attributes.InboundCalls and Attributes.OutboundCalls';
const TYPE_REQUIRED = 'IdentityManagementType is required by the schema';
const TAG_ENTRY_REFUSED = 'a tag without a Key or a Value is refused before any call';

const ARN = `arn:aws:connect:us-east-1:${ACCOUNT}:instance/i-1`;

export const CASES_CONNECT: TypeCase[] = [
  {
    resourceType: 'AWS::Connect::Instance',
    provider: () => {
      const provider = new ConnectInstanceProvider();
      provider.instanceWait = { pollIntervalMs: 0, timeoutMs: 60_000, sleep: async () => {} };
      return provider;
    },
    physicalId: ARN,
    createOnly: createOnlyOf('AWS::Connect::Instance'),
    arm: () =>
      setOutputOverrides({
        CreateInstanceCommand: () => ({ Id: 'i-1', Arn: ARN }),
        DescribeInstanceCommand: () => ({
          Instance: { Id: 'i-1', Arn: ARN, InstanceStatus: 'ACTIVE' },
        }),
      }),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          IdentityManagementType: 'CONNECT_MANAGED',
          InstanceAlias: 'alias-1',
          DirectoryId: 'd-1234567890',
          Attributes: {
            InboundCalls: true,
            OutboundCalls: false,
            ContactflowLogs: true,
            ContactLens: true,
            AutoResolveBestVoices: true,
            UseCustomTTSVoices: false,
            EarlyMedia: true,
            MultiPartyConference: false,
            HighVolumeOutBound: false,
            EnhancedContactMonitoring: true,
            EnhancedChatMonitoring: false,
            MultiPartyChatConference: true,
            MessageStreaming: false,
            AutoMuteAgentOnHold: true,
          },
          Tags: [{ Key: 'k', Value: 'v' }],
        },
        expectedSilent: Object.fromEntries(
          [
            'AutoMuteAgentOnHold',
            'AutoResolveBestVoices',
            'ContactLens',
            'ContactflowLogs',
            'EarlyMedia',
            'EnhancedChatMonitoring',
            'EnhancedContactMonitoring',
            'HighVolumeOutBound',
            'MessageStreaming',
            'MultiPartyChatConference',
            'MultiPartyConference',
            'UseCustomTTSVoices',
          ].map((key) => [`update-remove:Attributes.${key}`, ATTRIBUTE_KEPT_ON_REMOVAL])
        ),
        expectedRemovalThrows: {
          'create:IdentityManagementType': TYPE_REQUIRED,
          ...Object.fromEntries(
            ['create', 'update-add', 'update-remove'].flatMap((d) => [
              [`${d}:Attributes`, ATTRIBUTES_REQUIRED],
              [`${d}:Tags.0.Key`, TAG_ENTRY_REFUSED],
              [`${d}:Tags.0.Value`, TAG_ENTRY_REFUSED],
              [`${d}:Attributes.InboundCalls`, CALLS_REQUIRED],
              [`${d}:Attributes.OutboundCalls`, CALLS_REQUIRED],
            ])
          ),
        },
      },
    ],
  },
];
