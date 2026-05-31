import { Command, Option } from 'commander';
import { withErrorHandling, LocalStartServiceError } from '../../utils/error-handler.js';
import { listTargets, getEmbedConfig } from 'cdk-local';
import {
  addCommonEcsServiceOptions,
  addStartServiceSpecificOptions,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
  type ServiceBoot,
} from './ecs-service-emulator.js';
import { cdkdExtraStateProviders } from './local-state-source.js';

/**
 * Cdkd-specific extension of cdk-local's `EcsServiceEmulatorOptions` carrying
 * the `--from-state` / `--state-bucket` / `--state-prefix` fields (cdkd's
 * S3-backed state source). Mirrors `LocalStartAlbOptions` in
 * `local-start-alb.ts` — cdk-local's option type already declares
 * `[key: string]: unknown`, so these fields ride through the engine and reach
 * cdkd's `fromStateFactory` (registered via `cdkdExtraStateProviders`) when
 * the engine calls `createLocalStateProvider` internally. `--from-cfn-stack`
 * + `--stack-region` are inherited from `addCommonEcsServiceOptions`.
 */
export interface LocalStartServiceOptions extends EcsServiceEmulatorOptions {
  /**
   * `--from-state` — read cdkd's S3 state for the target stack and substitute
   * `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` / `Fn::GetStackOutput`
   * intrinsics in the resolved ECS service container images, environment
   * variables, secrets, role ARNs, and volumes. Mutually exclusive with
   * `--from-cfn-stack`.
   */
  fromState: boolean;
  /** S3 bucket for `--from-state`. Falls back to CDKD_STATE_BUCKET / cdk.json. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state` (commander always supplies the default). */
  statePrefix: string;
}

/**
 * `cdkl start-service` strategy — name one or more ECS services and the engine
 * boots their replicas. There is no front-door listener (services are reached
 * directly via their published container ports). Mirrors `albStrategy` in
 * shape, with `frontDoor` omitted and `lbPortOverrides` empty. No-arg to match
 * cdk-local's bundled `serviceStrategy()` signature exactly — start-service
 * has no per-invocation options that branch the strategy shape (unlike
 * `albStrategy(options)`, which threads `--lb-port` parses into
 * `lbPortOverrides`).
 */
export function serviceStrategy(): EmulatorStrategy {
  return {
    pickEntries: (stacks) => listTargets(stacks).ecsServices,
    pickerMessage: 'Select one or more ECS services to run',
    pickerNoun: 'ECS services',
    onMissing: () =>
      new LocalStartServiceError(
        `${getEmbedConfig().cliName} start-service requires at least one <target>. ` +
          "Pass one or more service paths like 'Stack/Orders' 'Stack/Frontend', " +
          'or run it in a TTY to pick interactively.'
      ),
    resolveBoots: (_stacks, chosenTargets) => ({
      boots: chosenTargets.map((target): ServiceBoot => ({ target })),
      warnings: [],
    }),
    lbPortOverrides: {},
    // Opt into the shared engine's `--watch` reload pathway (Phase 1-4 of
    // cdk-local#214 — per-replica rolling deploy + Phase 4 bind-mount
    // source fast path). Without this flag the engine's
    // `options.watch === true && strategy.supportsWatch === true` block
    // is gated off and `--watch` is silently a no-op. Mirrors cdk-local's
    // own `serviceStrategy` (the bundled `cdkl start-service`).
    supportsWatch: true,
  };
}

/**
 * `cdkl start-service <Stack/Service>...` — run one or more `AWS::ECS::Service`
 * resources locally as a long-running emulator. Spins up DesiredCount task
 * replicas per service (clamped by --max-tasks) using the same per-task
 * docker network + metadata sidecar pattern as `cdkd local run-task`, then
 * keeps each replica running and restarts it on exit per --restart-policy.
 * ^C tears every replica + sidecar + network down. When two or more
 * <target>s are supplied, every service is booted into a shared Cloud Map /
 * Service Connect registry so peer services discover each other via docker
 * --add-host overlay (Issue #460).
 */
export function createLocalStartServiceCommand(): Command {
  // cdkd's `createLocalCommand` (in local-invoke.ts) sets `CDKD_EMBED_CONFIG`
  // once for the whole `cdkd local` command tree, so this factory must NOT
  // call `setEmbedConfig` itself — doing so would clobber cdkd's branding
  // back to cdk-local's `cdkl` defaults.
  const cmd = new Command('start-service')
    .description(
      'Run one or more AWS::ECS::Service resources locally as a long-running emulator. Spins up ' +
        'DesiredCount task replicas per service (clamped by --max-tasks) using the same per-task ' +
        'docker network + metadata sidecar pattern as `cdkd local run-task`, then keeps each ' +
        'replica running and restarts it on exit per --restart-policy. ^C tears every replica + ' +
        'sidecar + network down. Each <target> accepts a CDK display path (MyStack/MyService) ' +
        'or stack-qualified logical ID (MyStack:MyServiceXYZ); single-stack apps may omit the ' +
        'stack prefix. When two or more <target>s are supplied, every service is booted into a ' +
        'shared Cloud Map / Service Connect registry so peer services discover each other via ' +
        'docker --add-host overlay (Issue #460). Omit <targets> in an interactive terminal to ' +
        'multi-select the ECS services from a list.'
    )
    .argument(
      '[targets...]',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ECS::Service resources to run (omit to multi-select interactively in a TTY)'
    )
    .addOption(
      new Option(
        '--from-state',
        "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
          'Fn::ImportValue / Fn::GetStackOutput intrinsics in container images, environment ' +
          'variables, secrets, role ARNs, and volumes. Mutually exclusive with --from-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--state-bucket <bucket>',
        'S3 bucket for --from-state. Falls back to CDKD_STATE_BUCKET env or cdk.json context.cdkd.stateBucket.'
      )
    )
    .addOption(
      new Option('--state-prefix <prefix>', 'S3 key prefix for --from-state state files.').default(
        'cdkd'
      )
    )
    .action(
      withErrorHandling(async (targets: string[], options: LocalStartServiceOptions) => {
        await runEcsServiceEmulator(targets, options, serviceStrategy(), cdkdExtraStateProviders);
      })
    );

  addStartServiceSpecificOptions(cmd);
  return addCommonEcsServiceOptions(cmd);
}
