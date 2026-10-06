import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import { hasReadableOutputs } from '../../state/malformed-resources-bag.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import {
  ROLE_ARN_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  displayIdent,
  displaySafe,
  displayStackName,
} from '../../utils/display-safe.js';
import {
  CrossAccountSecretRefusalError,
  MalformedProducerRecordRefusalError,
} from '../../utils/error-handler.js';
import {
  type NamedRequestMasks,
  type ResolverContext,
  carriesDynamicReference,
  isClientSafeRegion,
  quotedRender,
} from './support.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  SECRET_MASK,
  crossStackSourceKey,
  hasMaskableValues,
  maskSecretsInError,
  unionOfSecretBags,
} from '../secret-redaction.js';

declare module '../intrinsic-function-resolver.js' {
  interface IntrinsicFunctionResolver {
    /** @internal */
    resolveGetStackOutput: OmitThisParameter<typeof resolveGetStackOutput>;
    /** @internal */
    recordOutputRead: OmitThisParameter<typeof recordOutputRead>;
    /** @internal */
    positionalNameMask: OmitThisParameter<typeof positionalNameMask>;
    /** @internal */
    maskStateReadError(...args: Parameters<OmitThisParameter<typeof maskStateReadError>>): never;
    /** @internal */
    maskNamedError: OmitThisParameter<typeof maskNamedError>;
    /** @internal */
    namedRequestMasks: OmitThisParameter<typeof namedRequestMasks>;
  }
}

/**
 * Resolve Fn::GetStackOutput (cross-stack / cross-region / cross-account
 * output reference).
 *
 * Shape: { "Fn::GetStackOutput": { "StackName": "...", "OutputName": "...",
 *                                   "Region": "...", "RoleArn": "..." } }
 *
 * Unlike Fn::ImportValue, the producer stack is named explicitly and no
 * Export is required. cdkd reads the producer's `outputs` from the
 * region-scoped state record at
 * `s3://{bucket}/cdkd/{StackName}/{Region}/state.json`. When `Region` is
 * omitted, the consumer's deploy region is used.
 *
 * **RoleArn (cross-account)**: when set, cdkd issues `sts:AssumeRole`
 * against the supplied role and reads the PRODUCER ACCOUNT's separate
 * cdkd state bucket (`cdkd-state-{producerAccountId}`) — bucket name
 * derived from the role ARN's account ID and the canonical
 * region-free bucket convention. The assumed credentials are cached
 * per-RoleArn for the deploy lifetime so a stack that references the
 * same producer multiple times only pays one STS hop. **The inline
 * `RoleArn` argument is constrained to literal strings only** — no
 * `Ref` / `Fn::GetAtt` / `Fn::Sub` chains — because the resolver
 * context isn't guaranteed to have the producer-account info available
 * at intrinsic-resolution time and a typo'd role lookup is far worse
 * than a clear "literal-string required" error at template-author
 * time. Same-account references (no RoleArn) take the original
 * shared-state-backend path.
 */
