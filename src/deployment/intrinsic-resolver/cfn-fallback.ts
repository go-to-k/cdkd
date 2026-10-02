import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { injectiveKey } from '../../state/record-keys.js';
import {
  ambientCredentialConfig,
  clientDefaultsFor,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import { STACK_REF_MAX_CODE_POINTS, displayAwsMessage } from '../../utils/display-safe.js';
import {
  MAX_LISTED_AVAILABLE_OUTPUTS,
  type ResolverContext,
  clientCacheKey,
  quotedRender,
} from './support.js';
import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListExportsCommand,
} from '@aws-sdk/client-cloudformation';
import type { Export as CfnExport } from '@aws-sdk/client-cloudformation';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    lookupCfnExport: OmitThisParameter<typeof lookupCfnExport>;
    /** @internal */
    describeAvailableOutputs: OmitThisParameter<typeof describeAvailableOutputs>;
    /** @internal */
    fetchAllCfnExports: OmitThisParameter<typeof fetchAllCfnExports>;
    /** @internal */
    lookupCfnStackOutputs: OmitThisParameter<typeof lookupCfnStackOutputs>;
    /** @internal */
    fetchCfnStackOutputs: OmitThisParameter<typeof fetchCfnStackOutputs>;
    /** @internal */
    getCfnClient: OmitThisParameter<typeof getCfnClient>;
  }
}

/**
 * CloudFormation `ListExports` fallback lookup for `Fn::ImportValue`
 * (issue #1697). Searches the consumer's deploy region (CFn exports are
 * region-scoped, same as cdkd's `Fn::ImportValue` semantics).
 *
 * Returns `undefined` both when the export does not exist AND when the
 * lookup itself failed (a warning is logged for the latter — e.g. the
 * caller's credentials lack `cloudformation:ListExports`), so the caller
 * surfaces its own not-found error either way. Graceful degradation is
 * deliberate: without this fallback the deploy would have failed with
 * the same not-found error anyway.
 */
export async function lookupCfnExport(
  this: IntrinsicFunctionResolver,
  exportName: string,
  context?: ResolverContext
): Promise<{ value: string; exportingStackId?: string } | undefined> {
  // The SAME reading `fetchAllCfnExports` builds its client from: it reads
  // the ambient configuration synchronously, before its first `await`.
  const listingKey = credentialFingerprint(ambientCredentialConfig());
  let listing = this.cfnExportsPromises.get(listingKey);
  if (!listing) {
    const fetched = this.fetchAllCfnExports();
    listing = fetched;
    this.cfnExportsPromises.set(listingKey, fetched);
    // Do not cache failures: a transient throttle / permission fix should
    // be retried by the next lookup, not poison the whole deploy.
    fetched.catch(() => {
      if (this.cfnExportsPromises.get(listingKey) === fetched) {
        this.cfnExportsPromises.delete(listingKey);
      }
    });
  }
  try {
    const exports = await listing;
    for (const exp of exports) {
      if (exp.Name === exportName && exp.Value !== undefined) {
        return {
          value: exp.Value,
          ...(exp.ExportingStackId && { exportingStackId: exp.ExportingStackId }),
        };
      }
    }
    return undefined;
  } catch (error) {
    // not-in-class(this.resolverRegion): a REGION: operator-supplied (--region) or a state-record field.
    this.logger.warn(
      // MASKED for the reason `resolveImportValue`'s own lines are (issue
      // #2133 review), and this one prints at DEFAULT verbosity.
      `Fn::ImportValue: CloudFormation ListExports fallback failed for export ` +
        `${quotedRender(this.displayMasked(exportName, context), "'")} ` +
        // The caught message is masked too since issue #2827, and this is
        // the one site of the five where that half is DEFENCE IN DEPTH
        // rather than a closed leak — recorded rather than left for the next
        // reader to assume otherwise. `ListExportsCommand` takes only a
        // `NextToken`, so no template-derived value is in the request and
        // AWS has nothing to quote back; measured by mutation probe, where
        // removing this mask alone reds NOTHING while removing the export
        // name's mask beside it reds two cases. Its `DescribeStacks` twin
        // below is genuinely reachable (that call DOES carry a resolved
        // `StackName`, and an AccessDenied names the resource it refused),
        // so the two are spelled the same on purpose: a uniform pair is what
        // stops a future reader deciding this one may be dropped.
        `(region ${this.resolverRegion}): ` +
        `${this.displayMasked(error instanceof Error ? error.message : String(error), context)}. ` +
        `Grant cloudformation:ListExports to resolve exports from CloudFormation-managed stacks, ` +
        `or pass --no-cfn-fallback to disable the fallback.`
    );
    return undefined;
  }
}

