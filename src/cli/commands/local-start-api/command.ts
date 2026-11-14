import { rmSync } from 'node:fs';
import { pasteableCommand, proseQuoted } from '../../../utils/pasteable-command.js';
import { createWatchPredicates, resolveWatchConfig } from 'cdk-local/internal';
import {
  parseContextOptions,
  normalizeStartApiAssumeRole,
  warnIfDeprecatedRegion,
} from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  activateLocalAwsAndRoleArn,
  profileCredentialsForWorkload,
} from '../../../local/local-aws-wiring.js';
import { explicitRoleArnOrThrow } from '../../../utils/role-arn.js';
import { checkEmulateRoleVia } from '../../options/emulate-role-via.js';
import {
  Synthesizer,
  synthesisStatusMessage,
  type SynthesisOptions,
} from '../../../synthesis/synthesizer.js';
import { refuseFailedLookups } from '../../../synthesis/failed-lookups.js';
import { resolveApp } from '../../config-loader.js';
import { isCfnFlagPresent } from '../local-state-source.js';
import { canonicalizeRegion } from '../../../utils/aws-partition.js';
import { namedEnvAwsRegion } from '../../../utils/emulator-default-region.js';
import { foldRegionOption } from '../../region-options.js';
import { resolveRuntimeImage } from '../../../local/runtime-image.js';
import { ensureDockerAvailable, pullImage } from '../../../local/docker-runner.js';
import { discoverRoutes } from '../../../local/route-discovery.js';
import { discoverWebSocketApis } from '../../../local/websocket-route-discovery.js';
import {
  createContainerPool,
  type ContainerSpec,
  type ContainerPool,
} from '../../../local/container-pool.js';
import {
  availableApiIdentifiers,
  filterRoutesByApiIdentifier,
} from '../../../local/api-server-grouping.js';
import { describeStack } from '../../stack-matcher.js';
import { createFileWatcher, type FileWatcher } from '../../../local/file-watcher.js';
import { attachAuthorizers } from '../../../local/authorizer-resolver.js';
import type { AuthorizerCache } from '../../../local/authorizer-cache.js';
import { createJwksCache } from '../../../local/cognito-jwt.js';
import { defaultCredentialsLoader, type CredentialsLoader } from '../../../local/sigv4-verify.js';
import { singleFlight } from '../../../utils/single-flight.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  writeProfileCredentialsFile,
  type ProfileCredentialsFile,
} from '../local-profile-credentials-file.js';
import { formatAuthority } from '../../../utils/url-authority.js';
import type { LocalStartApiOptions, NextStateMaterial } from './types.js';
import { bootServers } from './boot-servers.js';
import {
  targetStackHint,
  pickTargetStacks,
  tryEmitFromCfnRedundancyTipOnce,
  installFatalShutdownHandlers,
} from './targets.js';
import { assertServedLogicalIdsUnambiguous } from './served-lambdas.js';
import { prewarmJwks, warnVpcConfigLambdas, warnIamRoutes } from './startup-warnings.js';
import { dynamicReferenceSpecOptions } from './assume-role.js';
import { buildContainerSpec } from './container-spec.js';
import { readEnvOverridesFile } from './env.js';
import { resolveProfileCredentials, forceExitShutdownWarning } from './credentials.js';
import {
  attachStageContextPerStack,
  buildCorsConfigByStack,
  buildServedLambdaSpecs,
  printPerServerRouteTables,
  warnUnsupportedRoutes,
  warnSsrfRiskyIntegrations,
} from './servers.js';
import { reloadAllServers } from './reload.js';
import { loadStateForRoutedStacks, type StackStateBundle } from './state.js';
import { parseDebugPort, parsePerLambdaConcurrency } from './flags.js';

/**
 * The `Server listening on <url>  (<label>)` ready banner. Integ fixtures
 * grep this prefix and read the port out of it, and users paste the URL into
 * curl / `wscat`, so an IPv6 host must be bracketed or the URL does not parse.
 */
export function formatServerListeningBanner(
  scheme: string,
  host: string,
  port: number,
  pathSuffix: string,
  label: string
): string {
  return `Server listening on ${scheme}://${formatAuthority(host, port)}${pathSuffix}  (${label})\n`;
}

/**
 * `cdkd local start-api` — long-running local HTTP server that maps
 * synthesized API routes to Lambda invocations against the AWS Lambda
 * Runtime Interface Emulator (Docker required).
 *
 * Modeled on `sam local start-api` but reusing cdkd's synthesis /
 * route-discovery / container plumbing. PR 8a scope:
 *   - REST v1 (AWS::ApiGateway::*) + HTTP API (AWS::ApiGatewayV2::*) +
 *     Function URL (AWS::Lambda::Url).
 *   - AWS_PROXY integrations only.
 *
 * PR 8b additions:
 *   - Authorizers: REST v1 Lambda TOKEN/REQUEST + Cognito User Pool;
 *     HTTP v2 Lambda REQUEST + JWT. Allow → claims/context flow into
 *     `event.requestContext.authorizer`. Deny → 401/403 written without
 *     invoking the route handler. Cognito / JWT verification falls back
 *     to pass-through mode when the JWKS endpoint is unreachable.
 *   - VPC-config Lambdas surface a startup warn line: the local
 *     container does NOT get attached to the deployed VPC.
 *
 * PR 8c additions (issue #235):
 *   - `--watch` enables hot reload on CDK app source-tree changes (re-synth on edit).
 *   - HTTP API v2 OPTIONS preflight is intercepted when the API has a
 *     `CorsConfiguration`; REST v1 CORS (Mock OPTIONS method) stays
 *     out of scope.
 *   - `event.stageVariables` is populated from the selected Stage's
 *     `Variables` / `StageVariables` map. `--stage <name>` selects a
 *     specific Stage by name; default is the first Stage attached.
 *
 * Still deferred: WebSocket APIs.
 *
 * See [docs/cli-reference.md](../../../docs/cli-reference.md) for the
 * full surface and out-of-scope items.
 */
