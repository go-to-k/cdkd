import type { CloudControlProvider } from '../cloud-control-provider.js';
import { GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { displaySafe } from '../../utils/display-safe.js';
import {
  getTopLevelAttributeNames,
  isAwsEmulatorRegistryMissType,
} from '../read-only-properties.js';
import { getPrimaryIdentifierFields, toCloudControlIdentifier } from '../cc-import-identifier.js';
import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import type { ResourceImportInput, ResourceImportResult } from '../../types/resource.js';
import { IMPORT_YIELDED_NO_ATTRIBUTES_CONSEQUENCE, maskLeavesDeep } from './id-log.js';

/**
 * Adopt an already-deployed resource into cdkd state via Cloud Control API.
 *
 * Strategy: explicit-override only.
 *   - With `knownPhysicalId` (from `--resource <id>=<physicalId>` or
 *     `--resource-mapping`): call `GetResource(TypeName, Identifier)`,
 *     parse `ResourceModel` (returned as a JSON string by CC API), and
 *     return the ATTRIBUTE keys as `attributes` — see
 *     {@link maskUncertifiedModelValues} for what "attribute" means here and
 *     why every other key comes back MASKED rather than dropped. A bare id
 *     for a type with a COMPOSITE primary identifier is first completed from
 *     the template (`cc-import-identifier.ts`, issue #3672).
 *   - Without `knownPhysicalId`: return `null`. CC API has no efficient
 *     `aws:cdk:path`-tag lookup — `ListResources` returns identifiers
 *     only, so tag lookup would require one `GetResource` per resource
 *     in the account, plus per-service tag-API calls (which CC API
 *     doesn't expose uniformly). Cost vs. value isn't worth it; users
 *     who need adoption for CC-API-only resource types should pass
 *     `--resource <id>=<physicalId>` for those resources.
 *
 * SDK providers (S3, Lambda, IAM Role, etc.) implement their own
 * `import` with tag-based auto-lookup; this fallback only kicks in for
 * resource types that don't have a dedicated SDK provider.
 *
 * ---
 *
 * The rest of this block is the design of the attribute narrowing
 * {@link maskUncertifiedModelValues} performs — every LEAF of a model key
 * cdkd cannot certify is an ATTRIBUTE is replaced with {@link SECRET_MASK},
 * container shape preserved, and the certified attributes are left untouched
 * (issue [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * It lives HERE, on `import()`, rather than in a second block above the
 * method, and that is deliberate: two consecutive block comments attach only
 * the LAST one, so splitting this back out silently orphans whichever doc
 * ends up first. Keep it as ONE block.
 *
 * ## What is being fixed
 *
 * `GetResource` returns the resource MODEL — every readable property, not
 * just the attributes. `cdkd import` persisted that model verbatim into
 * `ResourceState.attributes`, through no redactor, for every
 * Cloud-Control-routed type. Where the model carries a credential, the
 * credential landed in `state.json` in the clear.
 *
 * ## What "attribute" means
 *
 * The names CloudFormation accepts in `Fn::GetAtt`: the resource
 * specification's `Attributes`, resolved by `getTopLevelAttributeNames` as
 * the registry schema's `readOnlyProperties` UNION the writable properties
 * the specification also lists as attributes (`AWS::EC2::Subnet` `VpcId`,
 * `AWS::SQS::Queue` `QueueName`; the generated
 * `getatt-attributes.generated.ts` table). `readOnlyProperties` alone is NOT
 * that set — certifying only it masked `Fn::GetAtt` reads CloudFormation
 * accepts, refusing the deploy with a remedy that re-masked the same key
 * (issue #3735). A key outside the union is never a legitimate
 * `Fn::GetAtt` target, so cdkd persisting it bought nothing a valid
 * template could use.
 *
 * ## Why MASK and not DROP — the load-bearing decision
 *
 * Dropping looks cleaner and is WRONG here, because there is no live
 * fallback on the read side. `resolveGetAtt`
 * (`deployment/intrinsic-resolver/getatt.ts`) looks the key up in this bag and, on a miss, falls through to
 * `constructAttribute` — which synthesizes from `physicalId` alone and, for
 * an attribute name that is neither `*Arn` nor `*Url`, WARNS and returns the
 * physical id. That is a silently wrong value shipped to AWS. There is no
 * `provider.getAttribute` rescue on the deploy path (the only caller of it
 * outside the providers is `cdkd orphan`), and this class has no
 * `getAttribute` at all.
 *
 * Masking keeps the KEY present, so the lookup HITS and the value flows
 * through `noteAttributeSecrecy` into `ResolverContext.redactedAttributeReads`,
 * where the engine's `refuseRedactedAttributeReads` FAILS the resource rather
 * than sending the mask. So the outcome is a loud, named refusal instead of a
 * wrong value — which is the trade this repo already made for the mask-only
 * channel (issue #2274), reusing its machinery rather than inventing a second
 * sentinel nothing downstream recognises.
 *
 * ONE SHAPE ESCAPES THAT, and it is stated rather than left to be discovered:
 * an uncertified EMPTY container (`{}` / `[]`) has no leaf to mask, so no
 * `SECRET_MASK` lands under that key and no refusal can fire for it. A DOTTED
 * read through it breaks at `Object.hasOwn` and falls to `constructAttribute`;
 * a FLAT read returns the empty container itself. It is not a DISCLOSURE — the
 * container was empty at AWS, so there was nothing to disclose — but the
 * refusal genuinely does not fire there.
 *
 * ## The unresolvable-schema arm is FAIL-CLOSED
 *
 * `getTopLevelAttributeNames` answers `undefined` when it could not find
 * out — a missing `cloudformation:DescribeType` grant, an exhausted throttle
 * retry, or a type with no registry entry. cdkd then cannot tell an attribute
 * from a property for this type, so it certifies NOTHING and masks the whole
 * model, warning at default verbosity with the grant to add. Failing OPEN
 * here would make a missing IAM permission silently restore the exact
 * disclosure this method exists to close.
 *
 * ## An UNREADABLE MODEL warns at the same volume as an unreadable schema
 *
 * The two arms below the `GetResource` — a `JSON.parse` failure, and a model
 * that parsed to something other than an object — cannot mask anything (there
 * is no bag to walk), so they yield `attributes: {}`. For a resource with no
 * same-physical-id record in state that is the DROP outcome this design
 * rejects one section up: the key is absent, `resolveGetAtt` falls through to
 * `constructAttribute`, and the physical id ships. (With such a record,
 * `cdkd import` keeps its attributes instead — issue #2927.) "cdkd could not
 * read the model" is the same epistemic state as "cdkd could not read the
 * schema", so both report at DEFAULT verbosity. They used
 * to differ — the schema arm warned while these logged at `debug` — which
 * meant the one outcome that ships a wrong value silently was the one nobody
 * was told about. Neither line prints any part of the model: the parse arm
 * prints the error's NAME only (V8 embeds an input snippet in a
 * `SyntaxError`'s message) and the non-object arm prints the SHAPE only.
 *
 * ## What this does NOT close, stated as the danger direction
 *
 * A CREDENTIAL THAT IS ITSELF A READ-ONLY ATTRIBUTE IS STILL PERSISTED IN THE
 * CLEAR. The attribute set is a structural test, not a sensitivity one, and
 * the registry schema offers nothing better to key on: it has no general
 * sensitivity marking. The nearest things it does have were both checked and
 * neither serves — `"format": "password"` is declared by a single property in
 * AWS's whole published bundle, and `writeOnlyProperties` (a real "cannot be
 * returned by a read" marker, declared by a minority of types) describes
 * values `GetResource` never returns, so masking them would be inert here. So
 * the "mask by the schema's own marking" shape the issue floated is NARROWED
 * to nothing usable rather than refuted outright. Known members of the
 * surviving class include `AWS::IAM::AccessKey`'s `SecretAccessKey`,
 * `AWS::Cognito::UserPoolClient`'s `ClientSecret` and
 * `AWS::EC2::IpamExternalResourceVerificationToken`'s `TokenValue`. The list
 * is not claimed to be exhaustive and no count is quoted here, because
 * nothing in the tree fences one; the derivation and its residual are
 * recorded on the issue.
 */
export async function importImpl(
  this: CloudControlProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) {
    // Explicit-override-only: no auto lookup via CC API.
    return null;
  }

  // CloudFormation's physical id for a type with a COMPOSITE primary
  // identifier is often one segment of it (`AWS::EC2::VPCCidrBlock` reports
  // the bare association id; Cloud Control wants `<Id>|<VpcId>`), so complete
  // it from the template before the lookup — issue #3672. The completed value
  // is also what is RECORDED: it is the id every later Cloud Control call on
  // this resource sends, and the shape a Cloud Control create records.
  // Outside the `try` on purpose: a refusal must fail the import, not be read
  // as `ResourceNotFoundException`.
  const identifier = toCloudControlIdentifier({
    resourceType: input.resourceType,
    logicalId: input.logicalId,
    physicalId: input.knownPhysicalId,
    properties: input.properties,
    fields: await getPrimaryIdentifierFields(input.resourceType),
  });

  try {
    const resp = await this.cloudControlClient.send(
      new GetResourceCommand({
        TypeName: input.resourceType,
        Identifier: identifier,
      })
    );

    // CC API returns `ResourceModel` as a JSON string of the resource's
    // whole model. Its keys do NOT map 1:1 to GetAtt-compatible attribute
    // names — this comment claimed they did until issue
    // [#2847](https://github.com/go-to-k/cdkd/issues/2847) — so the parsed
    // model is filtered through `maskUncertifiedModelValues` before it
    // becomes state.
    //
    // The `try` wraps the `JSON.parse` and NOTHING ELSE. It used to span the
    // masking call too, whose `catch` then turned any failure of the schema
    // lookup into `attributes = {}` under a "Failed to parse" message — the
    // DROP outcome this design explicitly rejects, reached silently and
    // mislabelled. A masking failure must propagate to the outer catch and
    // fail the import loudly.
    // SANITISED because the two lines below are DEFAULT verbosity since this
    // fix round; at `debug` they reached a developer who had asked for them.
    // Both interpolate the `--resource <id>=<physicalId>` value the user
    // typed and the template's own `Type`, neither of which cdkd validates,
    // so an ANSI or line-break sequence in either forges terminal output and
    // JSON-log lines. `asciiOnly` matches what `lock-contention-message.ts`
    // applies to the same class of value.
    const safeType = displaySafe(input.resourceType, { asciiOnly: true });
    const safeId = displaySafe(identifier, { asciiOnly: true });
    let parsedModel: Record<string, unknown> | undefined;
    const raw = resp.ResourceDescription?.Properties;
    if (typeof raw === 'string' && raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsedModel = parsed as Record<string, unknown>;
        } else {
          // A model that PARSED but is not an object (an array, a primitive,
          // `null`) took the same silent path as a parse failure and logged
          // NOTHING — the narrowed `try` walks straight past it. Same
          // outcome, so it gets the same diagnosable line; the SHAPE is safe
          // to name, unlike the value.
          // `typeof null` is `'object'`, so a bare `typeof` renders the null
          // shape as "parsed to object, not an object" — a self-contradiction
          // in the one branch whose entire job is to be diagnosable.
          const shape =
            parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
          this.logger.warn(
            `CC API ResourceModel for ${safeType}/${safeId} parsed to ` +
              `${shape}, not an object — this import yields no attributes for it. ` +
              IMPORT_YIELDED_NO_ATTRIBUTES_CONSEQUENCE
          );
        }
      } catch (parseErr) {
        // NAME ONLY, never the message: V8 embeds an input snippet in a
        // `SyntaxError`, and the input here is the resource model. Measured on
        // Node 24.19.0: `JSON.parse('not-json{{{')` reports
        // `Unexpected token 'o', "not-json{{{" is not valid JSON`, so a
        // truncated model whose head is a credential echoes that credential
        // into the log. Fenced by
        // `tests/unit/provisioning/cloud-control-import-attribute-narrowing.test.ts`.
        this.logger.warn(
          `Failed to parse CC API ResourceModel for ${safeType}/${safeId}: ${
            parseErr instanceof Error ? parseErr.name : typeof parseErr
          }. This import yields no attributes for it. ` + IMPORT_YIELDED_NO_ATTRIBUTES_CONSEQUENCE
        );
        // Fall through with empty attributes — physicalId is enough
        // to register the resource in state. Fn::GetAtt will
        // reconstruct attributes via constructAttribute at deploy.
      }
    }

    const attributes =
      parsedModel === undefined
        ? {}
        : await this.maskUncertifiedModelValues(parsedModel, input.resourceType, identifier);

    return { physicalId: identifier, attributes };
  } catch (error) {
    // ResourceNotFoundException → null (caller marks "not found").
    // Any other error (access denied, bad TypeName, throttling) →
    // re-throw so the caller can surface it.
    const err = error as { name?: string };
    if (err.name === 'ResourceNotFoundException') {
      return null;
    }
    throw error;
  }
}

