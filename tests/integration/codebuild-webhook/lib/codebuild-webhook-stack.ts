import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * cdkd integration fixture: AWS::CodeBuild::Project `Triggers` (go-to-k/cdkd#5627).
 *
 * A webhook lands on a real source repository, so the repository and the
 * CodeConnections connection that reaches it are PARAMETERS:
 *
 * - `CDKD_INTEG_WEBHOOK_REPO`: `<owner>/<name>` of a repository dedicated to this
 *   fixture. Never point it at a repository anything else uses.
 * - `CDKD_INTEG_WEBHOOK_CONNECTION_ARN`: an AVAILABLE GitHub connection that can
 *   reach that repository.
 *
 * `CDKD_TEST_WEBHOOK` picks what the template declares; see `verify.sh`.
 */
type Mode = 'filters' | 'filters-changed' | 'no-filters' | 'no-triggers' | 'disabled';

function webhookSettings(mode: Mode): Pick<codebuild.GitHubSourceProps, 'webhook' | 'webhookFilters'> {
  switch (mode) {
    case 'filters':
      return {
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('main'),
        ],
      };
    case 'filters-changed':
      return {
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH).andBranchIs('dev'),
        ],
      };
    case 'no-filters':
      return { webhook: true };
    case 'no-triggers':
      return {};
    case 'disabled':
      return { webhook: false };
  }
}

export class CodeBuildWebhookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const repo = process.env['CDKD_INTEG_WEBHOOK_REPO'] ?? 'unset-owner/unset-repo';
    const connectionArn =
      process.env['CDKD_INTEG_WEBHOOK_CONNECTION_ARN'] ??
      `arn:aws:codeconnections:${this.region}:${this.account}:connection/unset`;
    const mode = (process.env['CDKD_TEST_WEBHOOK'] ?? 'filters') as Mode;
    const [owner = '', name = ''] = repo.split('/');

    const project = new codebuild.Project(this, 'Project', {
      projectName: `${this.stackName}-project`,
      // Varied per mode, so a mode that leaves the template's `Triggers`
      // unchanged still reaches `update()`.
      description: `webhook mode ${mode}`,
      source: codebuild.Source.gitHub({ owner, repo: name, ...webhookSettings(mode) }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0 },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: { build: { commands: ['echo never run'] } },
      }),
    });
    // `CreateProject` checks the connection with this role, so the grant comes
    // first. Its own policy: the role's DefaultPolicy references the project, so
    // the project cannot depend on that one.
    const connectionPolicy = new iam.Policy(this, 'ConnectionPolicy', {
      roles: [project.role!],
      statements: [
        new iam.PolicyStatement({
          actions: [
            'codeconnections:GetConnection',
            'codeconnections:GetConnectionToken',
            'codeconnections:UseConnection',
            'codestar-connections:UseConnection',
          ],
          resources: [connectionArn],
        }),
      ],
    });

    // On the L1: `node.addDependency` would also order the project's role after
    // a policy that references that role.
    const cfnProject = project.node.defaultChild as codebuild.CfnProject;
    cfnProject.addResourceDependency(connectionPolicy.node.defaultChild as cdk.CfnResource);
    cfnProject.addPropertyOverride('Source.Auth', { Type: 'CODECONNECTIONS', Resource: connectionArn });

    new cdk.CfnOutput(this, 'ProjectName', { value: project.projectName });
  }
}
