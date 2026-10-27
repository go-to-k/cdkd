import { describe, expect, it } from 'vite-plus/test';
import {
  ACCOUNT,
  TAG_THROWS,
  createOnlyOf,
  record,
  setOutputOverrides,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { LambdaWebFunctionEndpointProvider } from '../../../src/provisioning/providers/lambda-web-function-endpoint-provider.js';
import { LambdaWebFunctionRevisionProvider } from '../../../src/provisioning/providers/lambda-web-function-revision-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The batch-8 Lambda MicroVM image and Lambda Web wire cases (#3723): the
 * MicroVM image (`@aws-sdk/client-lambda-microvms`), and the web function
 * endpoint and revision (`@aws-sdk/client-lambda-web`).
 */

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

// --- AWS::Lambda::MicrovmImage ----------------------------------------------------

const IMAGE_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:microvm-image:img`;
const BUILD_ROLE = `arn:aws:iam::${ACCOUNT}:role/build`;
const BASE_IMAGE = `arn:aws:lambda:us-east-1:${ACCOUNT}:microvm-base-image:base`;

/**
 * GetMicrovmImage answers a built image, so the create / update wait
 * (`waitForTerminalState`, lambda-microvm-image-provider.ts:577-614) returns on
 * its first poll.
 */
function armImage(): void {
  setOutputOverrides({ GetMicrovmImageCommand: () => ({ state: 'CREATED' }) });
}

const IMAGE_CREATE_REQUIRED = (key: string): Throw => ({
  why: `${key} is required: create() refuses an image without it before any call (lambda-microvm-image-provider.ts:166-178)`,
  says: /is required for MicroVM image/,
});
const IMAGE_UPDATE_REQUIRED = (key: string): Throw => ({
  why: `${key} is required: an update that changes the build config refuses it before UpdateMicrovmImage (lambda-microvm-image-provider.ts:325-335)`,
  says: /are required to update MicroVM image/,
});

/** The members every build needs, and the removal throws they carry. */
const IMAGE_REQUIRED: Bag = {
  Name: 'img',
  BaseImageArn: BASE_IMAGE,
  BuildRoleArn: BUILD_ROLE,
  CodeArtifact: { Uri: 's3://code-bucket/app.zip' },
};
const IMAGE_REQUIRED_THROWS: Record<string, Throw> = {
  'create:Name': IMAGE_CREATE_REQUIRED('Name'),
  'create:BaseImageArn': IMAGE_CREATE_REQUIRED('BaseImageArn'),
  'create:BuildRoleArn': IMAGE_CREATE_REQUIRED('BuildRoleArn'),
  'create:CodeArtifact': IMAGE_CREATE_REQUIRED('CodeArtifact'),
  'create:CodeArtifact.Uri': IMAGE_CREATE_REQUIRED('CodeArtifact.Uri'),
  'update-remove:BaseImageArn': IMAGE_UPDATE_REQUIRED('BaseImageArn'),
  'update-remove:BuildRoleArn': IMAGE_UPDATE_REQUIRED('BuildRoleArn'),
  'update-remove:CodeArtifact': IMAGE_UPDATE_REQUIRED('CodeArtifact'),
  'update-remove:CodeArtifact.Uri': IMAGE_UPDATE_REQUIRED('CodeArtifact.Uri'),
};

const IMAGE_FULL: Bag = {
  ...IMAGE_REQUIRED,
  BaseImageVersion: '1',
  Description: 'd',
  Logging: { CloudWatch: { LogGroup: 'lg', LogStream: 'ls' } },
  EgressNetworkConnectors: ['conn-1', 'conn-2'],
  CpuConfigurations: [{ Architecture: 'ARM_64' }],
  Resources: [{ MinimumMemoryInMiB: 2048 }],
  AdditionalOsCapabilities: ['ALL'],
  Hooks: {
    Port: 8080,
    MicrovmHooks: {
      Run: 'ENABLED',
      RunTimeoutInSeconds: 10,
      Resume: 'ENABLED',
      ResumeTimeoutInSeconds: 11,
      Suspend: 'ENABLED',
      SuspendTimeoutInSeconds: 12,
      Terminate: 'ENABLED',
      TerminateTimeoutInSeconds: 13,
    },
    MicrovmImageHooks: {
      Ready: 'ENABLED',
      ReadyTimeoutInSeconds: 14,
      Validate: 'ENABLED',
      ValidateTimeoutInSeconds: 15,
    },
  },
  EnvironmentVariables: [
    { Key: 'EA', Value: 'ea' },
    { Key: 'EB', Value: 'eb' },
  ],
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
};

const IMAGE_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::MicrovmImage',
  provider: () => new LambdaMicrovmImageProvider(),
  physicalId: IMAGE_ARN,
  createOnly: createOnlyOf('AWS::Lambda::MicrovmImage'),
  arm: () => armImage(),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    // UpdateMicrovmImage rebuilds from the whole desired config: the removed
    // element must not ride along.
    {
      path: ['EgressNetworkConnectors', 0],
      command: 'UpdateMicrovmImageCommand',
      names: 'conn-2',
      notNames: 'conn-1',
    },
    {
      path: ['EnvironmentVariables', 0],
      command: 'UpdateMicrovmImageCommand',
      names: '"EB":"eb"',
      notNames: '"EA"',
    },
  ],
  bags: [
    {
      name: 'every property, CloudWatch logging',
      bag: IMAGE_FULL,
      expectedRemovalThrows: { ...IMAGE_REQUIRED_THROWS, ...TAG_THROWS(ALL_DIRECTIONS, 2) },
    },
    {
      // `Logging` is a union: `Disabled: true` wins over `CloudWatch`
      // (lambda-microvm-image-provider.ts:825-836), so it rides alone.
      name: 'logging disabled',
      bag: { ...IMAGE_REQUIRED, Logging: { Disabled: true } },
      expectedRemovalThrows: IMAGE_REQUIRED_THROWS,
    },
  ],
};

// --- AWS::Lambda::WebFunctionEndpoint ---------------------------------------------

const WEB_FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:web-function/fn`;
const ENDPOINT_ARN = `${WEB_FN_ARN}/endpoint/ep`;

/**
 * GetWebFunctionEndpoint answers a settled endpoint reporting the weights the
 * last UpdateWebFunctionEndpoint sent, so the update wait (`waitForSettled`,
 * lambda-web-function-endpoint-provider.ts:544-614, which compares the sent
 * weights with the read) returns on its first poll.
 */
function armEndpoint(): void {
  let sentWeights: unknown;
  setOutputOverrides({
    UpdateWebFunctionEndpointCommand: (input) => {
      sentWeights = input['revisionWeights'];
      return {};
    },
    GetWebFunctionEndpointCommand: () => ({
      state: 'Active',
      updateStatus: 'Successful',
      ...(sentWeights !== undefined && { revisionWeights: sentWeights }),
    }),
  });
}

const ENDPOINT_CREATE_REQUIRED: Throw = {
  why: 'a required string member: create() refuses an endpoint without it before any call (lambda-web-function-endpoint-provider.ts:128-139)',
  says: /must be a non-empty string/,
};
const WEIGHTS_REQUIRED: Throw = {
  why: 'update() refuses a template without RevisionWeights: AWS keeps routing to the current revisions when they are not sent (lambda-web-function-endpoint-provider.ts:260-272)',
  says: /RevisionWeights is required/,
};
const WEIGHT_MEMBER_REFUSED: Throw = {
  why: 'a RevisionWeights entry without its RevisionId or Weight is refused on every path before any call: it decides where traffic goes (lambda-web-function-endpoint-provider.ts:708-722)',
  says: /RevisionWeights\[\d\]\.(RevisionId must be a string|Weight must be an integer)/,
};

const ENDPOINT_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::WebFunctionEndpoint',
  provider: () => new LambdaWebFunctionEndpointProvider(),
  physicalId: ENDPOINT_ARN,
  createOnly: createOnlyOf('AWS::Lambda::WebFunctionEndpoint'),
  arm: () => armEndpoint(),
  // Not a gap: update() never reads previousProperties
  // (lambda-web-function-endpoint-provider.ts:223) and sends the whole desired
  // config, an absent optional member sent cleared (:249-296). With `prev`
  // unread, the update-remove probe cannot tell a clear from a member left
  // live: the clears themselves are pinned in
  // lambda-web-function-providers.test.ts (Description '' and the omitted
  // ScalingConfig). AuthType is NOT cleared (:256-257) and is listed on its own.
  wholeFromNext: {
    keys: (key) => key !== 'AuthType',
    reason:
      'update() never reads previousProperties and sends the whole desired config, an absent optional member cleared (lambda-web-function-endpoint-provider.ts:223, 249-296; clears pinned in lambda-web-function-providers.test.ts)',
  },
  exempt: {},
  targets: [
    {
      path: ['RevisionWeights', 0],
      command: 'UpdateWebFunctionEndpointCommand',
      names: 'rev-b',
      notNames: 'rev-a',
    },
  ],
  bags: [
    {
      name: 'every property',
      bag: {
        FunctionName: 'fn',
        EndpointName: 'ep',
        Description: 'd',
        EndpointType: 'MultiRegion',
        AuthType: 'IamAuth',
        RevisionWeights: [
          { RevisionId: 'rev-a', Weight: 60 },
          { RevisionId: 'rev-b', Weight: 40 },
        ],
        Regions: ['us-east-1', 'us-west-2'],
        ScalingConfig: { MaxEnvironments: 5 },
        ThrottleConfig: { RateLimit: 100 },
      },
      expectedSilent: {
        // Not a deployable template: create() refuses a missing AuthType
        // (lambda-web-function-endpoint-provider.ts:131-139), and update()
        // sends it only when declared (:256-257), so a removal keeps the live
        // value rather than clearing it.
        'update-remove:AuthType':
          'AuthType is required by create (:131-139); update() sends it only when declared (:256-257), so a removal keeps the live value',
      },
      expectedRemovalThrows: {
        'create:FunctionName': ENDPOINT_CREATE_REQUIRED,
        'create:EndpointName': ENDPOINT_CREATE_REQUIRED,
        'create:EndpointType': ENDPOINT_CREATE_REQUIRED,
        'create:AuthType': ENDPOINT_CREATE_REQUIRED,
        'update-add:RevisionWeights': WEIGHTS_REQUIRED,
        'update-remove:RevisionWeights': WEIGHTS_REQUIRED,
        ...Object.fromEntries(
          ALL_DIRECTIONS.flatMap((d) =>
            [0, 1].flatMap((i) => [
              [`${d}:RevisionWeights.${i}.RevisionId`, WEIGHT_MEMBER_REFUSED],
              [`${d}:RevisionWeights.${i}.Weight`, WEIGHT_MEMBER_REFUSED],
            ])
          )
        ),
      },
    },
  ],
};

