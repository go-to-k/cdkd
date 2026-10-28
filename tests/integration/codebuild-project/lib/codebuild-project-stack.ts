import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

/**
 * cdkd integration fixture: AWS::CodeBuild::Project.
 *
 * Phase 1 (default) deploys a project carrying every optional
 * UpdateProject field the #1160 umbrella flagged, with `BuildBatchConfig`
 * as the one that matters.
 *
 * Phase 2 (`CDKD_TEST_REMOVAL=true`) drops `BuildBatchConfig` AND the seven
 * fields a live CFn A/B (2026-08-10) proved CloudFormation RETAINS. That
 * asymmetry is the point of the fixture: after the redeploy the batch config
 * must be GONE (cdkd sends the empty-object clear, matching CFn) while the
 * other seven must still carry their phase-1 values (cdkd passes them
 * through, matching CFn). A fixture that only checked the reset would pass
 * just as well against an over-eager provider that reset everything.
 * Phase 2 also drops `EncryptionKey` and `Tags`, which CFn resets
 * (go-to-k/cdkd#1160).
 *
 * Phase 1 also declares `VpcConfig`, `FileSystemLocations`,
 * `SecondarySources`, `SecondarySourceVersions`, `SecondaryArtifacts` and
 * `BadgeEnabled`, and Phase 2 drops all six. A CFn A/B (go-to-k/cdkd#5492)
 * showed CloudFormation KEEPS every one of them, so Phase 2 asserts they are
 * still live. A badge needs a real source type, so the project's primary
 * source is a CODECOMMIT clone URL in both phases; the repository is never
 * created because the project never runs a build.
 */
