import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * S3 + CloudFront example stack
 *
 * Demonstrates:
 * - S3 bucket with private access (no public access)
 * - CloudFront Origin Access Identity (OAI)
 * - CloudFront Distribution with S3 origin
 * - S3 Bucket Policy granting OAI read access
 * - CloudFront Origin Access Control (OAC) resource (AWS::CloudFront::OriginAccessControl)
 * - CfnOutputs for distribution domain and bucket name
 *
 * Note: CloudFront distributions can take several minutes to create.
 */
export class S3CloudFrontStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket (private, no public access)
    const bucket = new s3.Bucket(this, 'ContentBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // UPDATE mode switch (CDKD_TEST_UPDATE=true); each consumer below says
    // what it changes.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Create CloudFront Origin Access Identity. UPDATE mode changes the
    // comment, an in-place UpdateCloudFrontOriginAccessIdentity through the
    // provider's update() and its recorded-region guard (issue #2613).
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: isUpdate ? `OAI for ${bucket.bucketName} (updated)` : `OAI for ${bucket.bucketName}`,
    });

    // Grant OAI read access to the bucket
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        principals: [oai.grantPrincipal],
      })
    );

    // UPDATE mode adds a statement, an
    // in-place PutBucketPolicy through the bucket policy provider's update()
    // and its recorded-region guard (issue #2613).
    if (isUpdate) {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'CdkdUpdateDenyInsecureTransport',
          effect: iam.Effect.DENY,
          actions: ['s3:*'],
          resources: [bucket.bucketArn, bucket.arnForObjects('*')],
          principals: [new iam.AnyPrincipal()],
          conditions: { Bool: { 'aws:SecureTransport': 'false' } },
        })
      );
    }

    // Primary S3-via-OAI origin, plus an OriginGroup with an HTTP fallback so
    // the distribution carries an `AWS::CloudFront::Distribution.OriginGroups`
    // block — exercises CloudFrontDistributionProvider drift normalization of
    // the OriginGroups inner `{ Quantity, Items }` wrappers (Members /
    // FailoverCriteria.StatusCodes), issue #873.
    const s3Origin = origins.S3BucketOrigin.withOriginAccessIdentity(bucket, {
      originAccessIdentity: oai,
    });
    const originGroup = new origins.OriginGroup({
      primaryOrigin: s3Origin,
      // `customHeaders` synthesizes the CFn `OriginCustomHeaders` key, whose
      // SDK member is `CustomHeaders` — the issue #1373 nested-key rename.
      // Before that fix the header was silently dropped on create and WIPED
      // on update by the #1371 required-field fill; verify.sh asserts it
      // reaches AWS in Phase 1 AND survives the Phase 1.5 merge update.
      fallbackOrigin: new origins.HttpOrigin('fallback.example.com', {
        customHeaders: { 'X-Cdkd-Test-Header': 'cdkd-integ' },
      }),
      fallbackStatusCodes: [500, 502, 503, 504],
    });

    // A key group restricting `/private/*` to signed URLs synthesizes a
    // bare `CacheBehaviors[*].TrustedKeyGroups` list, whose SDK wrapper
    // REQUIRES `Enabled`. Before issue #5393 cdkd sent `{ Quantity, Items }`
    // without it and CloudFront refused the distribution with MalformedXML
    // (create, and the Phase 1.5 update re-sends it). The key is a throwaway
    // public key whose private half was never kept. Both carry fixed
    // stack-prefixed names so verify.sh's cleanup can sweep them by name
    // after an interrupted run (as it does the `${stack}-oac` OAC).
    const publicKey = new cloudfront.PublicKey(this, 'SignerPublicKey', {
      publicKeyName: `${this.stackName}-signer-key`,
      encodedKey: [
        '-----BEGIN PUBLIC KEY-----',
        'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA24jtt2xWany+KUl83Itj',
        'dZiFPAvVbHlDxLlAUYIpj0SQi4QCBzkKb2EHj8uLeyJva/pmmiO6FJVqlyhOHZoT',
        'v+oWtDX2n4nRaW6P1UqgHH4qbzhaik6AMmVgw0P6qDbzZYhtD90/Sxjb+Pf7hP8S',
        '6LcmGuZW7N/lx9DFj9G1+a81SIrW1fXHzYH6UEkIN5r7lGgEeZSnSGIhwt6ZfyTV',
        'whiDsODI1n++JVcpgfTkpWsRzorxSpzPMhjnBEK0hcjiOF6z43jPUNox1T3XTpu6',
        'ICoNUU+fWM5PjKywLpC6XqYYX52b7JnQwQGx9e8NSDqnBNWPC45S5aW8AYeCaLHH',
        '3wIDAQAB',
        '-----END PUBLIC KEY-----',
      ].join('\n'),
    });
    const keyGroup = new cloudfront.KeyGroup(this, 'SignerKeyGroup', {
      keyGroupName: `${this.stackName}-signer-kg`,
      items: [publicKey],
    });

    // Create CloudFront Distribution. The geo allowlist synthesizes
    // `Restrictions.GeoRestriction.Locations`, exercising the CFn -> SDK
    // GeoRestriction shape conversion (issue #1370) on create AND update.
    // UPDATE mode changes the comment + narrows the geo allowlist so the
    // second deploy exercises UpdateDistribution's read-modify-write merge
    // (issue #1371) — before that fix, ANY update failed with "WebACLId is
    // missing for the resource" because the template config was sent
    // verbatim instead of merged over the live one.
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: originGroup,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/private/*': {
          origin: originGroup,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          trustedKeyGroups: [keyGroup],
        },
      },
      defaultRootObject: 'index.html',
      comment: isUpdate
        ? 'S3 CloudFront Distribution (cdkd integration test, updated)'
        : 'S3 CloudFront Distribution (cdkd integration test)',
      geoRestriction: isUpdate
        ? cloudfront.GeoRestriction.allowlist('JP')
        : cloudfront.GeoRestriction.allowlist('JP', 'US'),
    });

    // Tag the distribution end-to-end so the cdkd `Tags` backfill (#609)
    // is exercised against real AWS — the property was a silent-drop
    // until the dedicated SDK Provider wired `CreateDistributionWithTagsCommand`.
    cdk.Tags.of(distribution).add('cdkd-test-owner', 'integ');
    cdk.Tags.of(distribution).add('cdkd-test-env', 'integ-env');

    // CloudFront Origin Access Control (OAC) - modern replacement for OAI.
    // UPDATE mode changes the description, an in-place
    // UpdateOriginAccessControl through the provider's update() and its
    // recorded-region guard (issue #2613).
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: `${this.stackName}-oac`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        description: isUpdate ? 'OAC for S3 origin (updated)' : 'OAC for S3 origin',
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'S3 bucket ARN',
    });

    new cdk.CfnOutput(this, 'OACId', {
      value: oac.attrId,
      description: 'CloudFront Origin Access Control ID',
    });
  }
}
