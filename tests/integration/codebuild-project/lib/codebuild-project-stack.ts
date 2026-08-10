import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import type { Construct } from 'constructs';

/**
 * cdkd integration fixture: AWS::CodeBuild::Project.
 *
 * Phase 1 (default) deploys a NO_SOURCE project carrying every optional
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
 */
export class CodeBuildProjectStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removalPhase = process.env['CDKD_TEST_REMOVAL'] === 'true';

    const project = new codebuild.Project(this, 'BatchProject', {
      projectName: `${cdk.Stack.of(this).stackName}-batch`,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo cdkd-integ'] } },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_5,
        computeType: codebuild.ComputeType.SMALL,
      },
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

    // `AutoRetryLimit` has no L2 property, and `BuildBatchConfig` via the L2
    // (`enableBatchBuilds()`) does not accept a timeout / combineArtifacts,
    // so both ride the L1 escape hatch. Phase 2 drops them entirely, which
    // is what makes the CFn removal reachable.
    if (!removalPhase) {
      cfnProject.autoRetryLimit = 3;
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
    }

    new cdk.CfnOutput(this, 'ProjectName', { value: project.projectName });
  }
}