/**
 * Replace every LEAF cdkd cannot certify belongs to an ATTRIBUTE with
 * {@link SECRET_MASK}, preserving container SHAPE, and leave the certified
 * attributes untouched. The argument for masking rather than dropping, and
 * for the fail-closed `undefined` arm, is on {@link import} above.
 *
 * ## Why the walk is RECURSIVE — this was a measured defect, not caution
 *
 * The first cut replaced the whole VALUE, so an uncertified `Endpoint`
 * object became the string `'***'`. `resolveGetAtt`
 * (`deployment/intrinsic-resolver/getatt.ts`) resolves `Endpoint.Address` by WALKING the dotted path: it tests
 * `typeof cursor === 'object'`, which a string fails, so the walk breaks with
 * `cursor === undefined`, `noteAttributeSecrecy` is NEVER called, and control
 * reaches `constructAttribute` — the physical-id fallback. That is precisely
 * the silently-wrong-value outcome the mask exists to prevent, so
 * whole-value masking DEFEATED its own justification for every nested
 * attribute. Masking leaves keeps the containers walkable, so the walk lands
 * on a `'***'` LEAF and notes it, and the refusal fires — for any container
 * that HAS a leaf. An EMPTY one has none, and `import()`'s doc carries that
 * gap; do not read this sentence as covering it.
 *
 * Arrays keep their length and element positions for the same reason.
 *
 * ## The bag is null-prototype
 *
 * `JSON.parse` can yield a legal own key `__proto__`; assigning that on an
 * ordinary object literal writes the PROTOTYPE instead of an own property and
 * the key vanishes from the bag — a DROP, the one outcome this method must
 * never produce. `Object.create(null)` makes the assignment ordinary.
 */
