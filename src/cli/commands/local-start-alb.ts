import { Command, Option } from 'commander';
import { withErrorHandling, LocalStartServiceError } from '../../utils/error-handler.js';
import { listTargets, getEmbedConfig } from 'cdk-local';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import { parseEcsTarget } from '../../local/ecs-task-resolver.js';
import { resolveLambdaTarget } from '../../local/lambda-resolver.js';
import { matchStacks } from '../stack-matcher.js';
import { buildCdkPathIndex, resolveCdkPathToLogicalIds } from '../cdk-path.js';
import {
  resolveAlbFrontDoor,
  isApplicationLoadBalancer,
  type ResolvedListenerAction,
  type FrontDoorForwardTarget,
} from '../../local/elb-front-door-resolver.js';
import {
  addCommonEcsServiceOptions,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
  type EmulatorStrategy,
  type ServiceBoot,
  type PlannedAction,
  type PlannedForwardTarget,
  type PlannedFrontDoorListener,
} from './ecs-service-emulator.js';
import { cdkdExtraStateProviders } from './local-state-source.js';

/**
 * Cdkd-specific extension of cdk-local's `EcsServiceEmulatorOptions` carrying
 * the `--from-state` / `--state-bucket` / `--state-prefix` fields (cdkd's
 * S3-backed state source). cdk-local's option type already declares
 * `[key: string]: unknown`, so these fields ride through the engine and reach
 * cdkd's `fromStateFactory` (registered via `cdkdExtraStateProviders`) when
 * the engine calls `createLocalStateProvider` internally. `--from-cfn-stack`
 * + `--stack-region` are inherited from `addCommonEcsServiceOptions`.
 */
