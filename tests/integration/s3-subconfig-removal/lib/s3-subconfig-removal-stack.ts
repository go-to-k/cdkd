import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * cdkd S3 sub-config REMOVAL semantics integ (issue #1466).
 *
 *   covers: AWS::S3::Bucket
 *
 * Baseline declares four sub-configs that all used to sit on the provider's
 * unconditional "always-PUT" path. Under `CDKD_TEST_UPDATE=true` all four are
 * REMOVED from the template, which is the case that was silently broken: the
 * guarded `if (properties['X'])` branch simply never ran, so the old value
 * survived on the real bucket while cdkd reported `updated` and `drift` stayed
 * clean.
 *
 * The expected post-removal state is NOT uniform, and each verdict below was
 * pinned by a live CloudFormation A/B on this same template pair:
 *
 *   VersioningConfiguration        -> CFn SUSPENDS
 *   OwnershipControls              -> CFn DELETES
 *   BucketEncryption               -> CFn RESETS to the SSE-S3 (AES256) default
 *   PublicAccessBlockConfiguration -> CFn KEEPS it (cdkd was already at parity)
 *
 * The PublicAccessBlock row is deliberately part of the fixture: it looks
 * identical to the other three in the provider source, so this is the
 * real-AWS guard against "fixing" a behavior that is already correct.
 *
 * L1 `CfnBucket` is used so the exact CFn property shapes are under test
 * (the L2 does not expose all four).
 */
export class S3SubconfigRemovalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Removal phase: drop every sub-config from the template.
    const removed = process.env['CDKD_TEST_UPDATE'] === 'true';
    const account = cdk.Stack.of(this).account;

    const bucket = new s3.CfnBucket(this, 'SubconfigBucket', {
      bucketName: `cdkd-subconfig-removal-${account}`,

      // -> expect Suspended after removal
      versioningConfiguration: removed ? undefined : { status: 'Enabled' },

      // -> expect deleted after removal
      ownershipControls: removed
        ? undefined
        : { rules: [{ objectOwnership: 'BucketOwnerPreferred' }] },

      // -> expect reset to AES256 after removal
      bucketEncryption: removed
        ? undefined
        : {
            serverSideEncryptionConfiguration: [
              {
                serverSideEncryptionByDefault: {
                  sseAlgorithm: 'aws:kms',
                  kmsMasterKeyId: 'alias/aws/s3',
                },
                bucketKeyEnabled: true,
              },
            ],
          },

      // -> expect UNCHANGED after removal (CloudFormation parity)
      publicAccessBlockConfiguration: removed
        ? undefined
        : {
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true,
          },
    });

    // L1 CfnBucket defaults to DeletionPolicy: Delete, but state the decision
    // explicitly so the fixture can never leak a bucket.
    bucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'BucketName', { value: bucket.ref });

    // go-to-k/cdkd#2762: the SDK route of a name prefix, its namespace, ABAC and
    // S3 Metadata. The overrides keep the fixture independent of which of these
    // the installed CfnBucket types. Each phase's expectation was pinned by a
    // CloudFormation A/B on these same properties.
    const metadataRemoved = process.env['CDKD_TEST_METADATA_REMOVED'] === 'true';
    const metadataBucket = new s3.CfnBucket(this, 'MetadataBucket', {
      tags: metadataRemoved
        ? [{ key: 'cdkd-2762', value: 'abac-off' }]
        : removed
        ? [
            { key: 'cdkd-2762', value: 'updated' },
            { key: 'cdkd-2762-added', value: 'added' },
          ]
        : [
            { key: 'cdkd-2762', value: 'base' },
            { key: 'cdkd-2762-dropped', value: 'base' },
          ],
    });
    metadataBucket.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    metadataBucket.addPropertyOverride('BucketNamePrefix', 'cdkd-2762-metadata');
    metadataBucket.addPropertyOverride('BucketNamespace', 'account-regional');
    // The name, not a Ref: the bucket refers to the role.
    const metadataBucketArn = cdk.Fn.sub(
      'arn:aws:s3:::cdkd-2762-metadata-${AWS::AccountId}-${AWS::Region}-an'
    );
    const annotationRole = (id: string): iam.CfnRole =>
      new iam.CfnRole(this, id, {
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'metadata.s3.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        },
        policies: [
          {
            policyName: 'annotations',
            policyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Action: [
                    's3:GetObjectAnnotation',
                    's3:GetObjectVersionAnnotation',
                    's3:ListBucket',
                    's3:ListBucketVersions',
                  ],
                  Resource: [metadataBucketArn, cdk.Fn.join('', [metadataBucketArn, '/*'])],
                },
              ],
            },
          },
        ],
      });
    const annotationRoles = [annotationRole('AnnotationRoleA'), annotationRole('AnnotationRoleB')];
    if (!metadataRemoved) {
      metadataBucket.addPropertyOverride('AbacStatus', 'Enabled');
      metadataBucket.addPropertyOverride('MetadataConfiguration', {
        JournalTableConfiguration: {
          RecordExpiration: { Expiration: 'ENABLED', Days: removed ? 8 : 7 },
          EncryptionConfiguration: { SseAlgorithm: 'AES256' },
        },
        InventoryTableConfiguration: { ConfigurationState: removed ? 'ENABLED' : 'DISABLED' },
        // After the roles exist and have propagated: see verify.sh Phase 1a.
        ...(removed || process.env['CDKD_TEST_ANNOTATION'] === 'true'
          ? {
              AnnotationTableConfiguration: {
                ConfigurationState: 'ENABLED',
                Role: annotationRoles[removed ? 1 : 0]!.attrArn,
              },
            }
          : {}),
      });
      new cdk.CfnOutput(this, 'JournalTableArn', {
        value: metadataBucket.getAtt('MetadataConfiguration.JournalTableConfiguration.TableArn')
          .toString(),
      });
    }
    new cdk.CfnOutput(this, 'MetadataBucketName', { value: metadataBucket.ref });
    new cdk.CfnOutput(this, 'AnnotationRoleAArn', { value: annotationRoles[0]!.attrArn });
    new cdk.CfnOutput(this, 'AnnotationRoleBArn', { value: annotationRoles[1]!.attrArn });
  }
}
