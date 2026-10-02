import { CdkdError } from '../../utils/error-handler.js';
import { type ResolverContext } from '../intrinsic-function-resolver.js';
import { carriesSecretMask, SECRET_MASK, type RecordedSecretValues } from '../secret-redaction.js';
import { defineOwnKey } from '../../utils/own-keys.js';
import {
  ReplayResolvers,
  refuseUnprovenReplaySecret,
  resolveLeafByRegion,
} from './replay-secrets.js';
import { type RollbackExecutorContext } from './types.js';
import { shownLogicalId } from './messages.js';

/**
 * `provider.update()` for a rollback arm, retried unless the provider opts out.
 *
 * Both rollback UPDATE arms need the same three things, and getting any of
 * them wrong is only visible on a recovery path (issue #1461):
 *
 *  - **Retry.** A provider `update()` can issue reads as well as writes (Glue
 *    does a pre-update `GetTable`), and the callers' best-effort catch counts
 *    a transient failure as a real one and moves on, leaving state unreverted.
 *    `deploy-engine.ts` and `drift.ts` have always wrapped their calls; these
 *    arms did not.
 *  - **`disableOuterRetry`.** `CustomResourceProvider` and
 *    `NestedStackProvider` set it AND implement `update()`. Re-invoking a
 *    Custom Resource derives a FRESH RequestId + pre-signed response URL, so
 *    the first attempt's response lands at an S3 key nobody polls — the exact
 *    hang the flag exists to prevent. Those providers retry internally.
 *  - **Interrupt.** `replayRollback` polls interrupts only BETWEEN ops, so an
 *    un-threaded `isInterrupted` leaves Ctrl-C dead for the length of the
 *    backoff schedule per op — ~47s on the generic grid, or ~64s if the op
 *    hits a name cooldown, which rides its own longer grid since issue #2116.
 *
 * A FOURTH thing since issue
 * [#2086](https://github.com/go-to-k/cdkd/issues/2086): the call is bound in
 * {@link withCurrentResourceSecrets} (`resource-secrets-scope.ts`).
 * `resolveReplayProps` has just re-resolved the journal's `{{resolve:...}}`
 * expressions back to PLAINTEXT into `secrets`, so the bag in hand here is
 * exactly the one the deploy engine would have bound, and a reader of that
 * channel sees the same pairs on a revert as on a deploy. The reader this path
 * reaches is `SecretsManagerSecretProvider.asPersisted`.
 *
 * KEEP THE BINDING even though the nested reader below is unreached today.
 * What keeps it unreached is the `replayingState` short-circuit, not anything
 * that makes the binding safe to drop: an update arm reaching
 * `NestedStackProvider.update` WITHOUT `replayingState` would build a child
 * engine, and unbound it seeds nothing and the child's `state.json` persists
 * the DECRYPTED secret (issue #2086). "Absent reads as undefined, the
 * pre-#1903 baseline" is not an acceptable answer HERE.
 *
 * The reader this binding was added for, `NestedStackProvider`, no longer
 * reaches its child engine here: both revert arms pass
 * `UpdateContext.replayingState`, and its `update()` returns through the
 * journal-replay arm (issue #3754, `nested-child-journal.ts`) before
 * `requireDeployContext`. That arm reads no template and deploys no child, so
 * it serves the in-process auto-rollback (a DEPLOY-mode
 * `withNestedStackContext`) and standalone `cdkd rollback` (a destroy-mode one)
 * alike.
 *
 * Returns the provider's result so the caller can honour
 * `effectiveProperties` (issue #1644) — both revert arms used to write the
 * previous state record back verbatim, dropping a narrowing the provider had
 * just announced and leaving the record describing something AWS does not
 * hold.
 */