export interface LocalStartAlbOptions extends EcsServiceEmulatorOptions {
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
 * Issue #86 v1 — parse `--lb-port <listenerPort>=<hostPort>` overrides into a
 * `listenerPort -> hostPort` map. The local ALB front-door binds the listener
 * port on the host by default, but a privileged listener port (e.g. 80 / 443)
 * fails to bind as non-root on macOS, so the user opts in to a non-privileged
 * host port (e.g. `--lb-port 80=8080`). Repeatable; each value is
 * `<listenerPort>=<hostPort>` with both in 1-65535.
 */
export function parseLbPortOverrides(values: string[] | undefined): Record<number, number> {
  const out: Record<number, number> = {};
  for (const raw of values ?? []) {
    const m = /^(\d+)=(\d+)$/.exec(raw.trim());
    if (!m) {
      throw new LocalStartServiceError(
        `Invalid --lb-port '${raw}'. Expected <listenerPort>=<hostPort> (e.g. 80=8080).`
      );
    }
    const listenerPort = Number(m[1]);
    const hostPort = Number(m[2]);
    for (const [label, p] of [
      ['listener', listenerPort],
      ['host', hostPort],
    ] as const) {
      if (p < 1 || p > 65535) {
        throw new LocalStartServiceError(
          `Invalid --lb-port '${raw}': ${label} port must be 1-65535.`
        );
      }
    }
    out[listenerPort] = hostPort;
  }
  return out;
}

/**
 * Resolve an ALB target string (`Stack/Path` display path or `Stack:LogicalId`)
 * to its stack + `AWS::ElasticLoadBalancingV2::LoadBalancer` logical id. Mirrors
 * the ECS service resolver's target grammar.
 */
export function resolveAlbTarget(
  target: string,
  stacks: StackInfo[]
): { stack: StackInfo; albLogicalId: string } {
  if (stacks.length === 0) {
    throw new LocalStartServiceError('No stacks found in the synthesized assembly.');
  }
  const parsed = parseEcsTarget(target);
  const stack = pickStack(parsed.stackPattern, stacks, target);
  const resources = stack.template.Resources ?? {};

  if (parsed.isPath) {
    const index = buildCdkPathIndex(stack.template);
    const resolved = resolveCdkPathToLogicalIds(parsed.pathOrId, index);
    const albs = resolved.filter(({ logicalId }) => {
      const r = resources[logicalId];
      return r !== undefined && isApplicationLoadBalancer(r);
    });
    if (albs.length === 0) {
      throw notFound(target, stack, resources);
    }
    if (albs.length > 1) {
      throw new LocalStartServiceError(
        `Target '${target}' matches ${albs.length} load balancers in ${stack.stackName}: ` +
          `${albs.map((a) => a.logicalId).join(', ')}. Refine the path or use the stack:LogicalId form.`
      );
    }
    return { stack, albLogicalId: albs[0]!.logicalId };
  }

  const res = resources[parsed.pathOrId];
  if (!res || !isApplicationLoadBalancer(res)) {
    throw notFound(target, stack, resources);
  }
  return { stack, albLogicalId: parsed.pathOrId };
}

function pickStack(stackPattern: string | null, stacks: StackInfo[], target: string): StackInfo {
  if (stackPattern === null) {
    if (stacks.length === 1) return stacks[0]!;
    throw new LocalStartServiceError(
      `Target '${target}' has no stack prefix, and the assembly contains ${stacks.length} stacks: ` +
        `${stacks.map((s) => s.stackName).join(', ')}. Pass it as 'Stack/Path' or 'Stack:LogicalId'.`
    );
  }
  const matched = matchStacks(stacks, [stackPattern]);
  if (matched.length === 0) {
    throw new LocalStartServiceError(
      `No stack matches '${stackPattern}'. Available stacks: ${stacks.map((s) => s.stackName).join(', ')}.`
    );
  }
  if (matched.length > 1) {
    throw new LocalStartServiceError(
      `Multiple stacks match '${stackPattern}': ${matched.map((s) => s.stackName).join(', ')}. Refine the pattern.`
    );
  }
  return matched[0]!;
}

function notFound(
  target: string,
  stack: StackInfo,
  resources: Record<string, { Type: string }>
): LocalStartServiceError {
  const albs = Object.entries(resources)
    .filter(([, r]) => r.Type === 'AWS::ElasticLoadBalancingV2::LoadBalancer')
    .map(([logicalId]) => logicalId);
  const available =
    albs.length > 0
      ? ` Available load balancers in ${stack.stackName}: ${albs.join(', ')}.`
      : ` ${stack.stackName} declares no AWS::ElasticLoadBalancingV2::LoadBalancer resources.`;
  return new LocalStartServiceError(
    `Target '${target}' did not match an application Load Balancer in ${stack.stackName}.${available}`
  );
}

/**
 * `cdkl start-alb` strategy — name the ALB, boot the ECS service(s) behind it,
 * and expose each listener via a local front-door. Mirrors how `start-api`
 * names the API and serves its backing Lambdas.
 */
export function albStrategy(options: EcsServiceEmulatorOptions): EmulatorStrategy {
  const lbPortOverrides = parseLbPortOverrides(options.lbPort);
  return {
    pickEntries: (stacks) => listTargets(stacks).loadBalancers,
    pickerMessage: 'Select one or more Application Load Balancers to run',
    pickerNoun: 'Application Load Balancers',
    onMissing: () =>
      new LocalStartServiceError(
        `${getEmbedConfig().cliName} start-alb requires at least one <target>. ` +
          "Pass one or more ALB paths like 'Stack/MyAlb', or run it in a TTY to pick interactively."
      ),
    resolveBoots: (stacks, chosenTargets) => {
      const warnings: string[] = [];
      // Services to boot (deduped) + the per-listener host front-door plan.
      const serviceTargets = new Set<string>();
      const listeners: PlannedFrontDoorListener[] = [];
      // hostPort -> the listener port that claimed it (to explain a collision).
      const claimedHostPorts = new Map<number, number>();

      for (const albTarget of chosenTargets) {
        const { stack, albLogicalId } = resolveAlbTarget(albTarget, stacks);
        const resolution = resolveAlbFrontDoor(stack, albLogicalId);
        warnings.push(...resolution.warnings);

        // Qualify a resolver target into the front-door plan's target union,
        // carrying its forward weight. An ECS target becomes a `Stack:LogicalId`
        // service-boot target (and is recorded as a service we must run); a
        // Lambda target (#123) is resolved to its `ResolvedLambda` here so the
        // front-door can boot + invoke it locally (no ECS service to run for it).
        const qualifyTarget = (t: FrontDoorForwardTarget): PlannedForwardTarget => {
          if (t.kind === 'lambda') {
            const lambda = resolveLambdaTarget(`${stack.stackName}:${t.lambdaLogicalId}`, stacks);
            return {
              kind: 'lambda',
              lambda,
              // The local front-door has no real target-group ARN; surface the
              // logical id (qualified) so `requestContext.elb.targetGroupArn`
              // is stable + identifiable in handler logs.
              targetGroupArn: `${stack.stackName}:${t.targetGroupLogicalId}`,
              multiValueHeaders: t.multiValueHeaders,
              weight: t.weight,
            };
          }
          const serviceTarget = `${stack.stackName}:${t.serviceLogicalId}`;
          serviceTargets.add(serviceTarget);
          return {
            kind: 'ecs',
            serviceTarget,
            targetContainerName: t.targetContainerName,
            targetContainerPort: t.targetContainerPort,
            weight: t.weight,
          };
        };

        // Qualify a resolver action into a planned action: a forward qualifies
        // each weighted target (ECS or Lambda); redirect / fixed-response carry
        // no backing target.
        const qualify = (action: ResolvedListenerAction): PlannedAction => {
          if (action.kind === 'forward') {
            return { kind: 'forward', targets: action.targets.map(qualifyTarget) };
          }
          if (action.kind === 'redirect') {
            return {
              kind: 'redirect',
              statusCode: action.statusCode,
              ...(action.protocol !== undefined && { protocol: action.protocol }),
              ...(action.host !== undefined && { host: action.host }),
              ...(action.port !== undefined && { port: action.port }),
              ...(action.path !== undefined && { path: action.path }),
              ...(action.query !== undefined && { query: action.query }),
            };
          }
          return {
            kind: 'fixed-response',
            statusCode: action.statusCode,
            ...(action.contentType !== undefined && { contentType: action.contentType }),
            ...(action.messageBody !== undefined && { messageBody: action.messageBody }),
          };
        };

        for (const listener of resolution.listeners) {
          const hostPort = lbPortOverrides[listener.listenerPort] ?? listener.listenerPort;
          const claimedBy = claimedHostPorts.get(hostPort);
          if (claimedBy !== undefined) {
            warnings.push(
              `Listener port ${listener.listenerPort} would bind host port ${hostPort}, already ` +
                `claimed by listener port ${claimedBy}; the local front-door fronts only the ` +
                'first. Use --lb-port to remap one of them.'
            );
            continue;
          }
          claimedHostPorts.set(hostPort, listener.listenerPort);
          listeners.push({
            listenerPort: listener.listenerPort,
            hostPort,
            protocol: listener.listenerProtocol,
            ...(listener.defaultAction ? { defaultAction: qualify(listener.defaultAction) } : {}),
            ...(listener.defaultAuthGuard ? { defaultAuthGuard: listener.defaultAuthGuard } : {}),
            rules: listener.rules.map((r) => ({
              priority: r.priority,
              pathPatterns: r.pathPatterns,
              hostPatterns: r.hostPatterns,
              httpHeaderConditions: r.httpHeaderConditions,
              httpRequestMethods: r.httpRequestMethods,
              queryStringConditions: r.queryStringConditions,
              sourceIpCidrs: r.sourceIpCidrs,
              action: qualify(r.action),
              ...(r.authGuard ? { authGuard: r.authGuard } : {}),
            })),
          });
        }
      }

      const boots: ServiceBoot[] = [...serviceTargets].map((target) => ({ target }));

      // Warn about a `--lb-port <listenerPort>=...` override whose listener
      // port matched NONE of the resolved front-door listeners — almost always
      // a typo, and otherwise a silent no-op.
      const resolvedPorts = new Set(listeners.map((l) => l.listenerPort));
      for (const portStr of Object.keys(lbPortOverrides)) {
        const port = Number(portStr);
        if (!resolvedPorts.has(port)) {
          warnings.push(
            `--lb-port override for listener port ${port} matched no ALB listener resolved for ` +
              'the named target(s); it was ignored.'
          );
        }
      }

      return {
        boots,
        ...(listeners.length > 0 ? { frontDoor: { listeners } } : {}),
        warnings,
      };
    },
    lbPortOverrides,
  };
}

/**
 * `cdkl start-alb <Stack/Alb>` — Issue #86 v1. Names an
 * `AWS::ElasticLoadBalancingV2::LoadBalancer`, discovers the ECS service(s)
 * behind its HTTP `forward` listeners, boots their replicas, and stands up a
 * local front-door on each listener port that round-robins across the replicas.
 * The symmetric ALB counterpart of `start-api`.
 */
export function createLocalStartAlbCommand(): Command {
  // cdkd's `createLocalCommand` (in local-invoke.ts) sets `CDKD_EMBED_CONFIG`
  // once for the whole `cdkd local` command tree, so this factory must NOT
  // call `setEmbedConfig` itself — doing so would clobber cdkd's branding
  // back to cdk-local's `cdkl` defaults.
  const cmd = new Command('start-alb')
    .description(
      'Run an Application Load Balancer locally: name the ALB, and cdk-local boots the ECS ' +
        'service(s) behind its listeners and stands up a local front-door on each listener port ' +
        'that round-robins across the running replicas and routes its listener rules across the ' +
        'backing services — a stable host endpoint, like behind a real load balancer. The ' +
        'symmetric ALB counterpart of `start-api`. Each <target> accepts a CDK display path ' +
        '(MyStack/MyAlb) or stack-qualified logical ID; single-stack apps may omit the stack ' +
        'prefix. Supports HTTP and HTTPS listeners (TLS terminated locally with --tls-cert/' +
        '--tls-key or an auto-generated self-signed cert); all six ALB rule-condition fields ' +
        '(path-pattern / host-header / http-header / http-request-method / query-string / ' +
        'source-ip); forward (single and weighted), redirect, and fixed-response actions; and ' +
        'ECS or Lambda targets (a Lambda target group is invoked locally via the Lambda RIE). ' +
        'authenticate-cognito / authenticate-oidc actions enforce a local Bearer-JWT check ' +
        '(or AWSELBAuthSessionCookie pass-through) against the same JWKS / OIDC discovery URL ' +
        'the deployed ALB would; use --bearer-token <jwt> to inject a default token or ' +
        '--no-verify-auth to disable the guard. Omit <targets> in an interactive terminal to ' +
        'multi-select the load balancers from a list.'
    )
    .argument(
      '[targets...]',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ElasticLoadBalancingV2::LoadBalancer resources to run (omit to multi-select interactively in a TTY)'
    )
    .addOption(
      new Option(
        '--lb-port <listenerPort=hostPort...>',
        'Bind the local front-door on a specific host port (e.g. 80=8080); repeatable. ' +
          'Default: host port == ALB listener port. Use this on macOS to remap a privileged ' +
          'listener port (< 1024) to a non-privileged host port.'
      )
    )
    .addOption(
      new Option(
        '--tls-cert <path>',
        'PEM-encoded server certificate for HTTPS front-door listeners. Must be set together ' +
          'with --tls-key. Omit both flags to auto-generate a self-signed cert ' +
          '(cached under $XDG_CACHE_HOME/cdk-local/alb-https/, default ~/.cache/cdk-local/' +
          'alb-https/); requires openssl on PATH. The deployed Listener Certificates[] are NOT ' +
          'fetched (ACM private keys are not retrievable by design). The auto-generated cert ' +
          'lists DNS:localhost,IP:127.0.0.1 as SubjectAltName, so a client validating a ' +
          'non-loopback --container-host will fail the SAN check — pass --tls-cert / --tls-key ' +
          'with a SAN covering that host instead.'
      )
    )
    .addOption(
      new Option(
        '--tls-key <path>',
        'PEM-encoded server private key matching --tls-cert. Must be set together with --tls-cert.'
      )
    )
    .addOption(
      new Option(
        '--no-verify-auth',
        'Disable local enforcement of authenticate-cognito / authenticate-oidc actions. Every ' +
          'request is served as if the auth check passed. Useful for local dev where you do not ' +
          'want to mint a Bearer token at all.'
      )
    )
    .addOption(
      new Option(
        '--bearer-token <jwt>',
        'Default Bearer JWT injected as Authorization: Bearer <jwt> when the inbound request has ' +
          'none. Verified against the same JWKS / OIDC discovery URL the deployed ALB would ' +
          '(signature + iss + aud + exp). Local-dev convenience; cookie pass-through ' +
          '(AWSELBAuthSessionCookie-*) also works.'
      )
    )
    .addOption(
      new Option(
        '--from-state',
        "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
          'Fn::ImportValue / Fn::GetStackOutput intrinsics in container images, environment ' +
          'variables, secrets, role ARNs, and volumes of the ECS services behind the ALB. ' +
          'Mutually exclusive with --from-cfn-stack.'
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
      withErrorHandling(async (targets: string[], options: LocalStartAlbOptions) => {
        await runEcsServiceEmulator(
          targets,
          options,
          albStrategy(options),
          cdkdExtraStateProviders
        );
      })
    );

  return addCommonEcsServiceOptions(cmd);
}