export async function maskUncertifiedModelValues(
  this: CloudControlProvider,
  model: Record<string, unknown>,
  resourceType: string,
  physicalId: string
): Promise<Record<string, unknown>> {
  // SANITISED for the same reason as `import()`'s two arms: `resourceType` is
  // the template's own `Type` and `physicalId` the `--resource` value the
  // user typed, neither validated by cdkd, and the warn below prints at
  // DEFAULT verbosity where an ANSI or line-break sequence forges output.
  // The debug line takes them too — it is one `--verbose` away, and a split
  // convention inside one method is how the next line gets it wrong.
  const safeType = displaySafe(resourceType, { asciiOnly: true });
  const safeId = displaySafe(physicalId, { asciiOnly: true });
  const attributeNames = await getTopLevelAttributeNames(resourceType);
  if (attributeNames === undefined) {
    // ONCE PER TYPE, not once per resource: a whole-stack import of N
    // Cloud-Control-routed resources of one type would otherwise print N
    // identical default-verbosity warnings. Per-INSTANCE rather than
    // module-global so the set cannot leak between tests (the registry holds
    // one provider instance per run, so production still dedupes).
    if (!this.warnedUnresolvableSchemaTypes.has(resourceType)) {
      this.warnedUnresolvableSchemaTypes.add(resourceType);
      this.logger.warn(
        `Could not resolve the CloudFormation schema for ${safeType}, so ` +
          `cdkd cannot tell which of its Cloud Control model keys are ` +
          `Fn::GetAtt attributes. Every imported attribute for this type is ` +
          `recorded as "${SECRET_MASK}" rather than risking a credential in ` +
          `state.json; an Fn::GetAtt against such a resource fails with a ` +
          `named refusal until that resource is next created or updated by a ` +
          // Under --aws-emulator a type its registry lacks is no missing
          // permission (go-to-k/cdkd#6249): the consequence stays, the
          // impossible remedy goes.
          (isAwsEmulatorRegistryMissType(resourceType)
            ? `deploy. The AWS Emulator's CloudFormation registry has no schema ` +
              `for this type, so no permission change helps here.`
            : `deploy. Grant cloudformation:DescribeType and re-import to record ` +
              `its attributes.`)
      );
    }
  }
  const masked: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let maskedCount = 0;
  for (const [key, value] of Object.entries(model)) {
    if (attributeNames?.has(key)) {
      masked[key] = value;
    } else {
      masked[key] = maskLeavesDeep(value);
      maskedCount++;
    }
  }
  if (maskedCount > 0 && attributeNames !== undefined) {
    this.logger.debug(
      `Masked ${maskedCount} non-attribute key(s) out of the ${safeType} ` +
        `Cloud Control model for ${safeId}: they are not Fn::GetAtt ` +
        `attributes of the type, so CloudFormation would reject an ` +
        `Fn::GetAtt naming them and cdkd has no evidence they are safe to persist.`
    );
  }
  return masked;
}