// --- AWS::Lambda::WebFunctionRevision ---------------------------------------------

const REVISION_ARN = `${WEB_FN_ARN}/revision/rev-1`;

/**
 * The revision's `update()` always refuses (an immutable resource with no
 * update API, lambda-web-function-revision-provider.ts:300-325), and every
 * handled property is create-only, so the engine replaces on any change and
 * the bag probes skip every update comparison. Only the harness's no-op
 * `settled` update would reach it: the case's provider answers that one in
 * place, and `describeLambdawebExtras` pins the real refusal, with nothing on
 * the wire.
 */
function revisionProvider(): ResourceProvider {
  const real = new LambdaWebFunctionRevisionProvider();
  return Object.assign(Object.create(real) as ResourceProvider, {
    update: async (_logicalId: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
    }),
  });
}

/** GetWebFunctionRevision answers an active revision: `waitForActive` returns on its first poll. */
function armRevision(): void {
  setOutputOverrides({ GetWebFunctionRevisionCommand: () => ({ state: 'Active' }) });
}

const REVISION_REFUSED = (member: string, says: RegExp): Throw => ({
  why: `${member} is required: create() refuses a revision without it before any call (lambda-web-function-revision-provider.ts:489-507)`,
  says,
});
const S3_OBJECT_REQUIRED = REVISION_REFUSED(
  'BuildConfig.CodeConfig.S3Object.Bucket / .Key',
  /S3Object\.Bucket and \.Key are required strings/
);
const RUNTIME_REQUIRED = REVISION_REFUSED(
  'BuildConfig.RuntimeConfig.Runtime',
  /RuntimeConfig\.Runtime is a required string/
);
const ROLE_REQUIRED = REVISION_REFUSED(
  'ServiceConfig.ExecutionRoleArn',
  /ServiceConfig\.ExecutionRoleArn is a required string/
);

