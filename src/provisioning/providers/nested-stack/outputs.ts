import type { NestedStackProvider } from '../nested-stack-provider.js';
import { getCurrentResourceSecrets } from '../../../deployment/resource-secrets-scope.js';
import { secretNamedAttributeNamesOf } from '../../../deployment/secret-name-needles.js';
import { recordReferenceProvenanceEntry } from '../../../deployment/secret-redaction/reference-provenance.js';
import { outputReferenceProvenanceOf } from '../../../deployment/reference-provenance-record.js';
import { refuseMalformedNestedChildOutputs } from '../../../state/malformed-resources-bag.js';
import type { NestedStackProviderContext } from '../../nested-stack-context.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  carriesSecretMask,
  recordAttributeIdCopy,
  recoverMaskedOutput,
} from '../../../deployment/secret-redaction.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../utils/ambient-client-defaults.js';
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import { runAccountOf } from './shared.js';

export async function getAttribute(
  this: NestedStackProvider,
  _physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  // The intrinsic-function resolver fast-paths `Fn::GetAtt: [<NestedStack>, 'Outputs.<Key>']`
  // via the resource's recorded `attributes['Outputs.<Key>']` (populated in
  // create / update). Reaching this method means the resolver fell through
  // the flat-key lookup — only happens when the user references an
  // attribute name cdkd did not record. Surface a clear error rather
  // than returning undefined silently.
  throw markNonRetryable(
    new Error(
      `AWS::CloudFormation::Stack: attribute ${displayIdent(attributeName)} is not in the recorded Outputs map. ` +
        `Only 'Outputs.<Key>' references to declared Output names on the child template are supported.`
    )
  );
}

/**
 * The child's outputs, as `Outputs.<Key>` attributes for the parent's
 * `Fn::GetAtt` — plus the subset whose plaintext this run had to RECOVER
 * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * WHY THE RECOVERY IS HERE. This method reads the child's PERSISTED state,
 * and since #2274 an output whose value resolved a `NoEcho` custom resource's
 * `Data` is persisted as the redaction mask. Handing the parent `***` would
 * make the FIRST deploy of any such parent refuse — a template that deployed
 * before the feature — so where the child engine masked that output moments
 * ago IN THIS PROCESS, the plaintext is still available (see
 * `recoverMaskedOutput`) and is what the parent gets. The reported names are
 * what tells the deploy engine to re-register those values as MASK-ONLY
 * needles, so the parent's own record and every parent resource that consumes
 * one still persist `***`.
 *
 * PER ATTRIBUTE, not for the bag: a child typically exports one sensitive
 * output among several ordinary ones, and declaring the whole bag would mask
 * every unrelated output into the parent's state and into any parent resource
 * that reads one.
 *
 * A mask this run did NOT produce (the child was deployed by an earlier run
 * and its custom resource was `NO_CHANGE`, so no handler ran) is left as the
 * mask, and the resolver refuses the consumer rather than writing `***` to
 * AWS. That refusal is the feature's stated cost; recovering here removes it
 * for the in-run case only.
 */
