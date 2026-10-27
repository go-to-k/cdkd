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
import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { LambdaLayerVersionProvider } from '../../../src/provisioning/providers/lambda-layer-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

/**
 * The batch-7 Lambda wire cases (#3723): the function and the layer version.
 * Both pin go-to-k/cdkd#5305: `Code.S3ObjectStorageMode` / `Code.SourceKMSKeyArn`
 * reach CreateFunction AND UpdateFunctionCode (the update-vary probes read the
 * value on the code call), and `Content.S3ObjectStorageMode` reaches
 * PublishLayerVersion.
 *
 * `Code.ZipFile` is zipped with the current time in its header, so the suite
 * running these cases freezes `Date` around these cases alone (`sdk-wire-coverage-7.test.ts`), so the
 * determinism guard still sees a wall-clock value in the other batch-7 cases.
 */

const FN = 'fn';
const FN_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${FN}`;
const ROLE = `arn:aws:iam::${ACCOUNT}:role/r`;
const KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/k1`;

const ALL_DIRECTIONS = ['create', 'update-add', 'update-remove'];

/**
 * GetFunction answers a settled, active function: the update waiter
 * (`waitUntilFunctionUpdatedV2`) polls `LastUpdateStatus`, the create-path
 * RuntimeManagementConfig wait (`waitUntilFunctionActiveV2`) polls `State`,
 * and the tag diff reads the ARN.
 */
function armFunction(): void {
  setOutputOverrides({
    GetFunctionCommand: () => ({
      Configuration: {
        FunctionName: FN,
        FunctionArn: FN_ARN,
        LastUpdateStatus: 'Successful',
        State: 'Active',
      },
    }),
  });
}

const CODE_REQUIRED: Throw = {
  why: 'Code is required: create() refuses a function without it before any call',
  says: /Code is required/,
};
const ROLE_REQUIRED: Throw = {
  why: 'Role is required: create() refuses a function without it before any call',
  says: /Role is required/,
};

// Not a gap: Code is required by CloudFormation, so a template cannot remove
// it; update() redeploys code only from a present next Code
// (lambda-function-provider.ts:1449-1452) and lists Code in
// removalHandledInUpdate as required (lambda-function-provider.ts:618-619).
const CODE_REQUIRED_ON_UPDATE =
  'Code is required by CloudFormation, so its removal is not a template transition; update() redeploys only a present next Code (lambda-function-provider.ts:618-619, 1449-1452)';

/** Every zip-package property, the code an S3 object (#5305's members included). */
const FUNCTION_FULL: Bag = {
  FunctionName: FN,
  Code: {
    S3Bucket: 'code-bucket',
    S3Key: 'code.zip',
    S3ObjectVersion: 'v1',
    // Not the Lambda default COPY, so dropping it would deploy another mode.
    S3ObjectStorageMode: 'REFERENCE',
    SourceKMSKeyArn: KEY,
  },
  Role: ROLE,
  Handler: 'index.handler',
  Runtime: 'nodejs20.x',
  Timeout: 30,
  MemorySize: 256,
  Description: 'd',
  Environment: { Variables: { A: '1', B: '2' } },
  Layers: [
    `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:l1:1`,
    `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:l2:1`,
  ],
  Architectures: ['arm64'],
  PackageType: 'Zip',
  TracingConfig: { Mode: 'Active' },
  EphemeralStorage: { Size: 1024 },
  VpcConfig: {
    SubnetIds: ['subnet-1', 'subnet-2'],
    SecurityGroupIds: ['sg-1', 'sg-2'],
    Ipv6AllowedForDualStack: true,
  },
  DeadLetterConfig: { TargetArn: `arn:aws:sqs:us-east-1:${ACCOUNT}:dlq` },
  KmsKeyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k2`,
  FileSystemConfigs: [
    {
      Arn: `arn:aws:elasticfilesystem:us-east-1:${ACCOUNT}:access-point/fsap-1`,
      LocalMountPath: '/mnt/a',
      S3FilesConfig: { DirectS3Read: true },
    },
  ],
  SnapStart: { ApplyOn: 'PublishedVersions' },
  LoggingConfig: {
    ApplicationLogLevel: 'INFO',
    LogFormat: 'JSON',
    LogGroup: 'lg',
    SystemLogLevel: 'WARN',
  },
  // Not the default Terminate.
  RecursiveLoop: 'Allow',
  ReservedConcurrentExecutions: 5,
  CodeSigningConfigArn: `arn:aws:lambda:us-east-1:${ACCOUNT}:code-signing-config:csc-1`,
  RuntimeManagementConfig: {
    UpdateRuntimeOn: 'Manual',
    RuntimeVersionArn: `arn:aws:lambda:us-east-1::runtime:abc`,
  },
  // Adding or removing the whole block replaces the function
  // (`durableConfigPresenceToggled`, replacement-rules.ts), so its top-level
  // update-add / update-remove probes model a transition the engine never
  // routes to update(); it stays out of createOnly, which would skip the
  // in-place nested probes too.
  DurableConfig: {
    ExecutionTimeout: 60,
    RetentionPeriodInDays: 7,
    KMSKeyArn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/k3`,
  },
  TenancyConfig: { TenantIsolationMode: 'PER_TENANT' },
  Tags: [
    { Key: 'k1', Value: 'v1' },
    { Key: 'k2', Value: 'v2' },
  ],
};