/**
 * Render the `Available outputs: ...` tail of an `Fn::GetStackOutput`
 * not-found error (issue #2133 review).
 *
 * These are the PRODUCER's `state.outputs` / CloudFormation output KEYS, and
 * they land in a top-level ERROR — the one thing on this path that reaches a
 * CI log at default verbosity. A key can itself hold plaintext: that is the
 * `secretBearingStateKeyWarning` class (issue #1919), which `cdkd scrub`
 * counts and deliberately never prints, so the enumeration must not be the
 * one place that does.
 *
 * MASKED and CAPPED rather than dropped. Masking is the treatment every other
 * identifier on this path already gets, and the cap bounds what one error can
 * disclose (a producer with hundreds of outputs would otherwise dump all of
 * them). Dropping the names entirely was considered and rejected: a typo'd
 * `OutputName` is the overwhelmingly common cause, and the list is what makes
 * the error actionable.
 *
 * `maskSecretsRaw` reads the consumer pass's log twin first (issue #3150),
 * so a key equal to a name this pass assembled around a short secret is
 * masked. Residual, stated rather than hidden: the needles and twins belong to the
 * CONSUMER's resolution, so a plaintext sitting in a PRODUCER key that this
 * consumer never resolved is not maskable from here. The cap is what bounds that case;
 * `cdkd scrub` reporting the producer's own `secretBearingKeys` is the remedy.
 */
export function describeAvailableOutputs(
  this: IntrinsicFunctionResolver,
  keys: string[],
  context?: ResolverContext
): string {
  if (keys.length === 0) return '(none)';
  const shown = keys.slice(0, MAX_LISTED_AVAILABLE_OUTPUTS);
  // `displayMasked`, not the bare masker (go-to-k/cdkd#3408 round 3). These
  // keys are the PRODUCER's output names, read out of that stack's state
  // record — unchecked data — and this list is interpolated by its callers,
  // which is why the "never interpolate the masker" rule could not reach it:
  // the mask happens inside a map callback, one call away from the render.
  const rendered = shown.map((k) => this.displayMasked(k, context)).join(', ');
  const hidden = keys.length - shown.length;
  return hidden > 0 ? `${rendered} (+${hidden} more)` : rendered;
}

/** Full paginated ListExports walk backing {@link lookupCfnExport}'s memo. */
export async function fetchAllCfnExports(this: IntrinsicFunctionResolver): Promise<CfnExport[]> {
  const client = this.getCfnClient(this.resolverRegion);
  const exports: CfnExport[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(new ListExportsCommand({ NextToken: nextToken }));
    exports.push(...(res.Exports ?? []));
    nextToken = res.NextToken;
  } while (nextToken);
  return exports;
}

/**
 * CloudFormation `DescribeStacks` fallback lookup for
 * `Fn::GetStackOutput` (issue #1697). Region-pinned because the
 * intrinsic may target a region different from the consumer's.
 *
 * Returns the stack's outputs map when the CFn stack exists;
 * `undefined` when it does not exist OR the lookup failed (a warning is
 * logged for non-not-found failures). Same graceful-degradation
 * contract as {@link lookupCfnExport}.
 */