export async function readChildOutputsAsAttributes(
  this: NestedStackProvider,
  ctx: NestedStackProviderContext,
  childStackName: string,
  childRegion: string
): Promise<{
  attributes: Record<string, unknown>;
  noEchoAttributeNames: string[];
  secretNamedAttributeNames: string[];
}> {
  const childStateData = await ctx.stateBackend.getState(childStackName, childRegion);
  if (!childStateData) {
    throw markNonRetryable(
      new Error(
        `Child stack state ${displayStackName(childStackName)} not found after deploy — NestedStackProvider invariant violated.`
      )
    );
  }
  // AT THE LOAD, above the rebuild it protects (issue #3207). The child's
  // record is UNCHECKED data — `parseStateBody` validates the root object and
  // the schema version and nothing inside — so `outputs` can hold a string, a
  // list, a number, a boolean or `null`, and `Object.entries` walks the first
  // two as readily as a map. Both reads below would then fabricate: a
  // six-character bag becomes six `Outputs.<n>` attributes, which the parent's
  // deploy PERSISTS into the parent's own record and every `Fn::GetAtt`
  // against this nested stack resolves into live AWS calls.
  //
  // REFUSE rather than repair even though this file calls no `saveState`:
  // what it returns is written by its CALLER, so repairing would put a
  // well-formed fabricated attribute set into the parent's record with
  // nothing left to say the child was damaged.
  refuseMalformedNestedChildOutputs(
    childStateData.state,
    childStackName,
    childRegion,
    // The run's account flags (go-to-k/cdkd#4159), as the delete path's.
    runAccountOf(ctx)
  );
  const attributes = this.buildOutputsAttributes(childStateData.state.outputs ?? {});
  // go-to-k/cdkd#4849: an output holding a child resource's physical id (an
  // ARN `!Ref` / `Fn::GetAtt` exported up) is a copy of that id, which the
  // child's record stores in plaintext. The row's bag records it as one for
  // its ATTRIBUTES only (`properties` keep their reference form), so the
  // row's own record keeps it as written even when the row passed the
  // child a `NoEcho` value the id embeds, and a parent `Fn::GetAtt` reader
  // of it still resolves.
  const rowSecrets = getCurrentResourceSecrets();
  // State schema v12 (go-to-k/cdkd#4852): each `Outputs.<Key>` token's
  // provenance is the child's own record of that output, carried into the
  // row's bag on the `read` route; the row persists it beside the attribute.
  if (rowSecrets !== undefined) {
    for (const outputKey of Object.keys(childStateData.state.outputs ?? {})) {
      const entries = outputReferenceProvenanceOf(childStateData.state, outputKey);
      if (entries === undefined) continue;
      for (const [token, entry] of Object.entries(entries)) {
        recordReferenceProvenanceEntry(rowSecrets, token, entry, 'read');
      }
    }
  }
  if (rowSecrets !== undefined) {
    const childResources = childStateData.state.resources;
    const ids =
      childResources !== null && typeof childResources === 'object'
        ? Object.values(childResources as Record<string, { physicalId?: unknown } | null>)
            .map((record) => record?.physicalId)
            .filter((id): id is string => typeof id === 'string' && id !== '')
        : [];
    for (const value of Object.values(attributes)) {
      if (typeof value !== 'string') continue;
      for (const id of ids) if (value.includes(id)) recordAttributeIdCopy(rowSecrets, id);
    }
  }
  const noEchoAttributeNames: string[] = [];
  // The identity the child was deployed with, which is this process's
  // current one (go-to-k/cdkd#3691).
  const identity = credentialFingerprint(ambientCredentialConfig());
  for (const [outputKey, persisted] of Object.entries(childStateData.state.outputs ?? {})) {
    if (!carriesSecretMask(persisted)) continue;
    const recovered = recoverMaskedOutput(identity, childStackName, childRegion, outputKey);
    if (recovered === undefined) continue;
    const attributeName = this.outputAttributeName(outputKey);
    attributes[attributeName] = recovered;
    noEchoAttributeNames.push(attributeName);
  }
  // go-to-k/cdkd#3869: the outputs holding a child resource's name taken
  // from a secret (one its provider rewrote or case-folded, which no
  // recorded plaintext spells). Judged HERE, from the child's records this
  // read already holds, and persisted on the row as KEYS, since a later
  // deploy where the row is NO_CHANGE never runs this method and must not
  // re-read the child's state to learn it. The row's bag holds what the
  // parent passed (a pre-v11 child record's plaintext is judged with it).
  // Known bound: a pre-v11 child record holding a value of the CHILD's own
  // `NoEcho` parameter (its `Default`, not parent-passed) in plaintext is not
  // judged here; a post-v11 one stores `***` and is. Nor are the values each
  // child record STORED where a `NoEcho` parameter served it (the deploy's
  // per-record judge, `recordedNoEchoValuesOf`): judging with them would need
  // the child's template here.
  const childResources = childStateData.state.resources;
  const secretNamedAttributeNames =
    childResources !== null && typeof childResources === 'object'
      ? secretNamedAttributeNamesOf(attributes, childResources, rowSecrets)
      : [];
  return { attributes, noEchoAttributeNames, secretNamedAttributeNames };
}

/**
 * Surface the child's PERSISTED outputs as the parent's `Outputs.<Key>`
 * attributes, VERBATIM — including a secret-bearing one, which PR #1899
 * persists as its unresolved `{{resolve:...}}` expression.
 *
 * DELIBERATELY NOT the place the expression is re-resolved (issue
 * [#2055](https://github.com/go-to-k/cdkd/issues/2055)). Re-resolving here
 * would be easy — `readChildOutputsAsAttributes` is already async — and it
 * would trade one bug for a worse one: this map becomes the parent's
 * `ResourceState.attributes`, and every CONSUMER resource then reads the
 * plaintext through `Fn::GetAtt` with no entry in its OWN
 * `recordedSecretValues`, so the deploy engine's save choke point has nothing
 * to redact it back to and the consumer's `state.json` persists the decrypted
 * secret. Keeping the expression here keeps BOTH the parent's nested-stack row
 * and every consumer's record redacted.
 *
 * The re-resolution therefore lives at the READ site, in
 * `resolveGetAtt` (`deployment/intrinsic-resolver/getatt.ts`), where the CONSUMER's resolver
 * context is in hand — the same seam and the same reason as the
 * `Fn::ImportValue` / `Fn::GetStackOutput` arms of issue #1934.
 *
 * "A read site risks missing a caller" is answered for the RESOLUTION path by
 * there being exactly one: the flat-key attribute lookup, which
 * `getAttribute()` above exists to prove is the only route (it throws for
 * anything that falls through it).
 *
 * It is NOT answered for every reader of `ResourceState.attributes` in the
 * codebase, and an earlier revision of this note claimed it was.
 * `AttributeFetcher.cacheFallback` in `src/analyzer/orphan-rewriter/attribute-fetcher.ts` reads
 * `orphan.attributes?.[attribute]` directly under `cdkd orphan --force` and
 * has no resolver context to re-resolve with, so it splices the token
 * verbatim into the referring resource's state and warns about exactly that.
 * The seam decision above is unchanged — putting the plaintext here would
 * make EVERY consumer persist it — but the count is "one resolution path",
 * not "one reader".
 */
/**
 * The ONE spelling of a child output's attribute name. Both this class's
 * writers go through it, so the recovery pass (issue #2274) cannot name a key
 * `buildOutputsAttributes` did not write.
 */
export function outputAttributeName(this: NestedStackProvider, outputKey: string): string {
  return `Outputs.${outputKey}`;
}

export function buildOutputsAttributes(
  this: NestedStackProvider,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outputs)) {
    attributes[this.outputAttributeName(key)] = value;
  }
  return attributes;
}
