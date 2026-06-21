import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as glue from 'aws-cdk-lib/aws-glue';

/**
 * Integ probe for the `--replace` deploy flag.
 *
 * `AWS::Glue::SecurityConfiguration` is immutable on AWS — there is no
 * UpdateSecurityConfiguration API, so cdkd's provider `update()` throws a
 * typed `ResourceUpdateNotSupportedError`. cdkd has no replacement rule for
 * the type, so the diff classifies an EncryptionConfiguration change as an
 * in-place UPDATE. Without `--replace` the deploy fails (the provider rejects
 * the update); WITH `--replace` the engine falls back to DELETE + CREATE,
 * publishing a fresh configuration with the same name. The type is NOT
 * stateful, so `--replace` works WITHOUT `--force-stateful-recreation`.
 *
 * Phase 1 (no env): S3EncryptionMode = SSE-S3.
 * Phase 2 (CDKD_TEST_UPDATE=true): S3EncryptionMode = DISABLED — a no-KMS
 * immutable change that forces the replacement. A fixed physical Name lets
 * verify.sh assert the same name is re-created and that the live config now
 * reflects the new mode (proving the replacement actually happened).
 */
export class GlueSecurityConfigReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE === 'true' ? 'DISABLED' : 'SSE-S3';

    new glue.CfnSecurityConfiguration(this, 'SecConfig', {
      name: 'cdkd-replace-test-secconfig',
      encryptionConfiguration: {
        s3Encryptions: [{ s3EncryptionMode: mode }],
      },
    });
  }
}