export async function lookupCfnStackOutputs(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string,
  context: ResolverContext | undefined,
  /** How `region` is printed: its caller's log text of the raw region (issue #3150). */
  loggedRegionText: string
): Promise<Record<string, string> | undefined> {
  // ENCODED, not separated (go-to-k/cdkd#3496). DEFENCE IN DEPTH, and the
  // bound is worth stating rather than leaving to be re-derived: `stackName`
  // is template text, but a 2-part collision needs the OTHER pair's FIRST
  // half to carry the separator, and that is `region`, which reaches here
  // only through `canonicalizeRegion` + `isClientSafeRegion` or as a constant
  // per resolver instance. So the collision is not reachable today. What it
  // would cost if that gate moved is the reason to encode anyway: this cache
  // serves a RESOLVED OUTPUT BAG, so a hit answers one stack's
  // `Fn::GetStackOutput` with another stack's outputs.
  // The credential half is the reading `fetchCfnStackOutputs` builds its
  // client from, before its first `await` (issue #3588).
  const cacheKey = injectiveKey(
    region,
    stackName,
    credentialFingerprint(ambientCredentialConfig())
  );
  let fetch = this.cfnStackOutputsCache.get(cacheKey);
  if (!fetch) {
    fetch = this.fetchCfnStackOutputs(stackName, region);
    this.cfnStackOutputsCache.set(cacheKey, fetch);
    // Do not cache lookup FAILURES (the definitive does-not-exist miss
    // resolves to undefined and IS cached — that answer is stable for
    // the deploy's lifetime).
    fetch.catch(() => {
      if (this.cfnStackOutputsCache.get(cacheKey) === fetch) {
        this.cfnStackOutputsCache.delete(cacheKey);
      }
    });
  }
  try {
    return await fetch;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Both halves are the spelling THIS line prints below, so the pair and
    // the rendering cannot disagree about what "masked" means. That is a
    // live constraint, not a tidiness one: go-to-k/cdkd#3408 round 2 moved
    // the two printed operands to `displayMasked` (which STRIPS as well as
    // masks) and left these pairs on the bare masker, so the same name could
    // render two ways in one message — bare in the AWS echo this rewrites,
    // stripped where we print it ourselves. go-to-k/cdkd#3426 removed that
    // second spelling from the file entirely. The pairs' replacement is the
    // PRE-BOUNDARY masked spelling (the line below bounds it further through
    // `displayMaskedIdent`), as at `maskStateReadError`'s call site: it
    // rewrites text another module rendered, where a second boundary would
    // only nest quotes.
    const cfnNameMask = this.positionalNameMask([
      [stackName, this.displayMasked(stackName, context)],
      [region, this.displayMasked(loggedRegionText, context)],
    ]);
    this.logger.warn(
      // MASKED, the exact twin of `lookupCfnExport`'s own line (issue #2133
      // review), and this one prints at DEFAULT verbosity too. `stackName`
      // reaches here from `resolveGetStackOutput`'s `resolveValue` result, so
      // a stack name assembled from a `{{resolve:...}}` reference is a
      // resolved secret in every line that names it. The method took no
      // `context` at all until now, which is why it was the one sibling with
      // nothing to mask against; its only caller has one.
      `Fn::GetStackOutput: CloudFormation DescribeStacks fallback failed for stack ` +
        // `message` masked too since issue #2827 — `DescribeStacks` quotes
        // the stack name back, and `region` is itself a resolved value.
        //
        // The AWS text goes through the POSITIONAL pass first (issue #3234):
        // this frame hands `stackName` to `DescribeStacks` raw, and
        // `displayMasked` over the returned sentence finds no twin for it
        // and falls to the needle pass, whose substring arm cannot see a
        // sub-floor secret assembled into the name. Same class, reached from
        // the same caller as the state read below (this is its own method,
        // not the same frame); the two share `positionalNameMask`.
        // STRIPPED as well as masked, since go-to-k/cdkd#3408 round 2 —
        // and this is the site that made the round-1 repair ONE-SIDED. That
        // repair hardened `resolveGetStackOutput`'s four THROWS and left this
        // warn, which is worse in two ways: `cfnFallback` DEFAULTS TO TRUE,
        // so this is the ordinary path rather than an opt-in one, and `warn`
        // prints at DEFAULT verbosity where a throw at least accompanies a
        // failure. Measured emitting a live `ESC[2K` + CR from a hostile
        // `StackName`.
        `${this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS)} ` +
        `(${this.displayMaskedIdent(loggedRegionText, context)}): ` +
        // The AWS text is BOUNDED as well: `DescribeStacks` quotes the
        // submitted stack name back, so its length is the template author's
        // choice — the same reason `role-arn.ts` bounds STS's reply.
        `${displayAwsMessage(this.displayMasked(cfnNameMask ? cfnNameMask(message) : message, context))}. ` +
        `Grant cloudformation:DescribeStacks to resolve outputs from CloudFormation-managed ` +
        `stacks, or pass --no-cfn-fallback to disable the fallback.`
    );
    return undefined;
  }
}