export async function resolveGetStackOutput(
  this: IntrinsicFunctionResolver,
  arg: unknown,
  context: ResolverContext
): Promise<unknown> {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) {
    throw new Error(
      `Fn::GetStackOutput: argument must be an object with StackName/OutputName/Region/RoleArn, got ${
        arg === null ? 'null' : Array.isArray(arg) ? 'array' : typeof arg
      }`
    );
  }
  const args = arg as Record<string, unknown>;

  if (!('StackName' in args)) {
    throw new Error('Fn::GetStackOutput: StackName is required');
  }
  if (!('OutputName' in args)) {
    throw new Error('Fn::GetStackOutput: OutputName is required');
  }

  // Same as `Fn::ImportValue`'s: built from the RAW args, so the persist
  // path's key over the unresolved template leaf is the same string (issue
  // #2059). A non-literal `StackName` / `OutputName` / `Region` / `RoleArn`
  // yields no key, and the redaction path then falls back to today's
  // behaviour rather than guessing.
  const sourceKey = crossStackSourceKey({ 'Fn::GetStackOutput': args });

  const stackName = await this.resolveValue(args['StackName'], context);
  if (typeof stackName !== 'string' || stackName === '') {
    throw new Error(
      `Fn::GetStackOutput: StackName must resolve to a non-empty string, got ${typeof stackName}`
    );
  }

  const outputName = await this.resolveValue(args['OutputName'], context);
  if (typeof outputName !== 'string' || outputName === '') {
    throw new Error(
      `Fn::GetStackOutput: OutputName must resolve to a non-empty string, got ${typeof outputName}`
    );
  }

  let region = this.resolverRegion;
  // The spelling every line below prints `region` with (issue #3150): the
  // log text of the resolver's own region, which a string this pass
  // assembled can equal, or of a template-supplied region's RAW value, since
  // `canonicalizeRegion` lowercases it past any twin lookup.
  let loggedRegionText = this.logTextOfLeaf(region, context);
  if ('Region' in args && args['Region'] !== undefined && args['Region'] !== null) {
    const resolvedRegion = await this.resolveValue(args['Region'], context);
    if (typeof resolvedRegion !== 'string' || resolvedRegion === '') {
      throw new Error(
        `Fn::GetStackOutput: Region must resolve to a non-empty string, got ${typeof resolvedRegion}`
      );
    }
    // Region-shape gate (issue #1957 review). This value is TEMPLATE-derived
    // — `{"Region": {"Ref": "SomeParam"}}` resolves through `resolveValue`
    // above — and it reaches TWO sinks that both treat it as trusted:
    //
    //   1. an SDK client region, via `lookupCfnStackOutputs` ->
    //      `getCfnClient(region)` -> `new CloudFormationClient({ region })`.
    //      A region is substituted into the service hostname, so
    //      `evil.example.com#` yields a SigV4-SIGNED `DescribeStacks` to
    //      `https://cloudformation.evil.example.com/#.amazonaws.com`.
    //   2. an S3 STATE-KEY segment, via `getState(stackName, region)` ->
    //      `cdkd/{stack}/{region}/state.json`. A `../` there traverses within
    //      the state bucket and reads a key the template never named.
    //
    // Older than this PR — the client has always been built from it — but the
    // gate is one call away and the sink list is exactly this PR's subject,
    // so it is closed here. THROW rather than fall back to the resolver's own
    // region, for the same reason as `Fn::GetAZs` and one more: silently
    // substituting a different region would read ANOTHER region's stack
    // outputs and hand them to the consumer as if they were the requested
    // ones. The CANONICAL form is what flows onward, so the client and the
    // state key agree on one spelling.
    const requestedRegion = canonicalizeRegion(resolvedRegion);
    if (!isClientSafeRegion(requestedRegion)) {
      // MASKED BEFORE THE TRANSFORM, the exact twin of `Fn::GetAZs`' region
      // gate — see the comment there for why the order is load-bearing
      // (issue [#2827](https://github.com/go-to-k/cdkd/issues/2827)).
      throw new Error(
        `Fn::GetStackOutput: ${this.displayMaskedIdent(this.logTextOfLeaf(resolvedRegion, context) !== resolvedRegion ? SECRET_MASK : resolvedRegion, context, 64)} is not a ` +
          `valid AWS region name. The region selects both the AWS endpoint and the state-file ` +
          `key, so cdkd will not use it.`
      );
    }
    region = requestedRegion;
    loggedRegionText = this.regionLogText(resolvedRegion, context);
  }

  // RoleArn must be a LITERAL string in the template — we check the raw
  // value rather than running it through resolveValue, because a Ref /
  // Fn::GetAtt / Fn::Sub chain would either silently resolve to the
  // wrong principal or quietly fail in a way that masks the
  // cross-account intent. The error message is specific so template
  // authors know to inline the ARN.
  let roleArn: string | undefined;
  if ('RoleArn' in args && args['RoleArn'] !== undefined && args['RoleArn'] !== null) {
    const raw = args['RoleArn'];
    if (typeof raw !== 'string' || raw === '') {
      // The shape through the builder (issue #3441), for the reason the
      // `Invalid Fn::GetAtt format` echo takes it: being pre-resolution
      // answers the secret question, not the control-character one, and
      // `JSON.stringify` escapes C0 controls but passes `U+2028` / `U+2029`
      // and the bidi overrides through as written.
      throw new Error(
        `Fn::GetStackOutput: RoleArn must be a literal string in the template ` +
          `(no Ref / Fn::GetAtt / Fn::Sub allowed for cross-account references). ` +
          `Got ${
            raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw
          }${typeof raw === 'object' ? ` (intrinsic shape: ${this.displayMasked(JSON.stringify(raw).slice(0, 80), context)})` : ''}.`
      );
    }
    roleArn = raw;
  }

  // Reject obvious self-reference (same stack AND same region AND
  // same account — we cannot detect the account-id mismatch without
  // STS, so we only enforce same-region same-stack here; the
  // cross-account RoleArn case is by definition NOT self-reference).
  if (
    !roleArn &&
    context.stackName &&
    context.stackName === stackName &&
    // BOTH sides folded AT THE COMPARISON, which is the only place that can
    // be done without moving a state key.
    //
    // `region` enters this method by two paths with different spellings:
    // folded when the template names a `Region` (`canonicalizeRegion`, issue
    // #1957), RAW when it does not, since it then defaults to
    // `this.resolverRegion`. On the no-`Region` path both sides were the same
    // raw string before issue #1882 folded `AWS::Region`, so it compared a
    // value to itself and always fired; on the named-`Region` path they have
    // been folded-against-raw since issue #1957, which is the pre-existing
    // half of the miss. Folding only ONE side repairs the first path
    // and breaks the second — measured on this branch, where a mis-cased
    // resolver region with no `Region` argument resolved its OWN stack's
    // output instead of refusing, and `cfnFallback` defaults to true, so the
    // read can land on a same-named CloudFormation stack.
    //
    // Do not fold either operand at its DEFINITION. `region` is passed on to
    // `getSameAccountStackState` / `getCrossAccountStackState` /
    // `lookupCfnStackOutputs`, where it is a state-key segment, and
    // `this.resolverRegion` keys this stack's own `getState` / `saveState`.
    // Normalizing only for the duration of the comparison leaves both.
    canonicalizeRegion(region) === canonicalizeRegion(this.resolverRegion)
  ) {
    // MASKED at the throw (issue
    // [#2827](https://github.com/go-to-k/cdkd/issues/2827)). This refusal
    // fires BEFORE `loggedStackName` is bound a few lines down, so it masks
    // its own raw values; `region` is masked too — `isClientSafeRegion` is
    // `/^[a-z0-9][a-z0-9-]{0,30}$/`, wide enough for a real plaintext to
    // pass it.
    // Stripped too (go-to-k/cdkd#3408 round 2). It fires BEFORE
    // `loggedStackName` is bound, so it cannot reuse that binding — but it
    // renders the SAME value class, and the comment above arguing that
    // masking suffices is what the round-1 measurement disproved.
    throw new Error(
      `Fn::GetStackOutput: cannot reference own stack ` +
        `${this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS)} in the same region ` +
        `${this.displayMaskedIdent(loggedRegionText, context)}`
    );
  }

  // MASKED, same reason as `Fn::ImportValue`'s export name (issue #2133
  // review): both `StackName` and `OutputName` come back from `resolveValue`,
  // so either can carry a resolved secret.
  // STRIPPED as well as masked, since issue
  // [#3397](https://github.com/go-to-k/cdkd/issues/3397). `maskSecretsRaw`
  // answers "does this text contain a recorded secret"; it makes no claim
  // about CONTROL CHARACTERS, and both of these are template-derived through
  // `resolveValue` with only a non-empty-string gate in front of them. So the
  // lines below rendered a `StackName` carrying `ESC[2K` + CR raw — measured
  // on this very throw during go-to-k/cdkd#3408's security review, which
  // emitted a line that erases and rewrites itself.
  //
  // That is the SAME defect this issue is about, one operand to the left: the
  // `RoleArn` on these lines is sanitized and its neighbour was not, which is
  // exactly what `local-profile-display-population.test.ts`'s mixed-render arm
  // exists to catch and cannot see here (this whole directory is outside
  // `inMixedScope`; go-to-k/cdkd#3405 owns that widening).
  //
  // NOTE TO AN EDITOR OF THIS COMMENT: never write a slash followed by two
  // stars anywhere in this file outside a real doc comment — a directory glob
  // is the way it happens. Several source-shape fences over this file strip
  // block comments with a non-greedy regex pass, and that sequence OPENS one
  // even inside a line comment, so everything up to the next close-marker
  // vanishes from what the fence reads. Measured twice while writing this
  // very paragraph (go-to-k/cdkd#3408): the first spelling swallowed the
  // `hasReadableOutputs(` anchor 150 lines down and reported the
  // malformed-producer refusal as deleted; the second was this warning
  // quoting the sequence it warns about.
  //
  // `maskThenStripThenMask` rather than a bare `stripControlChars` is the
  // rule `cross-stack.ts` (`resolveImportValue`) already settled: stripping DELETES, so a
  // plaintext split by an invisible would be reconstituted contiguous by a
  // strip applied after a single mask. Masking on both sides of it closes
  // that, and it is a no-op on any ordinary name.
  const loggedStackName = this.displayMaskedIdent(stackName, context, STACK_REF_MAX_CODE_POINTS);
  const loggedOutputName = this.displayMaskedIdent(outputName, context);
  // The THIRD resolved value of this trio (issue
  // [#2827](https://github.com/go-to-k/cdkd/issues/2827)): a `Region`
  // argument also comes back from `resolveValue`, and the shape gate above
  // only proves it is `[a-z0-9-]{1,31}` — a real plaintext can be. Bound
  // here so the log lines and the three throws below share ONE masked
  // spelling instead of each deciding.
  const loggedRegion = this.displayMasked(loggedRegionText, context);
  // The FOURTH value of this group, and the one that needed a different
  // helper (issue
  // [#3397](https://github.com/go-to-k/cdkd/issues/3397)). `roleArn` is NOT a
  // resolved value — the notes below say so, and that is a statement about
  // MASKING. It is still a LITERAL the user wrote in their own template,
  // reaching a terminal with no shape gate between: the `parseIamRoleArn`
  // check that would reject a malformed one runs later, in
  // `getCrossAccountStackState`, and only on the cross-account branch. So the
  // three lines below and the refusal there used to render argv-grade text
  // raw, which is the class issue
  // [#2170](https://github.com/go-to-k/cdkd/issues/2170) closed for
  // `src/utils/role-arn.ts` and issue
  // [#3390](https://github.com/go-to-k/cdkd/issues/3390) closed for the
  // `cdkd local` surface.
  //
  // Bound ONCE, for the reason `loggedRegion` above is: four renders sharing
  // one spelling cannot drift into three. `displayIdent` rather than
  // `displaySafe` because an ARN is an IDENTIFIER — a positive allowlist plus
  // a length cap, and a JSON-quoted boundary the moment the value is not one.
  // A COMMON ARN's characters are all in `PLAIN_IDENT`, so an ordinary value
  // renders byte-identically and no fixture's grep moves. NOT "every
  // legitimate ARN" -- IAM paths admit `( ) ! # $ % & * [ ]`, which render
  // JSON-quoted; `src/utils/role-arn.ts` carries that cost note in full.
  const shownRoleArn = roleArn
    ? displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })
    : '';
  // not-in-class(roleArn ? `, RoleArn=${shownRoleArn}` : ''): the RoleArn argument, refused unless it is a literal template string.
  this.logger.debug(
    `Resolving Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
      `OutputName=${loggedOutputName}${roleArn ? `, RoleArn=${shownRoleArn}` : ''}`
  );

  // Cross-account branch: assume the role, derive the producer's
  // state bucket from the role ARN's account ID, build an ephemeral
  // S3StateBackend pointed at it with the assumed credentials, then
  // read the producer's state.
  //
  // MASKED AT THIS BOUNDARY (issue
  // [#3234](https://github.com/go-to-k/cdkd/issues/3234)), and it has to be
  // HERE rather than at the throw: the reads take the RAW `stackName` and
  // `region` because those are state-KEY segments, and `S3StateBackend` — a
  // module that holds no secrets bag — quotes them back through
  // `displaySafe`, an ASCII sanitizer rather than a masker. This frame is the
  // last one holding both the raw names and their masked spellings, so it is
  // the only place the substitution can be exact.
  //
  // The `Fn::ImportValue` sibling catches its own read, but masks the caught
  // message with the BAGS alone (`displayMasked` over a composed AWS
  // sentence finds no twin and falls to the needle pass). That closes the
  // 4+ character class there and leaves the POSITIONAL half open — the same
  // gap in the same shape. Do not read it as the pattern this site is
  // catching up to.
  let stateData: Awaited<ReturnType<S3StateBackend['getState']>>;
  try {
    stateData = roleArn
      ? await this.getCrossAccountStackState(roleArn, stackName, region, context)
      : await this.getSameAccountStackState(stackName, region, context);
  } catch (error) {
    this.maskStateReadError(
      error,
      [
        // The pair's replacement is the MASKED spelling, not the bounded
        // one: it rewrites the name inside text another module already
        // rendered, where a second boundary would only nest quotes.
        [stackName, this.displayMasked(stackName, context)],
        [region, loggedRegion],
      ],
      context
    );
  }
  if (!stateData) {
    // CloudFormation fallback (issue #1697): the producer may be a
    // CloudFormation-managed stack (deployed via `cdk deploy` / raw CFn)
    // whose outputs live in CloudFormation, not cdkd state. Same-account
    // only — the RoleArn (cross-account) path keeps reading cdkd state
    // exclusively (a cross-account CFn read would need a different
    // permission model; see the issue's out-of-scope note).
    if (!roleArn && this.cfnFallback) {
      const cfnOutputs = await this.lookupCfnStackOutputs(
        stackName,
        region,
        context,
        loggedRegionText
      );
      if (cfnOutputs) {
        // `Object.hasOwn` (issue #2767): `outputName` is template-controlled and
        // `cfnOutputs` is built from an AWS response, so a bare `in` let
        // `OutputName: "constructor"` past this refusal and returned the function.
        if (!Object.hasOwn(cfnOutputs, outputName)) {
          const available = this.describeAvailableOutputs(Object.keys(cfnOutputs), context);
          // not-in-class(available): already rendered through describeAvailableOutputs, which masks each key.
          throw new Error(
            `Fn::GetStackOutput: output ${loggedOutputName} not found in CloudFormation stack ` +
              `${loggedStackName} (${displayIdent(loggedRegion)}). Available outputs: ${available}`
          );
        }
        const value = cfnOutputs[outputName];
        // No VALUE (issue #2133), same reason as the `Fn::ImportValue`
        // CloudFormation fallback: a CFn stack output never passed through
        // cdkd's redaction, so it is whatever the producer resolved.
        this.logger.info(
          `Resolved Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
            `OutputName=${loggedOutputName} ` +
            `(from CloudFormation stack outputs; weak reference — producer is not cdkd-managed)`
        );
        // Deliberately NOT recorded into `recordedOutputReads` —
        // `state.outputReads` names cdkd-managed producers so recreate
        // warnings can list downstream consumers; a CFn-managed producer
        // is never recreated by cdkd. And deliberately NOT re-resolved, for
        // the same reason as the `Fn::ImportValue` CloudFormation fallback
        // (issue #1934): this value never passed through cdkd's redaction.
        return value;
      }
    }
    // `roleArn`, which this method refuses unless it is a literal template
    // string, so it carries no resolved value.
    // cdkd-arn-display: the SECOND substitution of this statement
    // (`!roleArn && this.cfnFallback ? … : …`) mentions `roleArn` as a
    // TRUTHINESS TEST and renders neither arm from it -- both arms are
    // constant sentences. The value that IS rendered here is `shownRoleArn`,
    // one substitution up. Annotated rather than restructured because the
    // condition is the right code; the display fence keys on a name appearing
    // in a substitution and cannot tell a test from a render.
    // not-in-class(roleArn ? ` (cross-account via ${shownRoleArn})` : ''): the RoleArn argument, refused unless it is a literal template string.
    throw new Error(
      `Fn::GetStackOutput: stack ${loggedStackName} not found in region ${displayIdent(loggedRegion)}${
        roleArn ? ` (cross-account via ${shownRoleArn})` : ''
      }. ${
        !roleArn && this.cfnFallback
          ? `Searched cdkd state and CloudFormation stacks. Make sure the producer stack ` +
            `has been deployed (via cdkd or CloudFormation).`
          : `Make sure the producer stack has been deployed via cdkd.`
      }`
    );
  }

  // The producer's record is UNCHECKED data — `parseStateBody` validates the
  // root object and the schema version and nothing inside — so `outputs` can
  // hold a string, a list, a number, a boolean or `null` (issue #3207).
  //
  // THIS ARM IS THE ONE READER OF THAT BAG THAT RE-APPLIES RATHER THAN
  // DISPLAYS, which is why it REFUSES where `importableOutputKeys` fails
  // closed for the `Fn::ImportValue` sibling (`cross-stack.ts`). `Object.hasOwn('abcdef',
  // '0')` is TRUE, so an `OutputName: '0'` against a six-character bag passed
  // the membership test below and resolved the single CHARACTER `'a'` — a
  // value this deploy then SENDS to AWS as a live resource's property. The
  // `describeAvailableOutputs(Object.keys(outputs))` tail in that same
  // refusal echoed the fabricated keys back as the producer's outputs.
  //
  // Through the SHARED predicate, so the ABSENCE rule is the one every other
  // consumer of this bag uses: an absent bag is an ORDINARY record (the
  // deploy's failure-path saves write `outputs: currentState.outputs`, which
  // `JSON.stringify` drops when undefined) and falls through to the ordinary
  // not-found refusal below.
  //
  // `MalformedProducerRecordRefusalError`, an
  // `IntrinsicResolutionRefusalError` SUBCLASS, so an enclosing `Fn::Sub`
  // re-raises it instead of laundering it into a literal `${...}` shipped to
  // AWS (issue #1740) while `cdkd scrub`'s pre-pass can still tell it from
  // its siblings — the class's own JSDoc carries why that distinction has to
  // exist. `markNonRetryable` because the input is a persisted state record,
  // which no retry can change.
  if (!hasReadableOutputs(stateData.state)) {
    throw markNonRetryable(
      new MalformedProducerRecordRefusalError(
        `Fn::GetStackOutput: the state record of producer stack ${loggedStackName} ` +
          `(${displayIdent(loggedRegion)}) has no readable 'outputs' map — the record is malformed or ` +
          `truncated. cdkd refuses to resolve from it rather than reading it as a map: ` +
          `'Object.hasOwn' answers TRUE for '0' on a string and for an index on a list, so ` +
          `continuing would resolve ONE CHARACTER or element of the record as this ` +
          `reference's value and this deploy would send it to AWS. Inspect the producer's ` +
          `record with 'cdkd state show' --json, repair or remove it, then re-run.`
      )
    );
  }
  const outputs = stateData.state.outputs ?? {};
  // `Object.hasOwn` for the same reason as the CloudFormation-sourced arm
  // above (issue #2767); the sibling `Fn::ImportValue` path was already safe
  // because it tests membership through `importableOutputKeys`.
  if (!Object.hasOwn(outputs, outputName)) {
    const available = this.describeAvailableOutputs(Object.keys(outputs), context);
    // not-in-class(available): already rendered through describeAvailableOutputs, which masks each key.
    throw new Error(
      `Fn::GetStackOutput: output ${loggedOutputName} not found in stack ${loggedStackName} (${displayIdent(loggedRegion)}). ` +
        `Available outputs: ${available}`
    );
  }

  const value = outputs[outputName];
  // NAMES the reference, never the VALUE (issue #2133) — the SIBLING of the
  // `Fn::ImportValue` arms in `cross-stack.ts` and wrong for the same reason: "a producer's
  // state holds the `{{resolve:...}}` EXPRESSION" is a property of
  // POST-#1934 state, and `cdkd scrub`'s whole population is state written
  // before that, holding the plaintext.
  // not-in-class(roleArn ? `, RoleArn=${shownRoleArn}` : ''): the RoleArn argument, refused unless it is a literal template string.
  this.logger.info(
    `Resolved Fn::GetStackOutput: StackName=${loggedStackName}, Region=${loggedRegion}, ` +
      `OutputName=${loggedOutputName}${roleArn ? `, RoleArn=${shownRoleArn}` : ''} ` +
      `(${carriesDynamicReference(value) ? 'redacted dynamic reference' : 'literal value'})`
  );
  // Schema v8 (issue #668): record same-account reads so
  // `findDownstreamConsumers` can name `Fn::GetStackOutput`
  // consumers in the recreate warn block. Cross-account
  // `RoleArn`-based reads are deferred to a future schema bump
  // alongside a `sourceAccountId` field (the cross-account
  // consumer set is rarely large in practice, and the resolver
  // already pays an STS hop on the read side).
  if (!roleArn) {
    this.recordOutputRead(context, stackName, region, outputName);
  }

  // The SIBLING read path of `Fn::ImportValue`, reading the same persisted
  // `state.outputs` bag, so it carries the same redacted expressions and
  // needs the same re-resolution (issue #1934 Direction item 2).
  //
  // Except CROSS-ACCOUNT, where cdkd REFUSES rather than resolving. The
  // expression names a secret in the PRODUCER's account; the only credentials
  // in hand for a lookup are the consumer's, and resolving under them would
  // silently answer from a same-named secret in the WRONG account — the
  // disclosure shape issue #1957 exists to close, and strictly worse than
  // stopping. (The `RoleArn` credentials are assumed for a state READ and
  // carry no promise of `secretsmanager:GetSecretValue` / `ssm:GetParameter`;
  // resolving through them is a real option, but it is a permission-model
  // change that belongs in its own issue rather than smuggled in behind a
  // silent fallback.) Refusing is also better than the pre-#1934 behaviour of
  // shipping the literal token: a `{{resolve:...}}` string reaching AWS as a
  // password is a PREDICTABLE credential, not merely a broken value.
  //
  // `CrossAccountSecretRefusalError` — an `IntrinsicResolutionRefusalError`
  // SUBCLASS, so an `Fn::Sub` still re-raises it instead of laundering it into
  // a literal `${...}` — and non-retryable because the inputs (a persisted
  // state record, a template's literal `RoleArn`) are ones no retry can
  // change. The subclass exists because this is the ONE refusal in the family
  // that is PERMANENT: the other five (a stale placeholder ARN, a fabricated
  // account, an unenriched `Fn::GetAtt`, `--strict-getatt`, a malformed
  // `Fn::Split`) are all user-fixable, so a consumer treating the base class
  // as "no re-run can change this" downgrades all five (issue #2133 review).
  //
  // GATED ON THE DEPLOY PATH. Under `skipDynamicReferences` (the diff / no-op
  // comparison) nothing would be fetched from any account — a secret
  // reference is left unresolved by design — so there is no wrong-account
  // read to refuse, and refusing anyway would make `cdkd diff` fail (or, via
  // the diff calculator's best-effort catch, degrade to the raw intrinsic)
  // for a template that deploys fine everywhere except this one cross-account
  // output. The comparison then does what it does for every other secret:
  // compares expression against expression.
  if (roleArn && !context.skipDynamicReferences && carriesDynamicReference(value)) {
    // Only the RENDERING of `roleArn` changed here (issue
    // go-to-k/cdkd#3397). The SUBCLASS and the `markNonRetryable` marker are
    // untouched and must stay: `cdkd scrub` branches on
    // `CrossAccountSecretRefusalError` by `instanceof` down the cause chain
    // to tell this PERMANENT refusal from its user-fixable siblings
    // (`.claude/rules/intrinsic-refusals.md`), and the marker keeps a
    // substring-matching retry classifier from reading template-controlled
    // text as transient.
    // not-in-class(shownRoleArn): the RoleArn argument, refused unless it is a literal template string.
    throw markNonRetryable(
      new CrossAccountSecretRefusalError(
        `Fn::GetStackOutput: output ${loggedOutputName} of stack ${loggedStackName} (${displayIdent(loggedRegion)}) is a ` +
          `redacted dynamic reference, and this is a CROSS-ACCOUNT reference (RoleArn ` +
          `${shownRoleArn}). cdkd will not resolve a producer account's secret with the consumer's ` +
          `credentials — a same-named secret in the consumer account would answer instead. ` +
          `Export a non-secret value (e.g. the secret's ARN) and resolve it in the consumer ` +
          `stack, or reference the producer stack from within its own account.`
      )
    );
  }

  return await this.reresolveCrossStackValue(
    value,
    region,
    context,
    // All THREE operands, not the two the first pass moved. `loggedRegionText`
    // survived raw one operand to the left of two sanitized ones — the
    // "guard defeated by its own neighbour" shape, on the line the guard was
    // added to. It is not an exposure on the template-supplied path
    // (`isClientSafeRegion(canonicalizeRegion(...))` gates it, and no control
    // character lower-cases into `[a-z0-9-]`), but the DEFAULT path binds
    // `logTextOfLeaf(this.resolverRegion)`, which has no such gate. Sanitized
    // here rather than annotated, because this string flows into
    // `redactedAttributeReads[].display` and out through a
    // `ProvisioningError` message, and this whole tree is outside
    // `inMixedScope` so no fence watches it.
    //
    // (That sentence named the tree with a trailing glob until the scanner
    // fence caught it. A path separator directly followed by a star is a
    // block-comment opener as far as that stripper is concerned -- it runs
    // before line comments are removed, so a line comment is no shelter --
    // and the accidental span swallowed 1,036 characters of real code. Do
    // not write a glob in a comment in this file; the fence in
    // `tests/unit/deployment/resolver-display-masked-population.test.ts`
    // will refuse it, and its message will say so.)
    `Fn::GetStackOutput ${quotedRender(this.displayLeaf(outputName, context), "'")} (producer ${this.displayLeaf(stackName, context)} / ${this.displayLeaf(loggedRegionText, context)})`,
    sourceKey,
    // Issue #2274: this read is `outputs[outputName]` of that producer's
    // state, so the coordinate is exact — see the ImportValue arms. A
    // `RoleArn` makes it cross-ACCOUNT, which the coordinate cannot express,
    // so recovery is refused there rather than answered from the ambient
    // account's store.
    { stackName, region, outputKey: outputName, ...(roleArn ? { crossAccount: true } : {}) },
    loggedRegionText
  );
}

