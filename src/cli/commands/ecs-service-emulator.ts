/**
 * Shim: re-exports cdk-local's shared ECS service emulator engine for
 * `cdkd local start-alb` (and a future `cdkd local start-service` refactor
 * that will adopt the same shim). `runEcsServiceEmulator` is the engine
 * entry point both commands wrap; `addCommonEcsServiceOptions` is the shared
 * option-block factory; `parseMaxTasks` / `parseRestartPolicy` are option
 * parsers; `resolveSharedSidecarCredentials` / `buildEcsImageResolutionContext`
 * are pre-boot helpers; `MAX_TASKS_SUBNET_RANGE_CAP` documents the per-network
 * replica cap. The `Planned*` / `ServiceBoot` / `EmulatorStrategy` /
 * `FrontDoorPlan` types describe the engine's pre-boot plan + strategy hook
 * surface. The implementation lives in cdk-local and cdkd consumes it verbatim
 * instead of carrying a byte-identical copy. See cdk-local's
 * `src/cli/commands/ecs-service-emulator.ts`.
 */
export {
  addCommonEcsServiceOptions,
  runEcsServiceEmulator,
  parseMaxTasks,
  parseRestartPolicy,
  resolveSharedSidecarCredentials,
  buildEcsImageResolutionContext,
  MAX_TASKS_SUBNET_RANGE_CAP,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
  type ServiceBoot,
  type FrontDoorPlan,
  type PlannedAction,
  type PlannedForwardAction,
  type PlannedRedirectAction,
  type PlannedFixedResponseAction,
  type PlannedForwardTarget,
  type PlannedEcsForwardTarget,
  type PlannedLambdaForwardTarget,
  type PlannedFrontDoorListener,
} from 'cdk-local/internal';
