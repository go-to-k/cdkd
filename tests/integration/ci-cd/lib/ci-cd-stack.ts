import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

/**
 * CI/CD pipeline example stack
 *
 * Demonstrates:
 * - AWS::CodeBuild::Project (build environment with inline buildspec)
 * - AWS::CodePipeline::Pipeline (S3 source → CodeBuild)
 * - AWS::S3::Bucket for artifacts
 * - IAM roles for CodeBuild and CodePipeline (auto-generated)
 * - CfnOutputs for project name, pipeline name, bucket name
 * - AWS::CodeBuild::Project nested Source / Cache sub-keys (issue #1386)
 */
export class CiCdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for pipeline artifacts
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // CodeBuild Project
    const buildProject = new codebuild.Project(this, 'BuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: ['echo "Build completed"'],
          },
        },
        artifacts: {
          files: ['**/*'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      },
      // Exercises the #609 AutoRetryLimit backfill (rides CreateProject directly).
      autoRetryLimit: 2,
    });

    // ── issue #1386: nested Source / Cache sub-keys ────────────────────
    //
    // A SECOND, standalone project (NOT wired into the pipeline) because a
    // CODEPIPELINE-typed source rejects both nested Source sub-blocks —
    // live-probed 2026-08-09 against CreateProject:
    //   "Git submodules config is not supported for CodePipeline source"
    //   "Source type CODEPIPELINE does not support BuildStatusConfig"
    // A GITHUB source pointed at a PUBLIC repository is the cheapest shape
    // that accepts both and needs NO source credential (also live-probed:
    // CreateProject succeeds and BatchGetProjects echoes every value back).
    //
    // L1 `CfnProject` over an L2 override per the repo's backfill-fixture
    // convention — the L2 `Project` does not surface `BuildStatusConfig`
    // or `Cache.CacheNamespace`.
    const subKeysRole = new iam.Role(this, 'SubKeysProjectRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });
    artifactBucket.grantReadWrite(subKeysRole);

    const subKeysProject = new codebuild.CfnProject(this, 'SubKeysProject', {
      name: `${this.stackName}-subkeys`,
      serviceRole: subKeysRole.roleArn,
      artifacts: { type: 'NO_ARTIFACTS' },
      environment: {
        type: 'LINUX_CONTAINER',
        computeType: 'BUILD_GENERAL1_SMALL',
        image: 'aws/codebuild/standard:7.0',
      },
      source: {
        type: 'GITHUB',
        location: 'https://github.com/aws-samples/aws-codebuild-samples.git',
        buildSpec: 'version: 0.2\nphases:\n  build:\n    commands:\n      - echo "sub-keys"\n',
        // The project is never built by this test, so keep CodeBuild from
        // trying to post a commit status back to the public repository.
        reportBuildStatus: false,
        // Source.GitSubmodulesConfig.FetchSubmodules -> SDK gitSubmodulesConfig
        gitSubmodulesConfig: { fetchSubmodules: true },
        // Source.BuildStatusConfig.{Context,TargetUrl} -> SDK buildStatusConfig
        buildStatusConfig: {
          context: 'cdkd-integ-context',
          targetUrl: 'https://example.com/cdkd-integ-build',
        },
      },
      // Cache.CacheNamespace -> SDK cacheNamespace. The S3 cache location
      // must reference a bucket that already exists, so reusing the artifact
      // bucket also gives the DAG a real dependency edge.
      cache: {
        type: 'S3',
        location: `${artifactBucket.bucketName}/subkeys-cache`,
        cacheNamespace: 'cdkd-integ-namespace',
      },
    });
    subKeysProject.node.addDependency(subKeysRole);

    // CodePipeline (S3 source → CodeBuild)
    const sourceOutput = new codepipeline.Artifact('SourceOutput');
    const buildOutput = new codepipeline.Artifact('BuildOutput');

    const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
      pipelineName: `${this.stackName}-pipeline`,
      artifactBucket,
      stages: [
        {
          stageName: 'Source',
          actions: [
            new codepipeline_actions.S3SourceAction({
              actionName: 'S3Source',
              bucket: artifactBucket,
              bucketKey: 'source.zip',
              output: sourceOutput,
              trigger: codepipeline_actions.S3Trigger.NONE,
            }),
          ],
        },
        {
          stageName: 'Build',
          actions: [
            new codepipeline_actions.CodeBuildAction({
              actionName: 'Build',
              project: buildProject,
              input: sourceOutput,
              outputs: [buildOutput],
            }),
          ],
        },
      ],
    });

    // Outputs
    new cdk.CfnOutput(this, 'BuildProjectName', {
      value: buildProject.projectName,
      description: 'CodeBuild project name',
    });

    new cdk.CfnOutput(this, 'SubKeysProjectName', {
      value: subKeysProject.ref,
      description: 'CodeBuild project carrying the issue #1386 nested sub-keys',
    });

    new cdk.CfnOutput(this, 'PipelineName', {
      value: pipeline.pipelineName,
      description: 'CodePipeline name',
    });

    new cdk.CfnOutput(this, 'ArtifactBucketName', {
      value: artifactBucket.bucketName,
      description: 'Artifact bucket name',
    });
  }
}
