import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Whole-field removal reset (issue #1155).
 *
 * `UpdateFunctionConfiguration` treats an absent field as "no change", so a
 * template that drops a previously-set config field must send the CFn-default
 * reset value or AWS silently keeps the old one — while the deploy reports
 * success and state drops the field, baking in invisible drift. cdkd
 * previously passed Timeout / MemorySize / Description / Environment / Layers /
 * TracingConfig / EphemeralStorage straight through as `undefined` on update.
 * This fixture removes six of them on UPDATE and asserts AWS reverted each to
 * its CloudFormation default.
 *
 *   covers: AWS::Lambda::Function, AWS::Lambda::CodeSigningConfig
 *
 * Phase 1 sets Timeout 30 / MemorySize 256 / Description / env {FOO} /
 * EphemeralStorage 1024 / Tracing ACTIVE; Phase 2 (CDKD_TEST_UPDATE=true)
 * sets none of them.
 *
 * Issue #609 rider — four properties this fixture also proves reach AWS,
 * because a backfilled property that is merely declared `handled` still
 * deploys green while silently dropping the value:
 *
 *  - `RuntimeManagementConfig` and `CodeSigningConfigArn` ride the SAME
 *    removal axis this fixture already exercises: neither is a member of
 *    `UpdateFunctionConfiguration`, so each has its own control-plane call and
 *    its own removal spelling (reset to `Auto` / `DeleteFunctionCodeSigningConfig`).
 *    Both are set in phase 1 and dropped in phase 2.
 *  - `DurableConfig` and `TenancyConfig` are set on a SEPARATE function that
 *    keeps them in BOTH phases. That is deliberate, not an oversight: dropping
 *    either one is classified as a REPLACEMENT (AWS refuses to add a durable
 *    config to a function that lacks one, and cannot express its removal at
 *    all; TenancyConfig is create-only), and this fixture pins its functions to
 *    fixed names — so a mid-run replacement would turn a property assertion
 *    into a delete/create name-collision test of something else entirely.
 */
export class LambdaConfigFieldRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const update = process.env.CDKD_TEST_UPDATE === 'true';

    // Code-signing config for the #609 CodeSigningConfigArn assertion. The
    // allowed-publisher profile deliberately does NOT exist: AWS validates the
    // ARN's SHAPE but not its existence at CreateCodeSigningConfig time
    // (live-probed us-east-1 2026-08-11), and with
    // UntrustedArtifactOnDeployment=Warn the config attaches to an unsigned
    // function. That keeps the fixture free of a real AWS::Signer::SigningProfile,
    // which cannot be deleted synchronously and would leak between runs.
    const codeSigning = new lambda.CfnCodeSigningConfig(this, 'CodeSigning', {
      description: 'cdkd integ — issue #609 CodeSigningConfigArn wiring',
      allowedPublishers: {
        signingProfileVersionArns: [
          `arn:aws:signer:${this.region}:${this.account}:/signing-profiles/cdkd_integ_absent/AAAAAAAAAA`,
        ],
      },
      codeSigningPolicies: { untrustedArtifactOnDeployment: 'Warn' },
    });

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      ...(update
        ? {}
        : {
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
            description: 'before removal',
            environment: { FOO: 'bar' },
            ephemeralStorageSize: cdk.Size.mebibytes(1024),
            tracing: lambda.Tracing.ACTIVE,
          }),
    });

    if (!update) {
      const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
      // Both are L1 overrides rather than L2 props so the removal phase can
      // drop them by simply not emitting them — the shape the #1160 /
      // #1155 removal axis needs.
      cfnFn.addPropertyOverride('RuntimeManagementConfig', {
        UpdateRuntimeOn: 'FunctionUpdate',
      });
      cfnFn.addPropertyOverride('CodeSigningConfigArn', codeSigning.ref);
    }

    // Durable / tenancy function — present in BOTH phases (see the class
    // docstring for why these two are not on the removal axis). nodejs22.x
    // matches the runtime the live probe established these accept.
    const durableFn = new lambda.Function(this, 'DurableFn', {
      functionName: `${this.stackName}-durable-fn`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
    });
    const cfnDurableFn = durableFn.node.defaultChild as lambda.CfnFunction;
    cfnDurableFn.addPropertyOverride('DurableConfig', {
      ExecutionTimeout: 3600,
      RetentionPeriodInDays: 14,
    });
    cfnDurableFn.addPropertyOverride('TenancyConfig', {
      TenantIsolationMode: 'PER_TENANT',
    });
  }
}