const REVISION_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::WebFunctionRevision',
  provider: revisionProvider,
  physicalId: REVISION_ARN,
  createOnly: createOnlyOf('AWS::Lambda::WebFunctionRevision'),
  arm: () => armRevision(),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'every property',
      bag: {
        FunctionName: 'fn',
        Description: 'd',
        KmsKeyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`,
        BuildConfig: {
          CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip', VersionId: 'v1' } },
          RuntimeConfig: { Runtime: 'nodejs22.x' },
        },
        ServiceConfig: {
          ExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/exec`,
          TimeoutSeconds: 30,
          MaxConcurrencyPerEnvironment: 8,
          EgressNetworkConnectorArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:egress-network-connector:enc`,
          EnvironmentVariables: { A: '1', B: '2' },
          TelemetryConfig: {
            LoggingConfig: { ApplicationLogLevel: 'INFO', LogGroup: 'lg', SystemLogLevel: 'WARN' },
          },
        },
      },
      expectedRemovalThrows: {
        'create:FunctionName': REVISION_REFUSED(
          'FunctionName',
          /FunctionName must be a non-empty string/
        ),
        'create:BuildConfig': REVISION_REFUSED('BuildConfig', /BuildConfig must be an object/),
        'create:BuildConfig.CodeConfig': S3_OBJECT_REQUIRED,
        'create:BuildConfig.CodeConfig.S3Object': S3_OBJECT_REQUIRED,
        'create:BuildConfig.CodeConfig.S3Object.Bucket': S3_OBJECT_REQUIRED,
        'create:BuildConfig.CodeConfig.S3Object.Key': S3_OBJECT_REQUIRED,
        'create:BuildConfig.RuntimeConfig': RUNTIME_REQUIRED,
        'create:BuildConfig.RuntimeConfig.Runtime': RUNTIME_REQUIRED,
        'create:ServiceConfig': ROLE_REQUIRED,
        'create:ServiceConfig.ExecutionRoleArn': ROLE_REQUIRED,
      },
    },
  ],
};

export const LAMBDAWEB_CASES: TypeCase[] = [IMAGE_CASE, ENDPOINT_CASE, REVISION_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeLambdawebExtras(): void {
  describe('AWS::Lambda::WebFunctionRevision update', () => {
    it('refuses an in-place update and sends nothing', async () => {
      const bag = REVISION_CASE.bags[0]!.bag;
      let thrown: unknown;
      const outcome = await record(async () => {
        try {
          await new LambdaWebFunctionRevisionProvider().update(
            'L',
            REVISION_ARN,
            'AWS::Lambda::WebFunctionRevision',
            { ...bag, Description: 'd2' },
            bag
          );
        } catch (error) {
          thrown = error;
        }
      });
      expect(outcome).toEqual({ threw: false, wire: '' });
      expect(thrown).toBeInstanceOf(ResourceUpdateNotSupportedError);
    });
  });
}