/**
 * Push a resolved `Fn::GetStackOutput` into the consumer's
 * recorded-output-reads bag (schema v8+, issue #668). Skips
 * duplicates within the SAME bag — multiple references to the
 * same `(sourceStack, sourceRegion, outputName)` triple emit one
 * entry. Same dedup discipline as `recordImport`.
 */
export function recordOutputRead(
  this: IntrinsicFunctionResolver,
  context: ResolverContext,
  producerStack: string,
  producerRegion: string,
  outputName: string
): void {
  if (!context.recordedOutputReads) return;
  const dup = context.recordedOutputReads.some(
    (e) =>
      e.sourceStack === producerStack &&
      e.sourceRegion === producerRegion &&
      e.outputName === outputName
  );
  if (dup) return;
  context.recordedOutputReads.push({
    sourceStack: producerStack,
    sourceRegion: producerRegion,
    outputName,
  });
}

/**
 * A text transform replacing each RAW name this frame handed to another
 * module with the masked spelling it holds for it (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)), or `undefined` when
 * no pair carries a mask.
 *
 * This is what the BAGS structurally cannot do. A bag masks by VALUE, and a
 * plaintext shorter than `MIN_NEEDLE_LENGTH` matches only as the WHOLE text,
 * so a 1-3 character secret an `Fn::Sub` assembled into a longer name is
 * invisible to it — while this frame knows the exact spans.
 *
 * A pair that DOES carry a mask contributes its raw spelling AND the spelling
 * the reader will actually see. `S3StateBackend` prints names through
 * `displayStackName`, whose first step is
 * `displaySafe(..., { asciiOnly: true })`, which REPLACES every non-printable
 * character with a space and then trims, so a secret carrying one is a
 * DIFFERENT string by the time it is quoted back and matching the raw form
 * alone would miss it while reporting success — the one-string-space rule
 * `outputs-export-alias/secret-scan.ts` states for its own scan: the text that was tested
 * and the text that is printed must be the same text. The CloudFormation
 * fallback does NOT sanitize (it rethrows the SDK's message as it is), so the
 * second spelling is inert at that call site and costs one comparison.
 *
 * NO MINIMUM LENGTH beyond non-empty, deliberately. A one-character masked
 * name rewrites every occurrence of that character in the sentence
 * (`a` -> `***` turns `us-east-1` into `us-e***st-1`), which is unreadable
 * but SAFE — the direction this function must never get wrong is printing
 * too little, not too much, and a floor here would be a floor on masking.
 *
 * `raw !== ''` is DEFENSIVE, and it is NOT the guard that handles a name
 * whose sanitized form is empty — that one inspects `shown`, below, and its
 * own comment says why. What this clause is not is redundant against
 * `raw !== masked`: `rememberLogTwin` has no empty-key guard and
 * `splitLogTwins` registers every piece it produces, so `registeredLogTwin`
 * can answer `***` for the empty string and make `maskSecretsRaw('')`
 * differ from `''`. Neither call site can reach it — both refuse an empty
 * name upstream — so it fences nothing measured today.
 *
 * LONGEST KEY FIRST — over every key, raw and sanitized alike, which is what
 * the comparator sees — so a key that contains another is rewritten as itself
 * rather than having the inner one replaced underneath it. **That ordering
 * is DEFENSIVE and this suite does not distinguish it** — measured: reversing
 * the comparator leaves every case green. The reason is that no case here
 * builds two raws that NEST: the one case with two surviving pairs masks a
 * stack name and a region that share no substring, and everywhere else one
 * pair is dropped for carrying no mask. It earns its place on the shape that
 * DOES diverge — a shorter raw whose mask is not a prefix of the longer's
 * (`q7` -> `***` beside `q7x` -> `***` turns `q7x` into `***x` shortest-first,
 * leaking the `x`) — which needs two separately recorded secrets, one of them
 * masked WHOLE, and is not constructed here. Recorded as measured rather than
 * claimed fenced.
 */