export async function localStartApiCommand(
  target: string | undefined,
  options: LocalStartApiOptions
): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }
  // Issue #1795: fold `--region` ONCE, at the boundary, so every downstream
  // SDK client sees the canonical spelling (AWS SDK endpoint resolution is
  // case-sensitive, so a raw `--region CN-NORTH-1` reached the COMMERCIAL
  // endpoint). The pseudo-parameter resolver folds again from its own four
  // sources; double-folding is a no-op.
  //
  // Issue #2103: `foldRegionOption` folds the `AWS_REGION` /
  // `AWS_DEFAULT_REGION` env vars too. Folding only the flag left
  // `AWS_REGION=US-EAST-1 cdkd local start-api` handing the raw spelling to
  // every region-less SDK client this command and cdk-local's server build
  // (the SDK's own chain reads the env var directly) and to the synth
  // subprocess. This command never reaches the bootstrap-marker probe, the one
  // consumer that needs the raw env spelling (`loadBootstrapContainerRepo` is
  // `local run-task`'s), so nothing has to be captured first.
  foldRegionOption(options);
  // Issue #1836: `--stack-region` needs the same fold at the same point — its
  // raw value is COMPARED against a state record's region and is forwarded to
  // cdk-local as the CFn client's region, both case-SENSITIVE. The RAW spelling
  // is captured first so the state-record match can honor an exactly-spelled
  // region — see the fuller rationale on the identical statement in
  // `local-invoke.ts`.
  if (options.stackRegion !== undefined) {
    options.rawStackRegion = options.stackRegion;
    options.stackRegion = canonicalizeRegion(options.stackRegion);
  }

  // Resolve the API filter: positional `<target>` wins over `--api`.
  // `--api` is kept as a backward-compat alias for one release cycle —
  // every invocation that goes through it emits a deprecation warn so
  // users see the migration path before the next major bump removes it.
  let apiFilter: string | undefined = target;
  if (options.api !== undefined) {
    if (target !== undefined) {
      throw new Error(
        `Cannot specify both positional target ('${target}') and --api flag ('${options.api}'). ` +
          `Use one or the other. The positional form is preferred — '--api' is a deprecated alias.`
      );
    }
    logger.warn(
      safeMsg`[deprecated] --api '<id>' will be removed in a future major release. Use the positional argument instead: ${proseQuoted(pasteableCommand('cdkd local start-api', [{ hole: 'id' }]).command)}.`
    );
    apiFilter = options.api;
  }

  warnIfDeprecatedRegion(options);
  // Refuse a malformed or empty `--layer-role-arn` at boot, like
  // `--assume-role`'s parse-time refusal, rather than at the first request
  // that materializes an ARN layer (issue #2348).
  if (options.layerRoleArn !== undefined) {
    explicitRoleArnOrThrow('--layer-role-arn', options.layerRoleArn);
  }
  checkEmulateRoleVia(options.emulateRoleVia, {
    roleFlag: '--assume-role or --assume-role-auto',
    roleRequested: options.assumeRole !== undefined || options.assumeRoleAuto === true,
  });
  // BEFORE `--role-arn` and every AWS client: under `--aws-emulator` the
  // role hop, `--from-state`, `{{resolve:...}}` and `--from-cfn-stack` all
  // follow the emulator (`local-aws-wiring.ts`).
  await activateLocalAwsAndRoleArn(options);

  // Issue #256 Option 1: compose `--assume-role` (value-form
  // accumulator) and the separate `--assume-role-auto` boolean flag
  // into the single `AssumeRoleOption` every downstream resolver
  // consumes. Also enforces the mutual-exclusion guard (global ARN +
  // auto-resolve both occupy the "default for every other Lambda"
  // slot) — throws here at boot, before any synth / docker work.
  const normalizedAssumeRole = normalizeStartApiAssumeRole(
    options.assumeRole,
    options.assumeRoleAuto ?? false
  );
  if (normalizedAssumeRole === undefined) {
    delete options.assumeRole;
  } else {
    options.assumeRole = normalizedAssumeRole;
  }

  await ensureDockerAvailable();

  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error('No CDK app specified. Pass --app, set CDKD_APP, or add "app" to cdk.json.');
  }

  const overrides = readEnvOverridesFile(options.envVars);
  const debugPortBase = options.debugPortBase ? parseDebugPort(options.debugPortBase) : undefined;
  const perLambdaConcurrency = parsePerLambdaConcurrency(options.perLambdaConcurrency);
  // Track every tmpdir created by `materializeInlineCode` so the
  // graceful-shutdown path removes them. Long-running servers (this
  // command) would otherwise leak one tmpdir per inline-`Code.ZipFile`
  // Lambda per server invocation. Hot reload writes new tmpdirs into
  // the same set so the shutdown path is the single owner of cleanup.
  const inlineTmpDirs = new Set<string>();
  // PR 6 (#232): track every tmpdir created by layer merging too —
  // `materializeLambdaLayers(...)` produces one merged tmpdir per
  // Lambda whose `Properties.Layers` contains 2+ entries (single-
  // layer Lambdas bind-mount the layer's asset dir directly).
  // Cleaned up alongside `inlineTmpDirs` in `shutdown(...)`. Hot
  // reload (PR 8c) reuses this same set across reload firings; on
  // each `synthesizeAndBuild` re-run we record the new merged
  // tmpdirs (the previous iteration's entries stay behind until
  // shutdown — a follow-up PR can prune them per-reload, but the
  // shutdown path is the single owner of cleanup so leaks are
  // bounded by server lifetime).
  const layerTmpDirs = new Set<string>();
  // Issue #2 deferred from #655: synthesized AWS shared credentials
  // file bind-mounted into every Lambda container so handlers using
  // `fromIni({ profile })` explicitly resolve to the same creds as the
  // default chain. Created ONCE at server boot (NOT on hot reload —
  // re-resolving profile creds is fine for env vars but rewriting the
  // file mid-flight would race with running containers' SDK reads).
  // Disposed in the cleanup chain. Undefined when `--profile` is unset.
  let profileCredsFile: ProfileCredentialsFile | undefined;
  // That file's PATH, assigned the instant its tmpdir exists rather than when
  // the write resolves (go-to-k/cdkd#3435 review). The assignment below sits
  // behind an `await`, and a second `Ctrl-C` inside it force-exits with
  // `profileCredsFile` still `undefined` while the mode-0600 directory is
  // already on disk -- the window in which the force-exit warning would name
  // nothing. Cleared only by `onDirRemoved`, i.e. when a FAILED write already
  // took the directory: the warning's job is to name what dispose did NOT
  // remove, so a successful dispose deliberately leaves it set -- only a
  // force-exit, which skips dispose, ever reads it.
  let credsHostPath: string | undefined;
  // PR 8b: per-server-lifecycle caches. Constructed once at server
  // startup; persisted across hot reloads (PR 8c) so authorizer
  // verdicts and JWKS keys aren't re-fetched on every reload. The
  // jwksWarnedAt Map (URL -> last-warned epoch ms) drives cdk-local's
  // per-time-window pass-through warn dedup (cdk-local #252): the warn
  // re-fires only once the window elapses, instead of once-ever-per-URL.
  //
  // One authorizer-verdict cache PER STACK (#5181): cdk-local keys a verdict
  // by the authorizer's bare logical id and the identity, so two served
  // stacks reusing an authorizer construct id would answer one stack's
  // request with the other's cached Allow.
  const authorizerCaches = new Map<string, AuthorizerCache>();
  const jwksCache = createJwksCache();
  const jwksWarnedAt = new Map<string, number>();
  // #447: SigV4 verifier state for `AuthorizationType: 'AWS_IAM'` routes.
  // The credentials loader is constructed eagerly but the credential
  // chain itself is only hit on the first IAM-protected request — see
  // `defaultCredentialsLoader` for the caching contract.
  let sigV4CredentialsLoader: CredentialsLoader | undefined;
  const sigV4WarnedForeignIds = new Set<string>();
  // One-shot guard for the `--from-cfn-stack <name>` redundancy tip
  // (improvement A). `synthesizeAndBuild` runs on every `--watch` hot
  // reload firing, so without this flag the tip would re-emit on every
  // reload — noisy. The flag flips on the first emission and stays
  // `true` for the rest of the server lifetime; subsequent reloads see
  // the gate and skip the emission. Per-`localStartApiCommand`-invocation
  // (new server boot starts with a fresh `false`).
  const fromCfnTipEmitted: { value: boolean } = { value: false };

  /**
   * One synth + discover + build pass. Returns the next-state
   * material. Reused on initial boot AND every hot-reload firing.
   * Failures bubble up — the orchestrator catches them and keeps the
   * old state; the initial boot lets them propagate so the CLI exits
   * with a clear error before "Server listening" is ever printed.
   *
   * PR 8b: also runs `attachAuthorizers` after route discovery so the
   * resulting `RouteWithAuth[]` carries every route's authorizer info.
   * Hot reload picks up authorizer-config changes via this re-run.
   */
  const synthesizeAndBuild = async (): Promise<NextStateMaterial> => {
    logger.info(synthesisStatusMessage(appCmd, 'Synthesizing CDK app...'));
    const synthesizer = new Synthesizer();
    const context = parseContextOptions(options.context);
    const synthOpts: SynthesisOptions = {
      app: appCmd,
      output: options.output,
      ...(options.region && { region: options.region }),
      ...(options.profile && { profile: options.profile }),
      ...(Object.keys(context).length > 0 && { context }),
      // Threaded so the macro-expander has a real state bucket for the
      // > 51,200-byte template upload path when a stack carries a
      // CloudFormation macro (Issue #463).
      ...(options.stateBucket && { stateBucket: options.stateBucket }),
      ...(options.profile && { macroExpandS3ClientOpts: { profile: options.profile } }),
      failedLookupsCheckedByCaller: true,
    };
    const { stacks, failedLookups } = await synthesizer.synthesize(synthOpts);

    // When the user passes an explicit `--from-cfn-stack <name>` AND has
    // not also passed `--stack`, infer the synth target from the CFn
    // stack name — typical CDK apps deploy each stack under its own
    // stack-name, so the same value selects the synth target unambiguously.
    // `--from-cfn-stack` without a value (bare flag => `true`) is left to
    // the regular single-stack auto-pick path.
    const cfnStackFallback =
      typeof options.fromCfnStack === 'string' ? options.fromCfnStack : undefined;
    // Improvement B: positional target prefix → synth stack inference.
    // `cdkd local start-api MyStack/MyApi` (no `--stack`, no `--from-cfn-stack`)
    // extracts `MyStack` from the target's `<StackName>/<construct>`
    // shape and uses it as a third fallback for stack selection. Targets
    // without a `/` separator (bare logical id) leave this undefined so
    // the existing single-stack auto-pick path is untouched.
    const targetStackPrefix = targetStackHint(target, stacks);
    const targetStacks = pickTargetStacks(
      stacks,
      options.stack,
      cfnStackFallback,
      targetStackPrefix
    );
    if (targetStacks.length === 0) {
      throw new Error(
        "No stacks matched. Pass --stack '<name>' (or --from-cfn-stack '<name>') or run from a single-stack app."
      );
    }
    // A failed context lookup blocks only the stacks it serves (go-to-k/cdkd#5807).
    refuseFailedLookups(targetStacks, stacks, failedLookups);

    // Improvement A: when the user passed `--from-cfn-stack <explicit>`
    // AND that value already equals the routed stack's `stackName`, the
    // explicit value is redundant — the bare-flag form auto-resolves to
    // the same value. Surface a single info-level tip so the user knows
    // they can drop the value next time. Skipped on multi-stack runs
    // (too many edge cases to keep the message useful).
    //
    // `synthesizeAndBuild` re-runs on every `--watch` hot reload firing,
    // so the emission is gated by `fromCfnTipEmitted.value` (one-shot per
    // server lifetime) — see `tryEmitFromCfnRedundancyTipOnce`.
    const routedStackNames = targetStacks.map((s) => s.stackName);
    tryEmitFromCfnRedundancyTipOnce(
      options.fromCfnStack,
      routedStackNames,
      fromCfnTipEmitted,
      (routedStackName) => {
        logger.info(
          `tip: --from-cfn-stack value matches the routed stack name (${routedStackName}); you can omit the value: \`cdkd local start-api ... --from-cfn-stack\` (bare flag) resolves to the same value.`
        );
      }
    );

    const routes = discoverRoutes(targetStacks);
    // #462: WebSocket APIs (ProtocolType: 'WEBSOCKET') are discovered
    // through a sibling pipeline so the resulting routes (keyed by
    // RouteKey rather than by method+path) stay structurally separate
    // from the HTTP / REST / Function URL `DiscoveredRoute[]`. Errors
    // are aggregated into the same boot-time warn pass so a malformed
    // WebSocket API does not abort sibling HTTP API boot.
    const wsDiscovery = discoverWebSocketApis(targetStacks);
    if (wsDiscovery.errors.length > 0) {
      for (const e of wsDiscovery.errors) {
        logger.warn(`WebSocket discovery: ${e}`);
      }
    }
    const webSocketApis = wsDiscovery.apis;
    if (routes.length === 0 && webSocketApis.length === 0) {
      throw new Error(
        'No supported API routes were discovered. cdkd local start-api supports AWS::ApiGateway::* (REST v1), AWS::ApiGatewayV2::* (HTTP + WebSocket), and AWS::Lambda::Url (Function URL) with AWS_PROXY integrations only.'
      );
    }

    // PR 8c: stage selection + variable injection. Build the per-API
    // Stage map for every target stack and attach it to the routes.
    // Stage selection is `--stage <name>` global override, otherwise
    // first-attached default. The CLI surfaces a warn line when
    // `--stage` was passed and at least one API doesn't have a Stage
    // with that name.
    //
    const missingApis = attachStageContextPerStack(targetStacks, routes, options.stage);
    for (const apiId of missingApis) {
      logger.warn(
        `--stage '${options.stage}' did not match any Stage on API '${apiId}'; routes on that API will get stageVariables: null.`
      );
    }

    // PR 8b: attach authorizer info to every route. Routes without an
    // authorizer pass through as `{route, authorizer: undefined}`.
    // Routes referencing an unsupported authorizer kind hard-fail here.
    let routesWithAuth = attachAuthorizers(targetStacks, routes);

    // Issue #260: target filter — restrict the discovered surface to a
    // single API. Useful when the user wants exactly one server (e.g. to
    // free other ports, or to focus testing on one API).
    //
    // Strict multi-stack rejection for the bare-logical-id form (no `:`,
    // no `/`): mirrors `cdkd local invoke` / `cdkd local run-task`'s
    // resolver behavior. A bare id in a multi-stack app is ambiguous,
    // because two stacks can legitimately have the same logical id —
    // pre-PR the filter would silently match both and collide in
    // `groupRoutesByServer`'s serverKey (now disambiguated via PR 8d).
    // We reject upfront with the same disambiguation hint invoke uses.
    if (apiFilter !== undefined) {
      const isBareId = !apiFilter.includes(':') && !apiFilter.includes('/');
      if (isBareId && targetStacks.length > 1) {
        throw new Error(
          `Multiple stacks in app, target '${apiFilter}' is missing a stack prefix. ` +
            `Use 'StackName:${apiFilter}' or 'StackName/${apiFilter}' (Construct path form). ` +
            `Available stacks: ${targetStacks.map(describeStack).join(', ')}.`
        );
      }
      const filtered = filterRoutesByApiIdentifier(routesWithAuth, apiFilter);
      if (filtered.length === 0) {
        const available = availableApiIdentifiers(routesWithAuth).join(', ') || '(none)';
        throw new Error(
          `Target '${apiFilter}' did not match any discovered API. Available identifiers: ${available}.`
        );
      }
      routesWithAuth = filtered;
    }

    // A union of stacks (`--stack` with a wildcard) is served through maps
    // keyed by (stack, logical id), so stacks reusing a construct id each
    // serve their own Lambda, Stage and CORS (#5181). Refused: two stacks
    // sharing a physical name (#5175), and a bare logical id the user passed
    // that more than one served stack declares. Checked over the same
    // population those maps read: every target stack, every discovered route.
    assertServedLogicalIdsUnambiguous(targetStacks, routes, routesWithAuth, webSocketApis, {
      ...(options.assumeRole !== undefined && { assumeRole: options.assumeRole }),
      ...(overrides !== undefined && { overrides }),
    });

    // PR 8c: per-API CORS config. HTTP API v2's `CorsConfiguration` +
    // Function URL's own `Cors` (issue #644) + CORS borrowed from
    // CloudFront ResponseHeadersPolicy when a CloudFront Distribution
    // fronts the Function URL (issue #646 — production-correct CDK
    // pattern where CORS is on the edge, not the origin). REST v1
    // OPTIONS Mock integrations stay out of scope.
    //
    // Merge order: direct map last → Function URL's own `Cors` block
    // wins over a CloudFront-borrowed config when both exist (matches
    // AWS semantics: Function URL's own headers apply at the Lambda
    // boundary; we only have one slot locally, so closer-to-Lambda
    // wins). The two rarely coexist in practice.
    //
    // One map per stack (#5181): a server reads its own stack's, so two
    // stacks reusing an API construct id each keep their own CORS.
    const corsConfigByStack = buildCorsConfigByStack(targetStacks);

    // `--from-state` / `--from-cfn-stack` (issue #606): load deployed
    // state for every routed stack once per synth (= initial boot AND
    // every hot-reload firing). We do this outside the per-Lambda loop
    // so a stack with N reachable Lambdas only pays one state-load
    // round-trip. Pseudo parameters are also resolved once per stack —
    // STS GetCallerIdentity is account-wide so the bag is identical
    // across same-region stacks, but the partition / URL suffix can
    // differ if stacks span partitions. Per-stack failures degrade to
    // warn-and-fall-back (the PR 1 behavior is preserved) so a missing
    // or unreadable state file never aborts the server boot.
    const stateSourceActive = options.fromState || isCfnFlagPresent(options);
    const stateByStack = stateSourceActive
      ? await loadStateForRoutedStacks(targetStacks, routes, routesWithAuth, options)
      : new Map<string, StackStateBundle>();

    // Issue #654: resolve `--profile <p>` to a concrete credential set
    // ONCE at boot for forwarding into every Lambda container that
    // doesn't have its own `--assume-role`. Drives the SDK's default
    // credential provider chain (SSO / IAM Identity Center / fromIni /
    // role-assumption profiles all handled uniformly — same chain that
    // already resolves `--profile` for cdkd's own CFn / CC API clients).
    // Resolved here so a stack with N Lambdas pays one STS round-trip.
    // SSO temp creds typically last 1h+; long-running `--watch` sessions
    // outliving the creds need a cdkd restart (auto-refresh deferred,
    // see issue #654).
    // Under `--aws-emulator` the container gets the emulator's keys only, so
    // the real `--profile` is neither resolved nor written to a file.
    const profileCredentials = await profileCredentialsForWorkload(
      options.profile,
      resolveProfileCredentials
    );

    // Issue #2 deferred from #655: when `--profile <p>` is set, ALSO
    // synthesize a shared AWS credentials file with the resolved creds
    // under `[<p>]` and bind-mount it into every Lambda container at
    // `/cdkd-aws/credentials`. This lets handlers that use
    // `fromIni({ profile: '<p>' })` explicitly inside their code (instead
    // of the default credential chain) resolve to the same creds locally.
    // The default-chain path (most handlers) keeps working through the
    // existing `AWS_*` env-var injection — the file is the additive
    // layer for the explicit-profile case.
    //
    // Caveat: under `--watch` hot reload, `profileCredentials` re-resolves
    // and the new env vars flow to the next cold start, but the on-disk
    // file is NOT re-written. Long-running sessions whose SSO temp creds
    // expire need a cdkd restart (matches the auto-refresh-deferred
    // stance for env vars from #655).
    //
    // Assigned to outer-scope `profileCredsFile` so the cleanup chain
    // (`runCleanup`) disposes the file at shutdown. Only ever assigned
    // on the FIRST synthesizeAndBuild (initial server boot) — hot
    // reload sees the variable already set and skips re-writing per
    // the caveat above.
    // cdkd-local-env-identity: `--profile`, resolved by
    // `resolveProfileCredentials` through
    // `awsClientDefaults({ ignoreAssumedRole: true })` — the caller's own chain,
    // never the `--role-arn` role. The same identity the env-var overlay writes;
    // the mounted file is the additive channel for `fromIni({ profile })`.
    if (options.profile && profileCredentials && !profileCredsFile) {
      profileCredsFile = await writeProfileCredentialsFile(options.profile, profileCredentials, {
        onDirCreated: (hostPath) => {
          credsHostPath = hostPath;
        },
        onDirRemoved: () => {
          credsHostPath = undefined;
        },
      });
    }

    // Build the per-Lambda spec map. Every reachable logical ID is
    // resolved to its asset / inline code, env vars, optional STS creds
    // (--assume-role), optional --debug-port reservation. The container
    // pool then knows everything it needs to lazy-start a fresh one.
    // Authorizer Lambdas are also pooled — they're invoked just like
    // route handlers (PR 8b).
    //
    // Keyed by (stack, logical id) and resolved against the route's OWN
    // stack (#5181), so two stacks reusing a construct id each get a spec of
    // their own Lambda.
    const specs = await buildServedLambdaSpecs(
      targetStacks,
      routes,
      routesWithAuth,
      webSocketApis,
      ({ logicalId, stacks, index }) =>
        buildContainerSpec({
          logicalId,
          stacks,
          overrides,
          assumeRole: options.assumeRole,
          containerHost: options.containerHost,
          ...(debugPortBase !== undefined && { debugPort: debugPortBase + index }),
          // Issue #1843: folded at the read as well as at the handler entry, the
          // same shape as `local-invoke.ts`'s STS chain. It seeds the per-Lambda
          // AssumeRole STS client and the container's own `AWS_REGION`. The
          // `--aws-emulator` run's default region is left to
          // `resolveContainerRegion`, which ranks it below the stack's and the
          // state record's (go-to-k/cdkd#6270).
          stsRegion: canonicalizeRegion(
            options.region ?? namedEnvAwsRegion() ?? process.env['AWS_DEFAULT_REGION']
          ),
          inlineTmpDirs,
          layerTmpDirs,
          stateByStack,
          stateSourceActive,
          skipPull: options.pull === false,
          ...(options.layerRoleArn !== undefined && { layerRoleArn: options.layerRoleArn }),
          ...(options.emulateRoleVia !== undefined && { emulateRoleVia: options.emulateRoleVia }),
          ...(profileCredentials && { profileCredentials }),
          ...(profileCredsFile && { profileCredsFile }),
          ...dynamicReferenceSpecOptions(options),
        })
    );

    // Pull every distinct base image up front so the first request
    // doesn't pay the layer-pull cost. Mirrors `cdkd local invoke`'s
    // pull pass. Only the ZIP branch needs a base-image pull here —
    // IMAGE-variant specs already have their per-Lambda image
    // resolved by `buildContainerSpec` (`resolveContainerImageForStartApi`
    // ran the local build or ECR pull before this point), so the
    // ContainerPool can `docker run` against it without any further
    // pull step.
    const distinctImages = new Set<string>();
    for (const spec of specs.values()) {
      if (spec.kind === 'zip') {
        distinctImages.add(resolveRuntimeImage(spec.lambda.runtime));
      }
    }
    for (const image of distinctImages) {
      await pullImage(image, options.pull === false);
    }

    return {
      routes: routesWithAuth,
      specs,
      corsConfigByStack,
      webSocketApis,
      stacks: targetStacks,
    };
  };

  /**
   * Helper: build a {@link ContainerPool} from a spec map and tag it
   * with the spec map (via the non-enumerable `__cdkdSpecs` property)
   * so the reload orchestrator can compute spec diffs.
   */
  const buildPool = (specs: Map<string, ContainerSpec>): ContainerPool => {
    const pool = createContainerPool(specs, {
      perLambdaConcurrency,
      skipPull: options.pull === false,
    });
    Object.defineProperty(pool, '__cdkdSpecs', {
      value: specs,
      enumerable: false,
      configurable: true,
    });
    return pool;
  };

  // Initial boot.
  const initialMaterial = await synthesizeAndBuild();

  // PR 8b: pre-warm JWKS for Cognito / JWT authorizers so the first
  // request doesn't pay the fetch latency. Failures fall through to
  // pass-through mode with the warn line documented in cognito-jwt.ts.
  await prewarmJwks(initialMaterial.routes, jwksCache);

  // PR 8b: VPC-config Lambdas warn at startup. cdkd does NOT block
  // these routes, but the developer should know the local container
  // reaches external services via the host's network rather than
  // through the deployed VPC's NAT / private subnets. Re-runs on hot
  // reload would be noisy; we emit this once at initial boot only.
  warnVpcConfigLambdas(initialMaterial.routes, initialMaterial.stacks);

  // #447: AWS_IAM-protected routes warn at startup. The local server
  // verifies SigV4 signatures only — IAM policy evaluation (resource /
  // action / condition) is NOT emulated.
  //
  // The credentials loader is ALWAYS constructed at boot (not gated on
  // the initial template having IAM routes) so that hot-reload
  // (`--watch`) paths that ADD a new IAM route after boot have the
  // loader already wired up. The loader is internally lazy
  // (`defaultCredentialsLoader()` memoizes the actual STSClient +
  // credential resolution until first call), so unused boots pay zero
  // cost. Pre-fix the loader was conditionally constructed at this
  // point only when the initial template had IAM routes, which caused
  // post-hot-reload IAM routes to hit the http-server's defensive
  // "no SigV4 credentials loader configured — denying" deny path with
  // no explanation. PR #484 review MAJOR.
  sigV4CredentialsLoader = defaultCredentialsLoader();
  warnIamRoutes(initialMaterial.routes);

  const { servers, wsServers } = await bootServers({
    options,
    logger,
    initialMaterial,
    buildPool,
    authorizerCaches,
    jwksCache,
    jwksWarnedAt,
    sigV4CredentialsLoader,
    sigV4WarnedForeignIds,
  });

  printPerServerRouteTables(servers);
  const allRoutes = servers.flatMap((s) => s.group.routes.map((r) => r.route));
  warnUnsupportedRoutes(allRoutes, logger);
  warnSsrfRiskyIntegrations(allRoutes, logger);
  logger.info(
    `Per-Lambda concurrency: ${perLambdaConcurrency} (override with --per-lambda-concurrency)`
  );
  // D8.4 — load-bearing: verify.sh greps for this exact prefix.
  // Emit one line per server so verify.sh / users can match each API to
  // its port. When mTLS is active, the scheme flips to `https://` and
  // verify.sh / users have to pass `--cacert` + `--cert` + `--key` to
  // curl; both schemes share the "Server listening on " prefix so the
  // verify.sh marker scan is unchanged.
  for (const { group, server } of servers) {
    process.stdout.write(
      formatServerListeningBanner(server.scheme, server.host, server.port, '', group.displayName)
    );
  }
  // #462: emit one banner per WebSocket server. The protocol prefix
  // is `ws://` / `wss://` rather than `http://` / `https://` so users
  // copy-paste the URL straight into `wscat -c <URL>` / browser
  // `new WebSocket(url)`.
  for (const ws of wsServers) {
    const scheme = ws.server.scheme === 'https' ? 'wss' : 'ws';
    process.stdout.write(
      formatServerListeningBanner(
        scheme,
        ws.server.host,
        ws.server.port,
        ws.apiPath,
        `${ws.api.apiLogicalId} (WebSocket API)`
      )
    );
  }
  process.stdout.write('^C to stop and clean up containers.\n');

  // PR 8c (extended for issue #260 to span N servers): hot reload
  // (`--watch`). For N-server topology we serialize re-synth ONCE per
  // watcher event, then per-server filter the material + swap state.
  // Adding/removing an entire API across a reload is not supported —
  // the user is warned and the server set stays static until restart.
  let watcher: FileWatcher | undefined;
  let reloadChain: Promise<unknown> = Promise.resolve();
  /**
   * Set once `runCleanup` begins: from then on a reload swaps in no new pool
   * (issue #4495).
   */
  let closing = false;
  /**
   * Each reload's background dispose of a swapped-out pool, while it runs.
   * `runCleanup` awaits them: its `process.exit` would otherwise end one still
   * draining in-flight requests or starts, before it removed its containers
   * (issue #4495).
   */
  const retiredPoolDisposals = new Set<Promise<void>>();
  if (options.watch) {
    // Watch the CDK app's source tree (the synth working directory, where
    // `cdk.json` lives) so editing handler / construct source re-synths and
    // hot-reloads, mirroring `cdk watch`. We honor `cdk.json`'s
    // `watch.include` / `watch.exclude`; `cdk.out` / `node_modules` / `.git`
    // are excluded so the reload's own re-synth writes never self-trigger.
    const watchRoot = process.cwd();
    const { ignored, shouldTrigger, excludePatterns } = createWatchPredicates({
      watchRoot,
      output: options.output,
      watchConfig: resolveWatchConfig(),
    });
    watcher = createFileWatcher({
      paths: [watchRoot],
      ignored,
      shouldTrigger,
      onChange: () => {
        logger.info('Detected source change; reloading...');
        const next = reloadChain.then(() =>
          reloadAllServers({
            synthesizeAndBuild,
            servers,
            buildPool,
            logger,
            isClosing: () => closing,
            retiredPoolDisposals,
          })
        );
        reloadChain = next.catch(() => undefined);
      },
    });
    logger.info(
      `Watching ${watchRoot} for source changes (excluding ${excludePatterns.join(', ')}).`
    );
  }

  // Graceful shutdown: SIGINT / SIGTERM / uncaughtException /
  // unhandledRejection all run the same dispose path. Double-^C
  // bypasses dispose and exits immediately so the user can escape a
  // hung Docker daemon.
  //
  // Single-flight contract (closes the SIGINT-during-SIGTERM /
  // double-signal race): the actual cleanup body is wrapped in
  // `singleFlight(...)` so a second signal that lands while the first
  // shutdown is still draining `pool.dispose()` awaits the same
  // promise instead of starting a parallel run against the shared
  // `servers` / `inlineTmpDirs` / `layerTmpDirs` cells (which would
  // otherwise double-`server.close()` and corrupt the
  // mid-iteration tmpdir set). The first signal's `signal` + `exitCode`
  // win — subsequent signals' arguments are intentionally dropped.
  // The double-^C force-exit feature is preserved by tracking the
  // started + completed state separately from the in-flight cleanup.
  let shutdownStarted = false;
  let firstSignal: string | undefined;
  let firstExitCode = 0;
  let forceExitArmed = false;
  const runCleanup = singleFlight(async (): Promise<void> => {
    closing = true;
    logger.info(`Received ${firstSignal}, shutting down...`);
    if (watcher) {
      try {
        await watcher.close();
      } catch (err) {
        logger.warn(`watcher.close() failed: ${describeAwsFailure(err).detail}`);
      }
    }
    // Close every server in parallel, then dispose every (possibly hot-
    // reload-swapped) pool. Each pool's dispose() waits for in-flight
    // requests to drain; running them in parallel is the right shape
    // even for N servers because shutdown is signalled to all at once.
    //
    // WebSocket-server shutdown layers on top: each
    // `AttachedWebSocketServer.close()` sends close-frame 1001 (going
    // away) to every live socket BEFORE we kill the underlying http
    // server, so the client sees a clean close instead of a
    // mid-frame disconnect.
    await Promise.allSettled(
      wsServers.map(async (ws) => {
        try {
          await ws.attached.close();
        } catch (err) {
          logger.warn(
            `WebSocket close() failed for ${ws.api.apiLogicalId}: ${describeAwsFailure(err).detail}`
          );
        }
      })
    );
    await Promise.allSettled(
      servers.map(async ({ server, group }) => {
        try {
          await server.close();
        } catch (err) {
          logger.warn(
            `server.close() failed for ${group.displayName}: ${describeAwsFailure(err).detail}`
          );
        }
      })
    );
    await Promise.allSettled(
      wsServers.map(async (ws) => {
        try {
          await ws.server.close();
        } catch (err) {
          logger.warn(
            `WebSocket server.close() failed for ${ws.api.apiLogicalId}: ${describeAwsFailure(err).detail}`
          );
        }
      })
    );
    await Promise.allSettled(
      servers.map(async ({ server, group }) => {
        try {
          await server.getServerState().pool.dispose();
        } catch (err) {
          logger.warn(
            `pool.dispose() failed for ${group.displayName}: ${describeAwsFailure(err).detail}`
          );
        }
      })
    );
    // A pool a `--watch` reload swapped out may still be draining.
    if (retiredPoolDisposals.size > 0) {
      logger.info(
        safeMsg`Waiting for ${retiredPoolDisposals.size} container pool(s) replaced by a reload to finish tearing down...`
      );
      await Promise.allSettled([...retiredPoolDisposals]);
    }
    await Promise.allSettled(
      wsServers.map(async (ws) => {
        try {
          await ws.server.getServerState().pool.dispose();
        } catch (err) {
          logger.warn(
            `WebSocket pool.dispose() failed for ${ws.api.apiLogicalId}: ${describeAwsFailure(err).detail}`
          );
        }
      })
    );
    // Remove every tmpdir we materialized inline `Code.ZipFile` Lambdas
    // into. Each is `mkdtempSync(...)` under the OS tmpdir, so the only
    // owner of cleanup is this process. Best-effort: log + continue on
    // any per-dir failure.
    for (const dir of inlineTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove inline-code tmpdir ${dir}: ${describeAwsFailure(err).detail}`
        );
      }
    }
    for (const dir of layerTmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(
          `Failed to remove merged-layers tmpdir ${dir}: ${describeAwsFailure(err).detail}`
        );
      }
    }
    // Issue #2 deferred from #655: dispose the synthesized profile
    // credentials file (one INI file under `/tmp/cdkd-profile-creds-*/`).
    // Leaving temp credential files on disk after process exit is a
    // security smell; `dispose()` rm's the tempdir recursively + force,
    // so re-entrant calls (signal-mid-finally race) are safe.
    if (profileCredsFile) {
      try {
        await profileCredsFile.dispose();
      } catch (err) {
        logger.warn(
          `Failed to remove profile credentials tmpdir ${profileCredsFile.hostPath}: ${describeAwsFailure(err).detail}`
        );
      }
    }
  });
  const shutdown = async (signal: string, exitCode: number): Promise<void> => {
    if (shutdownStarted) {
      if (!forceExitArmed) {
        forceExitArmed = true;
        // THE SIBLING SITE OF go-to-k/cdkd#3410, found by sweeping the class
        // rather than named by the issue: `runCleanup` is what disposes
        // `profileCredsFile`, and `process.exit` below skips it exactly as
        // `local-run-task.ts`'s force-exit arm did. This line already told the
        // operator about the ORPHAN CONTAINERS — the artifact `docker ps` can
        // find on its own — while saying nothing about the mode-0600 credentials
        // tmpdir, which nothing reports and nothing else ever removes.
        //
        // COMPOSED BY A PURE BUILDER, not inline (go-to-k/cdkd#3435 review).
        // Nothing stands this server command up in a unit test, so the only
        // fence on this arm was a source-shape rule requiring the notice
        // builder to be CALLED here — and a reviewer measured that a mutation
        // keeping the call while dropping its result from the rendered line
        // left the whole suite green, re-opening go-to-k/cdkd#3410's defect in
        // the arm this PR added. The composition is the part that has to be
        // asserted, so it moved somewhere a test can reach it.
        logger.warn(forceExitShutdownWarning(signal, credsHostPath));
        process.exit(130);
      }
      return;
    }
    shutdownStarted = true;
    firstSignal = signal;
    firstExitCode = exitCode;
    await runCleanup();
    process.exit(firstExitCode);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT', 130);
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  installFatalShutdownHandlers(logger, shutdown);

  // Block forever — the signal handlers exit the process.
  await new Promise<never>(() => undefined);
}
