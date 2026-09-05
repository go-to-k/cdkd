import { Option, type Command } from 'commander';
import {
  createLocalStartCloudFrontCommand as createCdkLocalStartCloudFrontCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';
import { adoptDeprecatedRegionFlag } from '../region-options.js';

/**
 * `cdkd local start-cloudfront <distribution>` — serve a CloudFront distribution
 * locally: its S3 origin content (resolved from the BucketDeployment source in
 * the cloud assembly) AND its Lambda Function URL origins (the backing Lambda is
 * run locally via RIE), plus its viewer-request / viewer-response CloudFront
 * Functions, reproducing the distribution routing so a rewrite / routing change
 * is verifiable in seconds. Inherited from cdk-local (go-to-k/cdk-local#363,
 * Lambda Function URL + deployed-S3 origins added in #380).
 *
 * Like the `start-agentcore` wrapper, this command is a THIN pass-through to
 * cdk-local's factory. The serve behavior and the option block (`--port` /
 * `--host` / `--origin <originId>=<dir>` / `--kvs-file` / `--cache-origin` /
 * `--no-pull` / `--tls` / `--tls-cert` / `--tls-key` / `--watch`, plus
 * cdk-local's own `--from-cfn-stack` / `--stack-region` / `--assume-role` for
 * binding a Function URL origin's backing Lambda + a deployed-S3 origin's bucket
 * name to deployed state) live in cdk-local and are auto-inherited.
 *
 * `--region` is the ONE inherited option cdkd replaces rather than accepts as
 * given: cdk-local declares it visibly and undeprecated, while every other cdkd
 * command carries the hidden, warned, folded `deprecatedRegionOption`. See
 * {@link adoptDeprecatedRegionFlag} — the flag keeps working, disappears from
 * `--help`, prints the removal warning, and (the reason it exists) is folded to
 * its canonical spelling before cdk-local's handler builds an SDK client from it
 * ([#2522](https://github.com/go-to-k/cdkd/issues/2522)).
 *
 * ## Why cdkd's own state-source flags are REFUSED here
 *
 * The `extraStateProviders` seam cdk-local's factory accepts (go-to-k/cdk-local#426)
 * is wired in below, and cdkd's S3-backed `--from-state` factory reaches it — but
 * NOTHING in this command's code path consults it. Verified against the installed
 * `cdk-local@0.147.7` bundle (`dist/local-studio-BBtUAVNy.js`), all three consumers
 * miss, for two independent reasons:
 *
 *   1. `resolveDeployedS3Origins` (`:30872`) and `attachKvsModules` (`:30680`)
 *      both gate on `isCfnFlagPresent(options)` — i.e. `--from-cfn-stack`
 *      specifically — rather than on the "any state source is active" predicate
 *      `start-api` uses (`:15830`). With `--from-state` alone they return before
 *      a provider is constructed.
 *   2. `bootLambdaUrlOrigins` (`:30764`) and `bootLambdaEdgeFunctions` (`:30813`)
 *      call `resolveLambdaContainerEnv` WITHOUT its fourth `extraStateProviders`
 *      parameter, and the `envOptions` bag they hand it (`:30982`) is an
 *      allow-list of five keys that drops cdkd's state fields anyway.
 *
 * So the flags parse and do nothing, on exactly the command where a user is
 * already troubleshooting a `502` from an unresolved origin. Issue
 * [#2528](https://github.com/go-to-k/cdkd/issues/2528) settles that a flag that
 * parses and does nothing is worse than one that errors, so they are declared
 * (to keep the error actionable, and to keep the option set discoverable) and
 * REFUSED at `preAction` with a message naming `--from-cfn-stack` as today's
 * working state source. The upstream fix is go-to-k/cdk-local#699; when it
 * lands, delete {@link refuseUnwiredCdkdStateFlags} and the `[not supported…]`
 * prefixes — nothing else has to change, because the seam below is already
 * correct. Tracked for cdkd as
 * [#2600](https://github.com/go-to-k/cdkd/issues/2600).
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd: cdk-local's factory calls `setEmbedConfig(opts.embedConfig)`, and
 * passing the current config (set once by `createLocalCommand` before the
 * subcommands are built) keeps it as a no-op re-set rather than a reset back to
 * cdk-local's `cdkl` defaults.
 */
export function createLocalStartCloudFrontCommand(): Command {
  const cmd = createCdkLocalStartCloudFrontCommand({
    embedConfig: getEmbedConfig(),
    extraStateProviders: cdkdExtraStateProviders,
  });

  // Declared, then refused (see the module doc): keeping the declarations is
  // what lets the refusal say WHY and point at `--from-cfn-stack`, instead of
  // commander's bare `unknown option '--from-state'`. They also stay wired to
  // `cdkdExtraStateProviders` above, so the day cdk-local#699 lands the only
  // change here is deleting the refusal.
  cmd.addOption(
    new Option(
      '--from-state',
      "[not supported on start-cloudfront] Read cdkd's S3 state for the target stack. Refused at " +
        'startup: the CloudFront emulator consults a state source only under --from-cfn-stack ' +
        '(go-to-k/cdkd#2528, upstream go-to-k/cdk-local#699). Use --from-cfn-stack instead.'
    ).default(false)
  );
  cmd.addOption(
    new Option(
      '--state-bucket <bucket>',
      '[not supported on start-cloudfront] S3 bucket for --from-state. Refused at startup with --from-state.'
    )
  );
  cmd.addOption(
    new Option(
      '--state-prefix <prefix>',
      '[not supported on start-cloudfront] S3 key prefix for --from-state state files. Refused at startup with --from-state.'
    ).default('cdkd')
  );

  // cdk-local's own `--assume-role [arn]` help advertises `(3) --no-assume-role`
  // and its resolver is already written for it (`assumeRole !== true` returns no
  // ARN, and the "run with --assume-role" hint is gated on `=== undefined`), but
  // commander synthesizes no negation for an optional-value option — so the flag
  // was rejected by the parser and the `false` arm unreachable. Registering it
  // here makes the inherited advertisement true (issue #2523). Added AFTER the
  // inherited positive form, so an absent flag still parses as `undefined`.
  cmd.addOption(
    new Option(
      '--no-assume-role',
      'Explicitly opt out of assuming the deployed execution role: forward your ambient AWS ' +
        'credentials (or the --profile overlay) unchanged, and suppress the "re-run with ' +
        '--assume-role" hint that omitting the flag prints when deployed state is loaded.'
    )
  );

  refuseUnwiredCdkdStateFlags(cmd);

  return adoptDeprecatedRegionFlag(cmd);
}

/**
 * Refuse cdkd's three state-source flags on `start-cloudfront` before anything
 * runs, rather than accepting them and silently emulating against nothing.
 *
 * `commander`'s `Command.error` is used rather than a thrown `CdkdError`
 * because the check runs in a `preAction` hook, OUTSIDE the `withErrorHandling`
 * wrapper cdk-local puts around its action — a throw there escapes to
 * `main().catch`, which prints `Fatal error:` plus a stack. `error()` prints the
 * message the way every other option error on this CLI is printed and exits 1.
 *
 * `--state-prefix` carries a commander default, so its presence is decided by
 * `getOptionValueSource` (`'cli'` only when the user typed it) rather than by
 * the value — pinning the default string here would go inert the moment the
 * default changed.
 */
function refuseUnwiredCdkdStateFlags(cmd: Command): void {
  cmd.hook('preAction', (_thisCommand, actionCommand) => {
    const options = actionCommand.opts<{ fromState?: boolean; stateBucket?: string }>();
    const passed: string[] = [];
    if (options.fromState === true) passed.push('--from-state');
    if (options.stateBucket !== undefined) passed.push('--state-bucket');
    if (actionCommand.getOptionValueSource('statePrefix') === 'cli') passed.push('--state-prefix');
    if (passed.length === 0) return;
    actionCommand.error(
      `error: ${passed.join(' / ')} ${passed.length === 1 ? 'is' : 'are'} not supported by ` +
        '`cdkd local start-cloudfront`. The CloudFront emulator resolves its deployed-S3 origins, ' +
        "its cf.kvs() bindings and its Function URL / Lambda@Edge containers' environment through " +
        'cdk-local, which consults a state source only under --from-cfn-stack. DROP the flag(s) above, ' +
        'then use --from-cfn-stack <name> for a CloudFormation-deployed stack, or --origin ' +
        '<originId>=<dir> to serve an origin from a local directory. Adding --from-cfn-stack while ' +
        'leaving these on hits this same refusal. Tracked as go-to-k/cdkd#2528 (upstream ' +
        'go-to-k/cdk-local#699).',
      { code: 'cdkd.startCloudFrontStateFlagUnsupported' }
    );
  });
}