export function positionalNameMask(
  this: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[]
): ((text: string) => string) | undefined {
  const substitutions = pairs
    // DROP AN UNMASKED PAIR FIRST, and the order is the whole correctness
    // argument rather than a tidying. Expanding first and filtering after
    // tests the tuple that came out of the expansion, so for a pair carrying
    // NO mask (`masked === raw`) the `[raw, raw]` entry is dropped while
    // `[shown, raw]` survives — a transform that rewrites the SANITIZED
    // spelling back into the RAW one. That un-does the `displaySafe` the
    // printing module applied on purpose (issue #3003), re-opening the
    // padded-name spoof `display-safe.ts` documents and putting a live
    // escape sequence back on the terminal, and it corrupts unrelated text
    // besides (`production` -> `prod uction` for a name `prod `). Measured,
    // and a leading space is enough to reach it — no non-ASCII needed,
    // because `trim()` is part of the transform.
    .filter(([raw, masked]) => raw !== '' && raw !== masked)
    .flatMap(([raw, masked]) => {
      // THE INVARIANT, and the only thing to check when touching this: a
      // substitution's REPLACEMENT must be at least as sanitized and at
      // least as masked as its KEY. Three review rounds each broke it a
      // different way and each was fixed by enumerating one more shape, so
      // it is stated once here and enforced at construction instead.
      //
      // PER ENTRY, and deliberately not a claim about the COMPOSITION. Each
      // replacement is masked against its OWN twin only, so one pair's
      // secret can survive as a literal inside another's replacement — the
      // longer key runs first and the shorter one no longer matches there.
      // Measured, and the twin's SPAN is what decides it, so the spelling
      // matters: stack `us-qq-1x` twinned `us-qq***x` beside region
      // `us-qq-1` twinned `us-***-1` leaves the region's `qq` inside the
      // stack entry's replacement. Twin the stack as `us-***-1x` instead —
      // the reading where both names mask the shared secret — and nothing
      // survives, which is why naming the span is part of the claim. That is
      // the `q7`/`q7x` residual recorded at the
      // sort, one composition over, and it is not a regression: every step
      // replaces text with a value at least as masked, so the result is
      // never weaker than the sentence the sink printed. Closing it means
      // feeding each replacement through the other entries' masks here.
      //
      // The raw key is what a sink that did NOT sanitize prints, so it takes
      // the twin as it is. The sanitized key is what a sink that DID prints,
      // and its replacement is sanitized to match — the twin keeps the
      // template's literal parts VERBATIM (only the secret span becomes
      // `***`), so an unsanitized replacement there puts the control
      // characters the printer had just removed back into the message, in
      // the top-level text neither `formatError` nor the logger sanitizes.
      const shown = displaySafe(raw, { asciiOnly: true });
      // A THIRD spelling (go-to-k/cdkd#3617): `S3StateBackend` now renders a
      // name through `displayStackName`, which puts a non-plain name inside a
      // JSON string -- so a `"` or `\` in it reaches the message ESCAPED, and
      // neither spelling above matches it there. Its replacement is escaped
      // the same way, so it is as sanitized and as masked as its key.
      const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);
      // ...and a FOURTH, the whole rendered token: `displayStackName` CUTS a
      // name past `STACK_REF_MAX_CODE_POINTS`, and a cut prefix matches none
      // of the whole-name keys -- a sub-floor secret inside it, or the shown
      // half of a secret straddling the cut, would print. The rendered token
      // is replaced with the rendering of the masked text, so it fails closed.
      const rendered = displayStackName(raw);
      const escapedPair = [
        ...(shown !== '' && escaped(shown) !== shown
          ? [[escaped(shown), escaped(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
        ...(rendered !== raw && rendered !== shown && rendered !== escaped(shown)
          ? [[rendered, displayStackName(displaySafe(masked, { asciiOnly: true }))] as const]
          : []),
      ];
      if (shown === raw) return [[raw, masked] as const, ...escapedPair];
      // Empty after sanitizing: substituting `''` splices the replacement
      // between every character, so that key contributes nothing. The
      // `shownMask` half of that test is UNREACHABLE and kept as the other
      // side of one rule rather than as a live case — `masked !== raw` is
      // already guaranteed above, so masking fired and the text contains
      // `***`, which `displaySafe` preserves.
      const shownMask = displaySafe(masked, { asciiOnly: true });
      return shown === '' || shownMask === ''
        ? [[raw, masked] as const]
        : ([[raw, masked] as const, [shown, shownMask] as const, ...escapedPair] as const);
    })
    .sort(([a], [b]) => b.length - a.length);
  if (substitutions.length === 0) return undefined;
  return (text: string): string => {
    let out = text;
    for (const [raw, masked] of substitutions) out = out.split(raw).join(masked);
    return out;
  };
}

/**
 * Mask a failure raised by a module this resolver handed RAW names to (issue
 * [#3234](https://github.com/go-to-k/cdkd/issues/3234)).
 *
 * Returns a masked CLONE of the whole cause chain, not a new wrapper, and
 * that is the point: `formatError` renders `Caused by: <cause>`, so masking
 * only a fresh top-level message leaves the original message one link down
 * and prints it anyway. The clone keeps the class, every own descriptor
 * (`markNonRetryable`'s non-enumerable symbol, `$metadata`, and `Code` /
 * `name` verbatim), other data values masked,
 * and the chain shape, so every reader that classifies this error still
 * does — see `maskSecretsInError`'s own doc.
 *
 * `pairs` are (raw, masked-log-text) for the names this frame handed over;
 * {@link positionalNameMask} turns them into the transform and owns why.
 */
export function maskStateReadError(
  this: IntrinsicFunctionResolver,
  error: unknown,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): never {
  throw this.maskNamedError(error, this.positionalNameMask(pairs), context);
}

/**
 * {@link maskStateReadError}'s body, RETURNING the masked clone rather than
 * throwing it, so {@link namedRequestMasks} can hand the same answer to an
 * SDK call site (go-to-k/cdkd#3171). `extraMask` is a
 * {@link positionalNameMask} transform, or `undefined` for none.
 */
export function maskNamedError(
  this: IntrinsicFunctionResolver,
  error: unknown,
  extraMask: ((text: string) => string) | undefined,
  context?: ResolverContext
): unknown {
  // The SAME two bags in the SAME order as `maskSecretsRaw`, for the same
  // reason (issue #1903 round 2): on a nested-stack child the parent's
  // decrypted parameter plaintext lives in the inherited bag alone until a
  // `{Ref: <Param>}` resolution copies it across.
  //
  // `extraMask` rides the FIRST pass only. It is not idempotent against
  // itself in general — a masked spelling could in principle contain another
  // pair's raw text — and re-running it over text the first pass already
  // rewrote is how a second substitution would corrupt the first. One pass
  // is also all it needs: `maskSecretsInError` walks the whole chain, so a
  // single call reaches every link.
  let masked: unknown = error;
  let positional = extraMask;
  // ONE pass over the UNION of both bags (go-to-k/cdkd#4049): masked bag by
  // bag, the first bag's shorter needle cut a longer needle the second bag
  // held, and the rest of it printed. `hasMaskableValues`, not `size`
  // (go-to-k/cdkd#1998): a bag holding only log-only needles still masks.
  // The print-only corpus joins it (go-to-k/cdkd#4043): an error is RENDERED.
  const union = unionOfSecretBags([
    context?.inheritedSecrets,
    context?.recordedSecretValues,
    context?.printingSecrets,
  ]);
  if (hasMaskableValues(union)) {
    masked = maskSecretsInError(masked, union, positional);
    positional = undefined;
  }
  // FAIL CLOSED when both bags are empty. An earlier revision deleted this
  // arm, reasoning that a pair carries a mask only when the masker changed
  // the name, which needs a twin or a bag, and a twin's spans come from a
  // recorded secret — so `extraMask` should imply a non-empty bag.
  //
  // THAT ARGUMENT IS NOW FALSE, and go-to-k/cdkd#3426 is what falsified it:
  // the pairs are built with `displayMasked`, whose result differs from its
  // input for a CONTROL CHARACTER alone — no twin, no bag, nothing recorded.
  // `positionalNameMask`'s filter is `raw !== masked`, so a hostile name with
  // both bags empty now reaches this line. It was written as a fail-closed
  // arm against an invariant nobody fenced; it is a REACHED arm today. The
  // cost of not having it is the RAW name rethrown in the clear.
  // `maskSecretsInError` with an empty bag and a transform is exactly the
  // shape its widened early return admits.
  if (positional) masked = maskSecretsInError(masked, new Map(), positional);
  return masked;
}

/**
 * The three masks an AWS SDK call site owes the text the SDK produces about a
 * request that carried template-derived NAMES (go-to-k/cdkd#3171).
 *
 * The resolver masks every name it prints ITSELF through the name's log text
 * (go-to-k/cdkd#3150), but an SDK rejection QUOTES the name it refused back —
 * `ParameterNotFound: <name>`, a region in a describe failure — and that
 * text reached only the needle mask, whose substring arm has the
 * {@link MIN_NEEDLE_LENGTH} floor. A name an `Fn::Sub` assembled around a
 * 1-3 character secret printed masked in the resolver's own words and in the
 * clear a few characters later, in the SDK's.
 *
 * `pairs` are (raw name as SENT, that name's log text), the same shape
 * {@link positionalNameMask} takes and for the same reason; an unmasked pair
 * is dropped there. ONE helper returning all three, so a call site cannot
 * adopt one and miss the others:
 *
 * - `error` — a masked CLONE of the whole cause chain
 *   ({@link maskNamedError}), which keeps the class and every own descriptor,
 *   so `isThrottlingError` / `isMarkedNonRetryable` still classify it;
 * - `text` — a caught message about to be interpolated into a line or a
 *   throw, positional pass first, then {@link displayMasked};
 * - `retryLogger` — for `withRetry`, whose per-attempt `debug` line and
 *   give-up `warn` interpolate the SDK message verbatim.
 *
 * THE WHOLE NAME is the key, never its secret span alone: the substitution
 * rewrites every occurrence of the raw name wherever the SDK put it (inside
 * an ARN, after a colon). That is what reaches a sub-floor secret — the
 * whole name is longer than the secret — and it is also the bound: a name
 * the SDK re-encodes or truncates before quoting it is not matched, and a
 * masked name of 1-3 characters is matched only where the SDK quotes it
 * exactly, which may over-mask unrelated text (the SAFE direction
 * {@link positionalNameMask} documents).
 */
export function namedRequestMasks(
  this: IntrinsicFunctionResolver,
  pairs: readonly (readonly [string, string])[],
  context?: ResolverContext
): NamedRequestMasks {
  // A producer-region GUEST's own region rides along on every request: the
  // guest's clients are built for it, so an endpoint failure quotes it
  // (`getaddrinfo ENOTFOUND secretsmanager.<region>.amazonaws.com`) in text
  // no caller-supplied pair covers, and it is template-derived — the secret
  // ARN's region, which an `Fn::Sub` can assemble around a short secret
  // (go-to-k/cdkd#3171 review). An ordinary resolver's region has no log
  // text and adds nothing.
  const positional = this.positionalNameMask(
    this.explicitRegion !== undefined && this.explicitRegionLogText !== undefined
      ? [...pairs, [this.explicitRegion, this.explicitRegionLogText]]
      : pairs
  );
  const text = (message: string): string =>
    this.displayMasked(positional ? positional(message) : message, context);
  // `displaySafe` TRIMS, so a line `retry.ts` indents would lose its indent;
  // the leading SPACES are carried across (spaces only: nothing a terminal
  // interprets).
  const line = (message: string): string => {
    const indent = /^ */.exec(message)?.[0] ?? '';
    return indent + text(message.slice(indent.length));
  };
  return {
    error: (error) => this.maskNamedError(error, positional, context),
    text,
    retryLogger: {
      debug: (message) => this.logger.debug(line(message)),
      // UNREACHABLE from `sendWithThrottleRetry` today: `withRetry` warns only
      // after a propagation / cooldown / server-error retry, and a caller
      // passing its own `isRetryable` counts none. Masked anyway, since the
      // interface makes it optional rather than absent.
      warn: (message) => this.logger.warn(line(message)),
    },
  };
}