/**
 * Re-resolve dynamic-reference SECRET expressions
 * (`{{resolve:secretsmanager:...}}`) in a property bag being REPLAYED to a
 * provider during rollback (GHSA fix, issue #1899 review).
 *
 * The rollback journal — and the state record the replay writes — store the
 * redacted EXPRESSION, never the plaintext. But a `provider.update()` /
 * `create()` / `delete()` call must receive the concrete secret value the
 * reference points at, exactly as the forward deploy did; replaying the literal
 * `{{resolve:...}}` string would corrupt the resource (e.g. a Lambda env var or
 * Cognito `client_secret`). Rollback is synth-free, so re-resolve straight from
 * the expression string here.
 *
 * BOTH SIDES OF A DIFF ARE CLASSIFIED, not just the bag that is written, and
 * that is deliberate (issue #2057 review). The `revert` / `--revert-failed`
 * arms call this twice — once for the desired bag and once for the CURRENT /
 * ATTEMPTED one, which only becomes the provider's `previousProperties`. Two
 * things make a wrong-region value there consequential rather than cosmetic:
 * a patch-based provider computes its patch previous-vs-desired, so a wrong
 * previous side can emit a wrong patch or, when both sides carry the same
 * expression and resolve to the same wrong value, silently compute a NO-OP and
 * skip the revert entirely; and every resolved plaintext lands in the SHARED
 * per-op `secrets` map, which is the redaction needle for the state record this
 * op persists, so a foreign-region plaintext mis-redacts that record. In
 * practice both bags carry the SAME expression (state redacts them identically),
 * so scoping the refusal to the written bag would buy a rare case at the cost of
 * a rule nobody could apply by reading one call site.
 *
 * Records each `plaintext -> expression` into `secrets` so the caller can redact
 * the persisted state record back to the expression — the same
 * resolve-for-provider + redact-for-state split the deploy engine applies at its
 * save choke point. A bag with no `{{resolve:...}}` string resolves to a
 * structural copy of itself (secrets stays empty), so the non-secret rollback
 * path is behaviourally unchanged. Which references are RECORDED is the
 * resolver's own secret gate: every `secretsmanager` one, plus an `ssm` one
 * whose parameter is a `SecureString` (issue #1901 — that form decrypts to a
 * real secret, so it is redacted into the journal and must be re-resolved here
 * exactly like a secretsmanager reference). An ssm reference to a `String` /
 * `StringList` parameter is public config, stored resolved, and never appears
 * as an expression in the journal.
 */
export async function resolveReplayProps(
  props: Record<string, unknown> | undefined,
  resolvers: ReplayResolvers,
  secrets: RecordedSecretValues,
  execCtx: RollbackExecutorContext,
  logicalId: string
): Promise<Record<string, unknown> | undefined> {
  if (props === undefined) return undefined;
  const resolverContext: ResolverContext = {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: secrets,
  };
  const walk = async (v: unknown, path: string): Promise<unknown> => {
    if (typeof v === 'string') {
      if (!v.includes('{{resolve:')) return v;
      // Issue #2057: decide the REGION of every reference in this leaf before
      // any of them is fetched. See {@link classifyReplaySecretRegion}.
      refuseUnprovenReplaySecret(v, path, logicalId, execCtx);
      return await resolveLeafByRegion(v, path, logicalId, execCtx, resolvers, resolverContext);
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length) as unknown[];
      for (let i = 0; i < v.length; i++) out[i] = await walk(v[i], `${path}[${i}]`);
      return out;
    }
    if (v !== null && typeof v === 'object') {
      // `defineOwnKey`, never `out[k] = ...` (issue #2776). The journal and the
      // state record are `JSON.parse`d, which makes a property literally named
      // `__proto__` an OWN key, and assigning it onto a `{}` literal runs
      // `Object.prototype`'s setter: the key vanished from the bag the provider
      // is handed, with no error. The resolver's object walk had the same
      // defect one layer up (issue #2767) and this is the same remedy.
      //
      // NOT `nullPrototypeRecord()`, which is what the drift walks use: this
      // bag goes to EVERY provider's `update()` / `create()`, and a
      // null-prototype object throws on `String()` / a template literal and
      // has no `.hasOwnProperty()` method, which no provider audit rules out.
      // Keeping the ordinary prototype makes the key's survival the only
      // behaviour change.
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v))
        defineOwnKey(out, k, await walk(val, path === '' ? k : `${path}.${k}`));
      return out;
    }
    return v;
  };
  return (await walk(props, '')) as Record<string, unknown>;
}

/**
 * Refuse to REPLAY a bag whose recorded baseline holds a REDACTION MASK (issue
 * [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * The rollback twin of `drift --revert`'s
 * `preserveLiveValuesAtMaskedLeaves`, and it exists for the same reason: a
 * `NoEcho` custom resource's `Data` resolved into a dependent's property is
 * persisted as {@link SECRET_MASK}, because there is no expression to store in
 * its place — and this executor replays a persisted bag straight to
 * `provider.update()` / `create()`. Without a guard the literal `***` would be
 * written onto the live resource, which is the issue #1498 / #1501
 * data-corruption class.
 *
 * IT REFUSES rather than substituting, and that is the difference from the
 * drift twin. `--revert` holds an AWS-current readback beside the baseline, so
 * it can leave the position exactly as AWS has it; a replay holds no readback
 * at all — `previousState.properties` IS its only source — so there is nothing
 * to fall back to. Failing the ONE op with an actionable message is strictly
 * better than writing a value cdkd knows is wrong, and the per-op failure
 * accounting this file already has is what carries it.
 *
 * CALLED ON THE WRITTEN SIDE ONLY. Each revert arm resolves two bags; the other
 * one becomes the provider's `previousProperties`, where a mask is harmless (a
 * patch provider comparing `***` against the desired value simply sees a
 * change, which is the correct conclusion — the live value is not what state
 * records). Refusing there would block rollbacks that have no problem.
 */