export class CodeBuildProjectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removalPhase = process.env['CDKD_TEST_REMOVAL'] === 'true';

    // go-to-k/cdkd#5492 scaffolding, kept in BOTH phases so that Phase 2 drops
    // only the project's references to it: a VPC with one subnet and a
    // security group for `VpcConfig`, and a bucket for the secondary artifact
    // (CreateProject refuses a bucket that does not exist). No build runs, so
    // nothing is attached to the subnet and the bucket stays empty.
    const cfnVpc = new ec2.CfnVPC(this, 'Vpc', { cidrBlock: '10.92.0.0/16' });
    const cfnSubnet = new ec2.CfnSubnet(this, 'Subnet', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.92.0.0/24',
      availabilityZone: cdk.Fn.select(0, cdk.Fn.getAzs()),
    });
    const cfnSg = new ec2.CfnSecurityGroup(this, 'Sg', {
      vpcId: cfnVpc.ref,
      groupDescription: 'cdkd-integ codebuild-project (go-to-k/cdkd#5492)',
    });
    const artifactBucket = new s3.Bucket(this, 'SecondaryArtifactBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    // CODECOMMIT clone URLs of repositories that are never created. The
    // secondary source must name a different location from the primary one
    // (CreateProject refuses "conflicting source locations").
    const primaryRepo = codecommit.Repository.fromRepositoryName(this, 'PrimaryRepo', 'cdkd-integ-none');
    const secondaryRepo = codecommit.Repository.fromRepositoryName(this, 'SecondaryRepo', 'cdkd-integ-none-2');

    const project = new codebuild.Project(this, 'BatchProject', {
      projectName: `${cdk.Stack.of(this).stackName}-batch`,
      source: codebuild.Source.codeCommit({ repository: primaryRepo }),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo cdkd-integ'] } },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.SMALL,
        // CreateProject requires privileged mode on a project with file system
        // locations. Set in both phases, so Phase 2 changes nothing about it.
        privileged: true,
      },
      // go-to-k/cdkd#5492: the six fields CloudFormation KEEPS when the
      // template drops them (CFn A/B). Set in Phase 1 only, asserted still
      // live after Phase 2.
      ...(removalPhase
        ? {}
        : {
            vpc: ec2.Vpc.fromVpcAttributes(this, 'VpcRef', {
              vpcId: cfnVpc.ref,
              availabilityZones: [cfnSubnet.attrAvailabilityZone],
              privateSubnetIds: [cfnSubnet.ref],
            }),
            securityGroups: [ec2.SecurityGroup.fromSecurityGroupId(this, 'SgRef', cfnSg.attrGroupId)],
            fileSystemLocations: [
              codebuild.FileSystemLocation.efs({
                identifier: 'efs1',
                location: `fs-0123456789abcdef0.efs.${cdk.Aws.REGION}.amazonaws.com:/`,
                mountPoint: '/mnt/efs',
              }),
            ],
            secondarySources: [
              // `branchOrRef` renders the SecondarySourceVersions entry.
              codebuild.Source.codeCommit({
                repository: secondaryRepo,
                identifier: 'src2',
                branchOrRef: 'refs/heads/main',
              }),
            ],
            secondaryArtifacts: [
              codebuild.Artifacts.s3({
                bucket: artifactBucket,
                identifier: 'art2',
                name: 'out',
                packageZip: false,
              }),
            ],
            badge: true,
          }),
      // The seven CFn-RETAINS fields. Set in BOTH phases would prove
      // nothing, so they are set in phase 1 and dropped in phase 2 — the
      // live assertion is that AWS still reports the phase-1 values.
      ...(removalPhase
        ? {}
        : {
            description: 'cdkd-integ-description',
            timeout: cdk.Duration.minutes(25),
            queuedTimeout: cdk.Duration.minutes(100),
            concurrentBuildLimit: 2,
            cache: codebuild.Cache.local(codebuild.LocalCacheMode.CUSTOM),
            logging: { cloudWatch: { enabled: false } },
          }),
    });

    const cfnProject = project.node.defaultChild as codebuild.CfnProject;

    // go-to-k/cdkd#5492: CreateProject / UpdateProject check a project's VPC
    // config with the service role (observed: "Not authorized to perform
    // DescribeSecurityGroups"). Phase 1's `vpc` adds those reads through its
    // own policy, which Phase 2 deletes while the kept VPC config stays live,
    // so the role carries them in BOTH phases and the Phase 2 UpdateProject
    // does not depend on the order of that delete.
    project.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeSubnets',
          'ec2:DescribeVpcs',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeDhcpOptions',
        ],
        resources: ['*'],
      })
    );

    // `AutoRetryLimit` has no L2 property, and `BuildBatchConfig` via the L2
    // (`enableBatchBuilds()`) does not accept a timeout / combineArtifacts,
    // so both ride the L1 escape hatch. Phase 2 drops them entirely, which
    // is what makes the CFn removal reachable.
    if (!removalPhase) {
      // go-to-k/cdkd#2762: both go through UpdateProjectVisibility after
      // CreateProject. PUBLIC_READ is the non-default (a new project is
      // PRIVATE with no role), so an unsent pair cannot pass the Phase 1 read.
      // The project never runs a build, so nothing becomes public. Phase 2
      // drops both: CloudFormation then resets to PRIVATE and clears the role
      // (CFn A/B), and so must cdkd.
      cfnProject.visibility = 'PUBLIC_READ';
      cfnProject.resourceAccessRole = project.role!.roleArn;
      cfnProject.autoRetryLimit = 3;
      // go-to-k/cdkd#1160: CloudFormation RESETS a removed EncryptionKey to
      // the AWS managed S3 key (read back as `...:alias/aws/s3`) and removes
      // every tag when Tags is removed (CFn A/B), so Phase 2 must see both.
      // verify.sh passes the aws/s3 managed key's KEY ARN, the one spelling
      // that reads back differently from the reset; no key is created.
      const keyArn = process.env['CDKD_INTEG_CB_KEY_ARN'];
      if (keyArn) cfnProject.encryptionKey = keyArn;
      cfnProject.tags.setTag('cdkd-integ-tag', 'phase1');
      cfnProject.buildBatchConfig = {
        serviceRole: project.role!.roleArn,
        timeoutInMins: 120,
        combineArtifacts: true,
      };
    } else {
      // The L2 emits `Cache: { Type: NO_CACHE }` UNCONDITIONALLY, so simply
      // omitting the `cache` prop renders a template that still DECLARES the
      // property — a value CHANGE, not a removal. Without this override the
      // phase-2 redeploy legitimately sets NO_CACHE and the retention
      // assertion fails against correct behavior (observed live 2026-08-10).
      // Delete the property outright so the phase is a true removal.
      cfnProject.addPropertyDeletionOverride('Cache');
      // Same for `EncryptionKey`: the L2 emits `alias/aws/s3` when no key is
      // given, a value change the pre-fix provider already sent. Delete it so
      // Phase 2 is a true removal (go-to-k/cdkd#1160).
      cfnProject.addPropertyDeletionOverride('EncryptionKey');
    }

    // Issue #3866 refusal phase (verify.sh Phase 0): `Triggers` (CDK's
    // `webhook: true`) is a property the SDK provider does not handle, on a
    // type Cloud Control has no handlers for, so cdkd must refuse the deploy
    // pre-flight rather than route the project to Cloud Control. Never set on
    // a deploy that succeeds. (It was `Visibility` until #2762 handled it.)
    if (process.env['CDKD_TEST_NONPROV_REFUSAL'] === 'true') {
      cfnProject.addPropertyOverride('Triggers', { Webhook: true });
    }

    new cdk.CfnOutput(this, 'ProjectName', { value: project.projectName });
  }
}
