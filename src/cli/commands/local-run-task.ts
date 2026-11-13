/**
 * `cdkd local run-task <target>`. The implementation lives in
 * `./local-run-task/*.ts`; this module keeps the command factory and re-exports
 * every name it exported before the split, so importers and tests are unchanged.
 */
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  stateOptions,
  parseStackRegion,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { addAwsEndpointOptions, addImageOverrideOptions } from 'cdk-local/internal';
import { emulateRoleViaOption } from '../options/emulate-role-via.js';
import { localRunTaskCommand } from './local-run-task/command.js';

export { resolvePlaceholderAccount, assumeTaskRole } from './local-run-task/stack-account.js';
export {
  resolveEcsConsumerRegion,
  buildEcsImageResolutionContext,
  pickCandidateStack,
} from './local-run-task/image-context.js';
export { readEnvOverridesFile } from './local-run-task/env-overrides.js';
export {
  resolveSidecarCredentials,
  resolveTaskCredentialChannels,
  buildRunEcsTaskOptions,
} from './local-run-task/credentials.js';
export { resolveRunTaskImageOverride } from './local-run-task/image-override.js';
export type { RunTaskImageOverrideResult } from './local-run-task/image-override.js';

export function createLocalRunTaskCommand(): Command {
  const cmd = new Command('run-task')
    .description(
      'Run an AWS::ECS::TaskDefinition locally — pulls/builds images, sets up a per-task docker network ' +
        'with the AWS-published metadata-endpoints sidecar, and starts every container in dependsOn order. ' +
        'Target accepts a CDK display path (MyStack/MyService/TaskDef) or stack-qualified logical ID ' +
        '(MyStack:MyServiceTaskDefXYZ1234). Single-stack apps may omit the stack prefix.'
    )
    .argument(
      '<target>',
      'CDK display path or stack-qualified logical ID of the AWS::ECS::TaskDefinition to run'
    )
    .addOption(
      new Option(
        '--cluster <name>',
        'Cluster name surfaced to ECS_CONTAINER_METADATA_URI_V4 and used as the docker network prefix'
      ).default('cdkd-local')
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"ContainerName":{"KEY":"VALUE"}, "Parameters":{}})'
      )
    )
    .addOption(
      new Option(
        '--container-host <ip>',
        'Host IP to bind published container ports to. Must be a numeric IP (Docker rejects hostnames here)'
      ).default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-task-role [arn]',
        "Assume the task definition's TaskRoleArn (or the supplied ARN) and forward STS-issued temp " +
          'credentials via the metadata sidecar so containers run with the deployed function role. ' +
          "Bare flag uses the template's TaskRoleArn; pass an explicit ARN to override."
      )
    )
    .addOption(emulateRoleViaOption('--assume-task-role'))
    .addOption(
      new Option('--no-pull', 'Skip docker pull for every container image and the metadata sidecar')
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized ' +
          'registries. Issues sts:AssumeRole via the default credential chain and uses the ' +
          'temporary credentials for ecr:GetAuthorizationToken + docker pull. Required when the ' +
          'caller does not have direct cross-account access to the target repository. ' +
          'A same-account pull in ANY region does not need this flag: the ECR client is built ' +
          "for the image URI's own region, so crossing a region costs nothing extra."
      )
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'Force docker --platform (linux/amd64 or linux/arm64). Default: inferred from task RuntimePlatform.CpuArchitecture'
      )
    )
    .addOption(
      new Option(
        '--keep-running',
        "Don't docker rm -f the user containers on task exit (network + sidecar are still torn down). " +
          'Use when you want to docker exec into a stopped container for post-mortems.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--detach',
        'Start the containers in the background and exit (skip log streaming + auto teardown). ' +
          'Useful in CI smoke tests; caller manages container lifecycle.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Fn::Sub / Fn::GetAtt references to ' +
          'same-stack AWS::ECR::Repository resources with the deployed URI. ' +
          'Off by default — only the AWS pseudo-parameter tier (${AWS::AccountId} / ${AWS::Region}) ' +
          'is resolved without this flag.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in container env vars / secrets / image URIs with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          'Bare form uses the cdkd stack name; pass an explicit value when the CFn stack name differs. ' +
          'Mutually exclusive with --from-state. Fn::GetAtt is warn-and-dropped in v1 (CFn ListStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-state when the same stack name has state in multiple regions, ' +
          'and with --from-cfn-stack as the CFn client region (cdkd does not have a separate --cfn-stack-region flag).'
      ).argParser(parseStackRegion)
    )
    .action(withErrorHandling(localRunTaskCommand));

  // The same flag family `start-service` / `start-alb` inherit from cdk-local's
  // engine (go-to-k/cdkd#5768).
  addImageOverrideOptions(cmd);
  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  // `--aws-emulator [url]` / `--ca-bundle <file>` (go-to-k/cdkd#6131, #6132),
  // the same spelling the cdk-local engine commands register.
  addAwsEndpointOptions(cmd);
  return cmd;
}