export function refuseMaskedReplayBaseline(
  props: Record<string, unknown> | undefined,
  logicalId: string
): void {
  if (props === undefined || !carriesSecretMask(props)) return;
  // THREE POPULATIONS REACH THIS REFUSAL, each with its own remedy, because
  // nothing in the record says which wrote the mask (issue
  // [#2881](https://github.com/go-to-k/cdkd/issues/2881)). Naming only the
  // first was a measured defect at the deploy engine's twin
  // (`refuseRedactedAttributeReads`, issue #2847) before it was one here.
  //
  // ARM (2), the `Fn::Base64` encoding of a secret, is the one
  // `resolveBase64` registers as a mask-only needle (issues #2759 / #3119), and
  // it reaches THIS test directly: the deploy persists `***` into the
  // resource's own `properties` (`deploy-engine-base64-secret-noop.test.ts`
  // pins it), so a failed update of an EC2 `UserData` built around a
  // `{{resolve:...}}` reference rolls back onto this refusal. No custom
  // resource is involved, so the nonce remedy does nothing. A deploy that
  // UPDATES the resource sends the encoding again (the recorded `***` differs
  // from the resolved encoding); one that leaves it unchanged sends nothing,
  // since the encoding of an ordinary secret is deliberately not marked fresh.
  // Either way the record keeps `***`, so the next rollback to it refuses too —
  // which is why the arm also names the change that ends the refusals.
  //
  // ARM (3) IS NARROWER THAN THE FIRST ATTEMPT AT IT, and the correction came
  // from a trace rather than from re-reading the prose. This function tests
  // `properties`, while `CloudControlProvider.import` masks only `attributes`
  // (`import.ts` writes the template's own properties into `properties` and the
  // provider's bag into `attributes`) — so "the record was adopted through the
  // Cloud Control fallback" names a route that cannot put a mask HERE, and its
  // re-import remedy pointed at the wrong record. What CAN: `cdkd orphan
  // --force` splicing a mask into a referring resource's properties, and
  // `cdkd import` resolving an `Fn::GetAtt` OR A `Ref` over an already-masked
  // record into the properties it persists. Both are a mask copied FROM
  // another record, which is why the remedy names that record.
  //
  // THE `Ref` HALF IS NOT DECORATION and it is the route a user is likelier to
  // hit (issue #2847 round-4 review). `cdkd import` builds a BAGLESS resolver
  // context, so `refStateLookupFromResource` serves the mask rather than
  // skipping it — that is the whole opt-in argument — and
  // `resolveImportedProperties` then persists `'***'` for a `{Ref: X}` whose
  // state key is masked, exactly as it does for a masked `Fn::GetAtt`. Naming
  // only `Fn::GetAtt` sent a user grepping their template for one that is not
  // there. The ACTION is unchanged: repair the record that HOLDS the mask.
  throw new CdkdError(
    // Described when not plain, never raw: the message names `cdkd deploy`,
    // `cdkd orphan` and `cdkd import` (go-to-k/cdkd#4214).
    `Cannot roll ${shownLogicalId(logicalId)} back: its recorded baseline holds the redaction mask ` +
      `('${SECRET_MASK}'), so cdkd would write that literal to the live resource. There are ` +
      `three ways a baseline comes to hold it. (1) A NoEcho custom-resource value was resolved ` +
      `there: restore the property with 'cdkd deploy' AFTER forcing that custom resource to ` +
      `update (change one of its properties, e.g. a nonce), so its handler runs again and ` +
      `supplies the real value — an ordinary re-deploy leaves the resource unchanged, so the ` +
      `handler does not run and the mask stays. (2) The Fn::Base64 encoding of a secret value ` +
      `(a {{resolve:...}} dynamic reference under Fn::Base64, such as EC2 UserData), which ` +
      `cdkd never records: restore the property with a 'cdkd deploy' that changes this ` +
      `resource, which sends it the encoded value again — a re-deploy that leaves this ` +
      `resource unchanged sends it nothing. Every rollback to such a baseline refuses, so to ` +
      `end this, stop encoding the secret into the property (have the resource read the ` +
      `secret at run time instead — not by writing the secret's plaintext into the template, ` +
      `which cdkd would then record in state in the clear). (3) The value was SPLICED from a masked ` +
      `record of ANOTHER resource — by 'cdkd orphan --force', or by 'cdkd import' resolving ` +
      `an Fn::GetAtt or a Ref over a value the Cloud Control fallback had masked. Repair the ` +
      `record that HOLDS the mask ('cdkd import <stack> ` +
      `--resource <logicalId>=<physicalId> --force', granting cloudformation:DescribeType ` +
      `first if the import warned that it could not read the schema), then re-run whichever ` +
      `command wrote this property. See https://github.com/go-to-k/cdkd/issues/2449.`,
    'ROLLBACK_REDACTED_BASELINE'
  );
}