/**
 * Single DescribeStacks read backing {@link lookupCfnStackOutputs}'s memo.
 * Resolves to the outputs map, `undefined` for the definitive
 * does-not-exist miss, and REJECTS on any other failure.
 */
export async function fetchCfnStackOutputs(
  this: IntrinsicFunctionResolver,
  stackName: string,
  region: string
): Promise<Record<string, string> | undefined> {
  try {
    const client = this.getCfnClient(region);
    const res = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = res.Stacks?.[0];
    if (!stack) return undefined;
    const outputs: Record<string, string> = {};
    for (const out of stack.Outputs ?? []) {
      if (out.OutputKey && out.OutputValue !== undefined) {
        // allow-template-keyed-bag-read: `OutputKey` is a CloudFormation output
        // LOGICAL ID, which CFn constrains to alphanumerics -- so it cannot be
        // `__proto__` and the write never reaches the inherited setter. (It IS
        // template text, the producer stack's; the constraint is what makes it
        // safe, not the provenance.)
        outputs[out.OutputKey] = out.OutputValue;
      }
    }
    return outputs;
  } catch (error) {
    // DescribeStacks signals "no such stack" via a ValidationError whose
    // message is `Stack with id <name> does not exist` — the expected
    // miss, not a lookup failure worth a warning. Require the TYPED name
    // alongside the message heuristic (issue #1697 review; memory rule
    // `feedback_predelete_steps_vs_notfound_heuristics`): a credentials /
    // assume-role error that happens to contain the phrase must surface
    // as a lookup failure (warn + retry-able), never as a silent miss.
    if (
      error instanceof Error &&
      error.name === 'ValidationError' &&
      /does not exist/i.test(error.message)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Lazily-constructed per-region CloudFormation client (issue #1697).
 *
 * Built with the ambient clients' {@link AwsClients.credentialConfig}, the
 * way {@link serviceDiscoveryClient} is (issue
 * [#1983](https://github.com/go-to-k/cdkd/issues/1983)). An explicit
 * `AwsClientConfig.credentials` has no environment path — only a LIBRARY
 * caller passes one, and it never runs the CLI's `AWS_PROFILE` mirror — so a
 * client built from `awsClientDefaults()` alone ran the CFn fallback reads
 * under the default chain's identity instead. The explicit `credentials`
 * spread AFTER the defaults, so they outrank an assumed `--role-arn` role,
 * matching {@link AwsClients}' own spread order.
 *
 * Not routed through {@link clientsForRegion}: the region here is always
 * the one the caller named, never the ambient's, and a test double without
 * `credentialConfig` degrades to the default chain rather than throwing.
 * Keyed by region AND credential fingerprint for the reason
 * {@link regionScopedClients} gives (issue #3588).
 */
export function getCfnClient(
  this: IntrinsicFunctionResolver,
  region: string
): CloudFormationClient {
  const credentialConfig = ambientCredentialConfig();
  const key = clientCacheKey(region, credentialConfig);
  let client = this.cfnClients.get(key);
  if (!client) {
    client = new CloudFormationClient({ ...clientDefaultsFor(credentialConfig), region });
    this.cfnClients.set(key, client);
  }
  return client;
}