const FUNCTION_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::Function',
  provider: () => new LambdaFunctionProvider(),
  physicalId: FN,
  createOnly: createOnlyOf('AWS::Lambda::Function'),
  arm: () => armFunction(),
  exempt: {},
  targets: [
    { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
    { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    // UpdateFunctionConfiguration re-sends each list from next: the removed
    // element must not ride along.
    {
      path: ['Layers', 0],
      command: 'UpdateFunctionConfigurationCommand',
      names: 'layer:l2:1',
      notNames: 'layer:l1:1',
    },
    {
      path: ['VpcConfig', 'SubnetIds', 0],
      command: 'UpdateFunctionConfigurationCommand',
      names: 'subnet-2',
      notNames: 'subnet-1',
    },
    {
      path: ['Environment', 'Variables', 'A'],
      command: 'UpdateFunctionConfigurationCommand',
      names: '"B":"2"',
      notNames: '"A":"1"',
    },
  ],
  bags: [
    {
      name: 'every zip-package property, S3 code',
      bag: FUNCTION_FULL,
      variants: { 'Code.S3ObjectStorageMode': 'COPY' },
      expectedSilent: {
        'update-remove:Code': CODE_REQUIRED_ON_UPDATE,
        // Not a gap: a removed RecursiveLoop keeps its live value by design,
        // and is the one config property left out of removalHandledInUpdate so
        // the engine names the removal (lambda-function-provider.ts:610-613,
        // 1483-1485).
        'update-remove:RecursiveLoop':
          'a removed RecursiveLoop keeps its live value; left out of removalHandledInUpdate so the engine names it (lambda-function-provider.ts:610-613, 1483-1485)',
      },
      expectedRemovalThrows: {
        'create:Code': CODE_REQUIRED,
        'create:Role': ROLE_REQUIRED,
        ...TAG_THROWS(ALL_DIRECTIONS, 2),
      },
    },
    {
      name: 'a container image function',
      bag: {
        PackageType: 'Image',
        Code: { ImageUri: `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com/repo:tag` },
        Role: ROLE,
        ImageConfig: {
          Command: ['c1', 'c2'],
          EntryPoint: ['e1', 'e2'],
          WorkingDirectory: '/w',
        },
      },
      expectedSilent: { 'update-remove:Code': CODE_REQUIRED_ON_UPDATE },
      expectedRemovalThrows: { 'create:Code': CODE_REQUIRED, 'create:Role': ROLE_REQUIRED },
    },
    {
      name: 'inline ZipFile code',
      bag: {
        Code: { ZipFile: 'def handler(event, context):\n  return 1\n' },
        Role: ROLE,
        Handler: 'index.handler',
        Runtime: 'python3.12',
      },
      expectedSilent: { 'update-remove:Code': CODE_REQUIRED_ON_UPDATE },
      expectedRemovalThrows: { 'create:Code': CODE_REQUIRED, 'create:Role': ROLE_REQUIRED },
    },
  ],
};

// --- AWS::Lambda::LayerVersion ----------------------------------------------------

/**
 * The layer version's `update()` always refuses (an immutable resource: no
 * UpdateLayerVersion API, lambda-layer-provider.ts:410-437), and every handled
 * property is create-only, so the engine replaces on any change and the bag
 * probes skip every update comparison. Only the harness's no-op `settled`
 * update would reach it: the case's provider answers that one in place, and
 * `describeLambdaExtras` pins the real refusal, with nothing on the wire.
 */
function layerProvider(): ResourceProvider {
  const real = new LambdaLayerVersionProvider();
  return Object.assign(Object.create(real) as ResourceProvider, {
    update: async (_logicalId: string, physicalId: string) => ({
      physicalId,
      wasReplaced: false,
    }),
  });
}

const LAYER_ARN = `arn:aws:lambda:us-east-1:${ACCOUNT}:layer:layer:1`;

const LAYER_CASE: TypeCase = {
  resourceType: 'AWS::Lambda::LayerVersion',
  provider: layerProvider,
  physicalId: LAYER_ARN,
  createOnly: createOnlyOf('AWS::Lambda::LayerVersion'),
  exempt: {},
  targets: [],
  bags: [
    {
      name: 'every property, S3 content',
      bag: {
        LayerName: 'layer',
        Content: {
          S3Bucket: 'layer-bucket',
          S3Key: 'layer.zip',
          S3ObjectVersion: 'v1',
          // Not the Lambda default COPY (#5305).
          S3ObjectStorageMode: 'REFERENCE',
        },
        CompatibleRuntimes: ['nodejs20.x', 'python3.12'],
        CompatibleArchitectures: ['x86_64', 'arm64'],
        Description: 'd',
        LicenseInfo: 'MIT',
      },
      variants: { 'Content.S3ObjectStorageMode': 'COPY' },
      expectedRemovalThrows: {
        'create:Content': {
          why: 'Content is required: create() refuses a layer version without it before any call',
          says: /Content is required/,
        },
      },
    },
  ],
};

export const LAMBDA_CASES: TypeCase[] = [FUNCTION_CASE, LAYER_CASE];

/** Direct-call checks the bag probes cannot make. */
export function describeLambdaExtras(): void {
  describe('AWS::Lambda::LayerVersion update', () => {
    it('refuses an in-place update and sends nothing', async () => {
      const bag = LAYER_CASE.bags[0]!.bag;
      let thrown: unknown;
      const outcome = await record(async () => {
        try {
          await new LambdaLayerVersionProvider().update(
            'L',
            LAYER_ARN,
            'AWS::Lambda::LayerVersion',
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
