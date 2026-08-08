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

    // Create CloudFront Origin Access Identity
    const oai = new cloudfront.OriginAccessIdentity(this, 'OAI', {
      comment: `OAI for ${bucket.bucketName}`,
    });

    // Grant OAI read access to the bucket
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        principals: [oai.grantPrincipal],
      })
    );

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
      fallbackOrigin: new origins.HttpOrigin('fallback.example.com'),
      fallbackStatusCodes: [500, 502, 503, 504],
    });

    // UPDATE mode (CDKD_TEST_UPDATE=true): change the comment + narrow the
    // geo allowlist so the second deploy exercises UpdateDistribution's
    // read-modify-write merge (issue #1371) — before that fix, ANY update
    // failed with "WebACLId is missing for the resource" because the
    // template config was sent verbatim instead of merged over the live one.
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    // Create CloudFront Distribution. The geo allowlist synthesizes
    // `Restrictions.GeoRestriction.Locations`, exercising the CFn -> SDK
    // GeoRestriction shape conversion (issue #1370) on create AND update.
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: originGroup,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
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

    // CloudFront Origin Access Control (OAC) - modern replacement for OAI
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: `${this.stackName}-oac`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        description: 'OAC for S3 origin',
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
