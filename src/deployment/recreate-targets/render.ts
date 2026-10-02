import { renderStatefulReason } from '../../provisioning/stateful-types.js';
import { recordedProtectionNote } from '../../provisioning/recorded-protection.js';
import { CC_BROKEN_REASON } from '../../provisioning/provider-registry.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { plainIdentOr } from '../../utils/display-safe.js';
import { type RecreateTargetsValidation, NESTED_STACK_RESOURCE_TYPE } from './validate.js';

/**
 * Render the validation failures into a single multi-line error
 * message. Returns `null` when the validation was clean (no errors).
 * The deploy command throws this string as the message of a
 * `ProvisioningError` so the surface is `cdkd deploy` exit code 1
 * with the same shape as other pre-flight failures.
 */
export function renderRecreateTargetsErrors(validation: RecreateTargetsValidation): string | null {
  const lines: string[] = [];

  // Reviewer caught: shared error categories (unknownLogicalIds /
  // missingFromState / blockedStatefulTargets) can be triggered by EITHER
  // direction's list, so the prefix needs to be neutral — naming
  // `--recreate-via-cc-api` when the user only passed
  // `--recreate-via-sdk-provider` is misleading. Use the umbrella prefix.
  const FLAG_UMBRELLA = '--recreate-via-cc-api / --recreate-via-sdk-provider';

  if (validation.unknownLogicalIds.length > 0) {
    lines.push(
      `${FLAG_UMBRELLA} named ${validation.unknownLogicalIds.length} ` +
        `logical id(s) not present in the synth template:`
    );
    for (const id of validation.unknownLogicalIds) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  Fix: confirm each id exists in the template (CDK display path is the ` +
        `parent; the logical id is the CFn-emitted name, e.g. ` +
        `cdkd synth | jq '.Resources | keys'). Recreate operates on the ` +
        `synth template's logical ids, not CDK display paths.`
    );
    // Issue [#2567] — the multi-stack shape, rendered for EVERY unknown id
    // rather than only for a template with nested stacks: a plain multi-stack
    // app is exactly the audience, and gating this on nesting made it
    // unreachable for them.
    //
    // THIS PARAGRAPH DELIBERATELY DOES NOT DESCRIBE WHAT THE RUN DOES NEXT.
    // Three review rounds produced three different wrong descriptions of that
    // — "one unknown id fails the entire run" (WorkGraph has no fail-fast),
    // "only the stacks that could not resolve it stop" (a stack depending on a
    // refuser is skipped too), and "the stack that owns the id, where the
    // recreate DOES run" (that owner is itself skipped when it depends on a
    // refusing stack). The orchestration is genuinely intricate — the flag list
    // is run-global while each stack validates it against its OWN template, so
    // every stack that does not declare the id refuses — and none of it is what
    // a user at this prompt needs. What they need is which stack to name it in.
    // Say only that. The unit case pins this note's rendered LINE by equality,
    // so a rewrite -- or an appended sentence -- reds and has to be argued for;
    // two weaker instruments were tried first and each let a fresh wrong
    // description through.
    lines.push(
      `  Note: each stack of this deploy validates this WHOLE flag list ` +
        `against its OWN template, so an id declared by a different stack of ` +
        `the same run is reported here as unknown. Name it in a deploy of ` +
        `only that stack.`
    );
    // Issue [#2567] — the nesting shape, which IS gated on the template
    // actually declaring a nested stack so an ordinary typo keeps the plain
    // message. Not a typo and not fixable by re-reading the template: the
    // flags name logical ids of the stack being deployed, and the engine
    // matches them only against that stack, so a child's resource is not
    // addressable from here.
    if (validation.nestedStackLogicalIds.length > 0) {
      lines.push(
        `  Note: resources inside a nested stack are NOT addressable — the ` +
          `flags name logical ids of the stack being deployed, and this ` +
          `template's nested stack(s) (` +
          `${validation.nestedStackLogicalIds.join(', ')}) carry their own. ` +
          `A logical id that a nested child happens to share with a top-level ` +
          `resource recreates the TOP-LEVEL one only, and the nested stack ` +
          `row itself is refused as a target.`
      );
    }
  }

  if (validation.missingFromState.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} named ${validation.missingFromState.length} ` +
        `logical id(s) the template declares but cdkd state has no record of:`
    );
    for (const id of validation.missingFromState) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  These are fresh CREATEs on the next deploy — recreate has nothing ` +
        `to destroy first. Remove the flag for these resources; the auto-route ` +
        `via Cloud Control (#614) handles fresh deploys for silent-drop properties, ` +
        `and SDK Provider is the default for everything else.`
    );
  }

  if (validation.ambiguousIntent.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Ambiguous intent — ${validation.ambiguousIntent.length} resource(s) ` +
        `are named in BOTH --recreate-via-cc-api and ` +
        `--prefer-sdk-route with the same Type:Prop on a ` +
        `silent-drop property the template uses:`
    );
    for (const overlap of validation.ambiguousIntent) {
      lines.push(
        `  - ${overlap.logicalId} (${overlap.resourceType}) — both ` +
          `--recreate-via-cc-api ${overlap.logicalId} (would migrate to CC, ` +
          `honoring ${overlap.property}) AND ` +
          `--prefer-sdk-route ${overlap.resourceType}:${overlap.property} ` +
          `(would keep on SDK, accepting silent drop)`
      );
    }
    lines.push(`  Fix: pick ONE strategy per resource.`);
  }

  if (validation.blockedStatefulTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} would destroy + recreate ` +
        `${validation.blockedStatefulTargets.length} stateful resource(s). ` +
        `Recreate loses ALL data — no automatic data migration. Re-run with ` +
        `--force-stateful-recreation to acknowledge the data-loss footgun.` +
        (validation.blockedStatefulTargets.some((t) => t.protectionEvidence !== undefined)
          ? ` A resource carrying deletion protection needs more than that flag: see ` +
            `the note under it.`
          : '')
    );
    for (const blocked of validation.blockedStatefulTargets) {
      lines.push(
        `  - ${blocked.logicalId} (${recordedTypeShown(blocked.resourceType)}) — ` +
          `${renderStatefulReason(blocked.statefulReason)}`
      );
      if (blocked.protectionEvidence !== undefined) {
        lines.push(
          `    ${recordedProtectionNote(blocked.protectionEvidence, '--force-stateful-recreation')}`
        );
      }
    }
  }

  if (validation.blockedNestedStackTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `${FLAG_UMBRELLA} refuses to operate on ` +
        `${validation.blockedNestedStackTargets.length} nested-stack resource(s):`
    );
    for (const blocked of validation.blockedNestedStackTargets) {
      // `resourceType` is the STATE record's. When the TEMPLATE is the nested
      // half, say both: refusing something the state calls an SNS topic reads
      // like a mistake with no second type shown. The mirror shape (state
      // nested, template ordinary) prints the state type alone — the row is
      // still refused, and naming the ordinary template type would explain
      // nothing about why.
      const templateType = validation.nestedStackLogicalIds.includes(blocked.logicalId)
        ? NESTED_STACK_RESOURCE_TYPE
        : undefined;
      const shown =
        templateType && templateType !== blocked.resourceType
          ? `${recordedTypeShown(blocked.resourceType)} in state, ${templateType} in the template`
          : recordedTypeShown(blocked.resourceType);
      lines.push(`  - ${blocked.logicalId} (${shown})`);
    }
    lines.push(
      `  Recreating one would DELETE the whole child stack — every resource it ` +
        `owns, with no per-resource confirmation — and re-create it through a ` +
        `layer that does not implement cdkd's nested-stack handling. Where ` +
        `cdkd holds no state for that child, the delete is a no-op instead and ` +
        `the old resource is silently left behind. There is ` +
        `no --force-stateful-recreation bypass. A resource inside a child is ` +
        `not addressable by these flags at all.`
    );
  }

  if (validation.blockedMultiRegionTargets.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api / --recreate-via-sdk-provider refuses to operate on ` +
        `${validation.blockedMultiRegionTargets.length} multi-region resource(s) — ` +
        `out of scope for v1 of these flags (the destroy + recreate cycle across ` +
        `replica regions is more involved than the single-region path):`
    );
    for (const blocked of validation.blockedMultiRegionTargets) {
      lines.push(`  - ${blocked.logicalId} (${blocked.resourceType})`);
    }
    lines.push(
      `  No --force-stateful-recreation bypass — this category is structurally ` +
        `unsupported in v1. File an issue if you need this path.`
    );
  }

  // #651 reverse-direction errors.
  if (validation.conflictingDirections.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Conflicting recreate direction — ${validation.conflictingDirections.length} ` +
        `logical id(s) named in BOTH --recreate-via-cc-api AND ` +
        `--recreate-via-sdk-provider:`
    );
    for (const id of validation.conflictingDirections) {
      lines.push(`  - ${id}`);
    }
    lines.push(
      `  Fix: pick ONE direction per resource. The two flags drive opposite ` +
        `provisionedBy targets ('cc-api' vs 'sdk').`
    );
  }

  if (validation.blockedAlreadySdk.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-sdk-provider named ${validation.blockedAlreadySdk.length} ` +
        `resource(s) that are NOT currently sticky on Cloud Control API (the ` +
        `reverse migration is a no-op):`
    );
    for (const blocked of validation.blockedAlreadySdk) {
      lines.push(`  - ${blocked.logicalId} (${recordedTypeShown(blocked.resourceType)})`);
    }
    lines.push(
      `  Fix: drop these logical ids from --recreate-via-sdk-provider. ` +
        `They are already SDK-managed (or pre-v7 legacy state, treated as SDK).`
    );
  }

  // #665 — mirror of blockedAlreadySdk for the forward direction.
  if (validation.blockedAlreadyCcApi.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api named ${validation.blockedAlreadyCcApi.length} ` +
        `resource(s) that are ALREADY sticky on Cloud Control API (the ` +
        `migration is a no-op):`
    );
    for (const blocked of validation.blockedAlreadyCcApi) {
      lines.push(`  - ${blocked.logicalId} (${recordedTypeShown(blocked.resourceType)})`);
    }
    lines.push(
      `  Fix: drop these logical ids from --recreate-via-cc-api. ` +
        `They are already CC-managed; a destroy + recreate cycle would ` +
        `produce the same end state at the cost of unnecessary downtime.`
    );
  }

  if (validation.blockedNoCcRoute.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api named ${validation.blockedNoCcRoute.length} ` +
        `resource(s) of types Cloud Control API cannot create:`
    );
    for (const blocked of validation.blockedNoCcRoute) {
      lines.push(`  - ${blocked.logicalId} (${blocked.templateType}) — ${blocked.reason}`);
    }
    lines.push(
      `  The recreate deletes the existing resource first and then creates it ` +
        `through Cloud Control, which would fail and leave the resource deleted. ` +
        `None of these resources was touched. Fix: drop these logical ids from ` +
        `--recreate-via-cc-api; they stay on their current route. There is no bypass flag.`
    );
  }

  if (validation.blockedCcBroken.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-cc-api named ${validation.blockedCcBroken.length} ` +
        `resource(s) of types cdkd never runs on Cloud Control (${CC_BROKEN_REASON}):`
    );
    for (const blocked of validation.blockedCcBroken) {
      lines.push(`  - ${blocked.logicalId} (${blocked.templateType})`);
    }
    lines.push(
      `  cdkd keeps these types on their SDK provider whatever the flag says, so the ` +
        `recreate would delete each resource and create it again on the same SDK route. ` +
        `None of these resources was touched. Fix: drop these logical ids from ` +
        `--recreate-via-cc-api.`
    );
  }

  if (validation.blockedNoSdkProvider.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `--recreate-via-sdk-provider named ${validation.blockedNoSdkProvider.length} ` +
        `resource(s) of types cdkd has no SDK provider for (Tier 2 CC-only):`
    );
    for (const blocked of validation.blockedNoSdkProvider) {
      lines.push(`  - ${blocked.logicalId} (${recordedTypeShown(blocked.resourceType)})`);
    }
    lines.push(
      `  Fix: drop these logical ids from --recreate-via-sdk-provider. ` +
        `The destroy + recreate would route via Cloud Control anyway — there's ` +
        `no SDK alternative available.`
    );
  }

  if (validation.ambiguousIntentSdk.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(
      `Inverse ambiguous intent — ${validation.ambiguousIntentSdk.length} ` +
        `--recreate-via-sdk-provider target(s) would IMMEDIATELY be re-routed ` +
        `back to Cloud Control after the recreate because their template uses ` +
        `silent-drop properties NOT in --prefer-sdk-route:`
    );
    for (const overlap of validation.ambiguousIntentSdk) {
      lines.push(
        `  - ${overlap.logicalId} (${recordedTypeShown(overlap.resourceType)}) — template uses ` +
          `${overlap.property}; the default-on CC auto-route would re-route ` +
          `the recreated resource back to CC immediately`
      );
    }
    lines.push(
      `  Fix: pass each silent-drop property to --prefer-sdk-route as TYPE:PROPERTY ` +
        `so the recreated resource stays on SDK with the ` +
        `property explicitly dropped. Or drop --recreate-via-sdk-provider — ` +
        `the resource already routes via CC and honors the property.`
    );
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * A refusal row's type is the STATE record's, chosen by a state-bucket writer
 * (go-to-k/cdkd#4165): a plain type prints as before, any other is described,
 * so no pasted span of the refusal runs and no newline forges a row.
 */
function recordedTypeShown(resourceType: string): string {
  return plainIdentOr(resourceType, 'a resource type that is not a plain identifier');
}

/**
 * Trim-then-lower-case, the pair `CloudControlProvider` applies to both sides
 * of its own region assert. `canonicalizeRegion` only lower-cases, so a state
 * record carrying stray whitespace would still fail a `!==` compare.
 */
export function foldRegion(region: string | undefined): string | undefined {
  return canonicalizeRegion(region?.trim());
}
