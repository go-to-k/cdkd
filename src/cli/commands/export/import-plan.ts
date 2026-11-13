import { commandHole, cdkdRemedy, pasteableCommand } from '../../../utils/pasteable-command.js';
import { displayAwsMessage, isPasteableIdent } from '../../../utils/display-safe.js';
import { type EC2Client } from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { AwsClients } from '../../../utils/aws-clients.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { type ResourceState, type StackState } from '../../../types/state.js';
import {
  carriesSecretMask,
  noEchoLeavesOf,
  SECRET_MASK,
} from '../../../deployment/secret-redaction.js';
import {
  type BlockedResource,
  IMPORT_UNSUPPORTED_RECREATABLE_TYPES,
  type ImportPlanEntry,
  type Phase2CreateEntry,
  type RecreateBeforePhase2Entry,
  RepairableRefusal,
  isNeverImportableType,
  isPhase2CreatableType,
} from './plan-types.js';
import { type NestedStackRow } from './stack-tree.js';
import {
  type PrimaryIdentifierCacheEntry,
  cachedTypeSchemaInfo,
  cfnRefusesImportDespiteRegistry,
  physicalIdIsNotImportIdentifier,
  resolveResourceIdentifier,
  typeIsImportUnsupported,
} from './type-schema.js';
import {
  createIdentifierBackfillDeps,
  deployRepairCommand,
  diffCheckCommand,
  importRepairCommand,
} from './composite-physical-id.js';
import { quotedOrNotShown } from './render.js';
import { policyDetachTargets, policyTemplateCheck } from './pre-delete.js';
import { type CompositeIdResult } from './composite-id-splitters.js';
import { unrepresentableOverlayFields, unrepresentableOverlayMessage } from './template-overlay.js';

/**
 * Build the import plan from cdkd state + the synthesized template.
 *
 * Classifies every template resource into one of:
 *   - `phase1Imports`: importable into the new CFn stack via the IMPORT
 *     changeset. Must have an entry in cdkd state with a non-empty
 *     `physicalId` and a resolvable primary identifier.
 *   - `phase2Creates`: non-importable but `isPhase2CreatableType` — CFn
 *     will CREATE these in the phase-2 UPDATE changeset. Currently only
 *     `Custom::*`.
 *   - `recreateBeforePhase2`: AWS does NOT support IMPORT for these types
 *     (`handlers: []` in the CFn schema) but DOES support normal CREATE.
 *     Skipped from phase 1; the AWS-side resource is deleted between
 *     phases so CFn's phase-2 CREATE doesn't collide. When the user
 *     passes `--no-recreate-import-unsupported`, these are moved to
 *     `blocked` instead.
 *   - `nestedStackRows`: `AWS::CloudFormation::Stack` rows in the parent
 *     template. Surfaced separately because they are handled by the
 *     nested-stack tree walker, not the per-resource IMPORT path
 *     (issue [#464](https://github.com/go-to-k/cdkd/issues/464) PR B1 + PR B2).
 *     The orchestrator currently hard-errors when any are present —
 *     CFn-side `--include-nested-stacks` IMPORT changeset submission
 *     lands in PR B2.
 *   - `blocked`: anything else. A non-empty `blocked` aborts the run.
 */
export async function buildImportPlan(
  state: StackState,
  template: Record<string, unknown>,
  cfnClient: AwsClients['cloudFormation'],
  parentStackName: string,
  options: {
    recreateImportUnsupported: boolean;
    skipImportSupportPreflight?: boolean;
    /**
     * Live-read seam for the identifier BACKFILL (issue
     * [#1791](https://github.com/go-to-k/cdkd/issues/1791)). Optional so a
     * caller with no EC2 client keeps the pre-#1791 state-only behavior
     * verbatim; the real command path always supplies it, and it is consulted
     * ONLY for a row whose state could not answer — see
     * {@link resolveIdentifierValue}.
     */
    ec2Client?: EC2Client;
    /** The app stack a `cdkd diff` / `cdkd deploy` repair names (the ROOT on the nested path). */
    rootStackName?: string;
    /**
     * The Parameter values this stack's changeset SUBMITS — the same values,
     * from the same resolution, never a second copy of it: `--parameter` / a
     * `Default` for the root, `buildResolvedParametersPerStack`'s for a nested
     * child. Lets a principal passed in as a parameter be CHECKED against what
     * phase 2 will actually use (go-to-k/cdkd#3910).
     */
    parameterValues?: Record<string, string>;
    /**
     * `parameterValues` come from `--parameter` / `Default` (the root), so a
     * mismatch through a Parameter can also be a wrong `--parameter` value.
     */
    parametersFromCli?: boolean;
  } = {
    recreateImportUnsupported: true,
  }
): Promise<{
  phase1Imports: ImportPlanEntry[];
  phase2Creates: Phase2CreateEntry[];
  recreateBeforePhase2: RecreateBeforePhase2Entry[];
  nestedStackRows: NestedStackRow[];
  blocked: BlockedResource[];
}> {
  const templateResources = template['Resources'];
  if (
    !templateResources ||
    typeof templateResources !== 'object' ||
    Array.isArray(templateResources)
  ) {
    throw new Error('Template has no Resources section.');
  }

  const phase1Imports: ImportPlanEntry[] = [];
  const phase2Creates: Phase2CreateEntry[] = [];
  const recreateBeforePhase2: RecreateBeforePhase2Entry[] = [];
  const nestedStackRows: NestedStackRow[] = [];
  const blocked: BlockedResource[] = [];
  const identifierCache = new Map<string, PrimaryIdentifierCacheEntry>();
  // Built ONCE per call, not per row: it carries the per-group
  // DescribeSecurityGroupRules memo, so a per-row object would walk the same
  // security group again for every rule sitting on it. Per CALL and not
  // module-global for the reason the field's own docs give — a `--concurrency`
  // run exports several stacks through separate invocations of this function.
  const backfillDeps = options.ec2Client
    ? createIdentifierBackfillDeps(options.ec2Client)
    : undefined;

  for (const [logicalId, raw] of Object.entries(templateResources as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const resource = raw as { Type?: string };
    const resourceType = resource.Type ?? '';
    if (!resourceType) continue;

    if (resourceType === 'AWS::CDK::Metadata') {
      // CDK sentinel — silently dropped. Not a real AWS resource.
      continue;
    }

    if (resourceType === NESTED_STACK_RESOURCE_TYPE) {
      // Nested-stack row. Dedicated branch instead of the per-resource
      // IMPORT path: the AWS-side child stack is adopted via CFn IMPORT's
      // `--include-nested-stacks` flag (PR B2), not via cdkd's
      // resource-identifier resolution. Validate the parent state has a
      // matching row (parent's nested-stack entry carries the cdkd-local
      // synthesized ARN; absence means the cdkd state tree is missing
      // the parent → child link).
      const parentRow = state.resources[logicalId];
      if (!parentRow || parentRow.resourceType !== NESTED_STACK_RESOURCE_TYPE) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `template has AWS::CloudFormation::Stack row ${quotedOrNotShown(logicalId)} but cdkd state has no ` +
            `matching nested-stack entry on parent ${quotedOrNotShown(parentStackName)}. ` +
            `Re-deploy or re-import the parent stack to refresh state.`,
        });
        continue;
      }
      nestedStackRows.push({
        logicalId,
        childStackName: `${parentStackName}~${logicalId}`,
      });
      continue;
    }

    if (isNeverImportableType(resourceType)) {
      if (isPhase2CreatableType(resourceType)) {
        // Custom::* — CFn will CREATE fresh in phase 2.
        phase2Creates.push({ logicalId, resourceType });
      } else {
        // AWS::CDK::Metadata is already short-circuited above; reaching
        // this branch means a future type was added to NEVER_IMPORTABLE_TYPES
        // without phase-2 support. Hard block with a clear pointer so the
        // failure is debuggable.
        blocked.push({
          logicalId,
          resourceType,
          reason: 'CloudFormation cannot import or recreate this resource type',
        });
      }
      continue;
    }

    const stateEntry: ResourceState | undefined = state.resources[logicalId];
    if (!stateEntry || !stateEntry.physicalId) {
      blocked.push({
        logicalId,
        resourceType,
        reason: 'no entry in cdkd state (resource is in template but was not deployed by cdkd)',
      });
      continue;
    }

    // Issue #2274: a record whose properties hold the REDACTION MASK cannot be
    // handed to CloudFormation. `***` is what cdkd persists where a `NoEcho`
    // custom resource's `Data` was resolved into a property, or where a
    // property holds the `Fn::Base64` encoding of a secret (issues #2759 /
    // #3119), and there is nothing to re-derive the real value from — so the
    // exported template would declare the literal mask, which CFn would either
    // refuse at IMPORT (the template must describe the live resource) or WRITE
    // onto it at the next update. Blocked per resource, like every other
    // unexportable shape here, so the rest of the stack still reports. The
    // `attributes` twin (issue #2932) is NOT a whole-bag test beside this one:
    // it sits at the identifier choke point below, scoped to the one position
    // the export reads — `maskedIdentifierAttributeReason` says why the whole
    // bag must not be.
    // go-to-k/cdkd#4043 (schema v11): a property a `NoEcho` template
    // parameter fed holds `***` by design, and its record names the position
    // in `noEchoLeaves`. The exported TEMPLATE still reads the parameter, and
    // CloudFormation receives its value through its own parameter
    // (`resolveTemplateParameters`), so such a record is let through (Phase
    // C, design section 4.8) as long as nothing below reads a marked
    // position: the IAM policy pre-delete's principals and name, and the
    // import identifier (checked where it is resolved).
    const noEchoLeaves = noEchoLeavesOf(stateEntry);
    const masksOnlyAtNoEchoLeaves =
      noEchoLeaves !== undefined &&
      noEchoLeaves.length > 0 &&
      carriesSecretMask(stateEntry.properties) &&
      !carriesSecretMask(withoutCoordinates(stateEntry.properties, noEchoLeaves));
    const noEchoReadByPreDelete =
      masksOnlyAtNoEchoLeaves &&
      IMPORT_UNSUPPORTED_RECREATABLE_TYPES.has(resourceType) &&
      noEchoLeaves.some(
        (coordinate) =>
          typeof coordinate[0] === 'string' && NOECHO_PRE_DELETE_KEYS.has(coordinate[0])
      );
    if (noEchoReadByPreDelete) {
      blocked.push({
        logicalId,
        resourceType,
        reason:
          "a NoEcho template parameter feeds a property this resource's pre-delete reads (its principals or " +
          "its name), and cdkd state holds only the redaction mask ('***') there, so the export cannot tell " +
          'what to remove. Export this stack without that resource and adopt it into CloudFormation by hand, ' +
          'passing the parameter value yourself.',
      });
      continue;
    }
    if (!masksOnlyAtNoEchoLeaves && carriesSecretMask(stateEntry.properties)) {
      blocked.push({
        logicalId,
        resourceType,
        // THREE POPULATIONS, each with its own remedy, because nothing in the
        // record says which wrote the mask (issue
        // [#2881](https://github.com/go-to-k/cdkd/issues/2881)). ARM (2), the
        // `Fn::Base64` encoding of a secret, is the one `resolveBase64`
        // registers as a mask-only needle (issues #2759 / #3119): no custom
        // resource is involved, and every deploy of the same template masks it
        // again, so neither the NoEcho remedy nor a re-deploy helps — only
        // changing the template, and not to the secret's plaintext.
        //
        // ARM (3) was absent, the message naming arm (1) alone, until issue
        // [#2847](https://github.com/go-to-k/cdkd/issues/2847)'s round-2
        // review, and was then NARROWED by round 3's trace: this blocker
        // tests `properties`, while `CloudControlProvider.import` masks only
        // `attributes`, so "adopted through the Cloud Control fallback" named a
        // route that cannot put a mask here and sent the user at the wrong
        // record. The routes that CAN are `cdkd orphan --force` and an import
        // resolving an `Fn::GetAtt` OR A `Ref` over an already-masked record —
        // both a mask copied FROM another record, which is the record the
        // remedy now names. Do not re-collapse it, and do not re-widen it.
        //
        // THE `Ref` HALF WAS MISSING until round 4, and it is the route a user
        // is likelier to hit: `cdkd import` builds a BAGLESS resolver context,
        // so `refStateLookupFromResource` serves the mask rather than skipping
        // it, and `resolveImportedProperties` persists `'***'` for a `{Ref: X}`
        // whose state key is masked exactly as it does for a masked
        // `Fn::GetAtt`. Naming only `Fn::GetAtt` sent a user grepping their
        // template for one that is not there.
        reason:
          "cdkd state holds only the redaction mask ('***') for at least one property, and " +
          'cdkd cannot re-derive the value. There are four ways a record comes to hold it. ' +
          '(1) A NoEcho custom-resource value: forcing the custom resource to update does NOT ' +
          'clear this — the handler supplies the value to the deploy and cdkd re-masks it on ' +
          'the way into state, so the export still has nothing to declare. Stop setting NoEcho ' +
          'on that response and re-deploy, then export again. (2) The Fn::Base64 encoding of a ' +
          'secret value (a {{resolve:...}} dynamic reference under Fn::Base64, such as EC2 ' +
          'UserData): cdkd never records that encoding, so re-deploying the same template does ' +
          'not clear this. Stop encoding the secret into the property (have the resource read ' +
          "the secret at run time instead — not by writing the secret's plaintext into the " +
          'template, which cdkd would then record in state in the clear) and re-deploy, then ' +
          'export again. (3) The value was SPLICED from a ' +
          "masked record of ANOTHER resource — by 'cdkd orphan --force', or by 'cdkd import' " +
          'resolving an Fn::GetAtt or a Ref over a value the Cloud Control fallback had masked. ' +
          // NO backtick wrapper. Pasted WITH its wrapper a backtick span is
          // command SUBSTITUTION -- a worse wrapper than `'...'`, and one the
          // source fence could not see until go-to-k/cdkd#3613's M8 named it.
          // Every placeholder here is a hole, so nothing untrusted ran; the
          // shape is the point.
          'Repair the record that HOLDS the mask with ' +
          `${
            pasteableCommand('cdkd import', [
              { hole: 'stack' },
              { literal: '--resource' },
              { literal: `${commandHole('logicalId')}=${commandHole('physicalId')}` },
              { literal: '--force' },
            ]).command
          } (granting ` +
          'cloudformation:DescribeType first if the import warned that it could not read the ' +
          'schema), then re-run whichever command wrote this property. (4) Two secret values cdkd ' +
          'resolved overlap inside the value, so no single {{resolve:...}} reference renders it: ' +
          'change the property (or rotate one of the secrets) so that they no longer overlap, ' +
          're-deploy, then export again. In every case you can also ' +
          'export this stack without that resource and adopt it into CloudFormation by hand. ' +
          'See https://github.com/go-to-k/cdkd/issues/2274.',
      });
      continue;
    }

    // IMPORT-unsupported but CFn-createable types (`AWS::IAM::Policy`).
    // Skip phase-1 IMPORT entirely; cdkd will delete the AWS-side resource
    // between phases so CFn's phase-2 CREATE doesn't collide. The opt-out
    // flag `--no-recreate-import-unsupported` blocks them instead.
    if (IMPORT_UNSUPPORTED_RECREATABLE_TYPES.has(resourceType)) {
      if (options.recreateImportUnsupported) {
        const entry: RecreateBeforePhase2Entry = {
          logicalId,
          resourceType,
          physicalId: stateEntry.physicalId,
          properties: stateEntry.properties,
        };
        // A pre-delete that would refuse is refused HERE, before the lock and
        // before phase 1: the handler's refusal would otherwise fire between
        // phases, after the CloudFormation stack exists (go-to-k/cdkd#3857).
        // The handler keeps the same check as its backstop.
        const targets =
          resourceType === 'AWS::IAM::Policy' ? policyDetachTargets(entry) : undefined;
        if (targets && 'refusal' in targets) {
          blocked.push({
            logicalId,
            resourceType,
            reason: `the pre-delete of this inline policy would refuse: ${targets.refusal}`,
            // Re-importing records the template's resolved properties.
            repair: importRepairCommand(logicalId),
          });
          continue;
        }
        // What the pre-delete removes must be what phase 2 puts back
        // (go-to-k/cdkd#3910).
        if (targets) {
          const check = policyTemplateCheck(
            targets,
            (raw as { Properties?: unknown }).Properties,
            entry.properties,
            templateResources as Record<string, unknown>,
            state.resources,
            template['Parameters'],
            options.parameterValues ?? {}
          );
          if ('blocked' in check) {
            blocked.push({
              logicalId,
              resourceType,
              reason:
                check.blocked +
                (check.throughParameter && options.parametersFromCli
                  ? '; or, if the stack was deployed with other values, re-run the export with ' +
                    'the --parameter values the stack was deployed with'
                  : ''),
              ...(check.remedy === 'deploy'
                ? {
                    checkFirst: diffCheckCommand(options.rootStackName),
                    repair: deployRepairCommand(options.rootStackName),
                  }
                : check.remedy === 'import'
                  ? { repair: importRepairCommand(logicalId) }
                  : { manual: true as const }),
            });
            continue;
          }
          if (check.unconfirmed.length > 0) entry.unconfirmedPrincipals = check.unconfirmed;
          if (check.nameUnconfirmed) entry.policyNameUnconfirmed = true;
        }
        recreateBeforePhase2.push(entry);
      } else {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `AWS CloudFormation does not support ${resourceType} in IMPORT changesets ` +
            `(${resourceType} has no IMPORT handler). Re-run without ` +
            `--no-recreate-import-unsupported to let cdkd delete the AWS-side resource ` +
            `before phase 2 (CFn will then CREATE it fresh; brief unavailability window).`,
        });
      }
      continue;
    }

    // Pre-flight: CloudFormation refuses the whole IMPORT changeset for a type
    // with no `read` handler, so surface it here — before the phase-1 template
    // preprocessing and the user confirmation, and naming EVERY offender at
    // once. AWS's own error is not exhaustive: a probe carrying three
    // unsupported types named two of them, and a two-type probe named one
    // (measured us-east-1, 2026-08-13), so deferring to CreateChangeSet hands
    // the user a fix-one-rerun loop.
    //
    // Deliberately AFTER the IMPORT_UNSUPPORTED_RECREATABLE_TYPES branch
    // above, because cdkd has a real answer (pre-delete + phase-2 CREATE) for
    // the types on that list and must not steal them. `AWS::IAM::Policy` would
    // otherwise land here: it is NON_PROVISIONABLE with no `read` handler.
    let resolved: CompositeIdResult;
    try {
      // ONE `DescribeType` per type answers both questions — the pre-flight
      // above and the identifier resolution below share `identifierCache`, and
      // `resolveResourceIdentifier` takes the entry rather than re-fetching it.
      // A failure here means no usable schema AND no fallback entry, which the
      // catch reports with `fetchPrimaryIdentifier`'s own remediation message.
      // Not a pre-flight heuristic: cdkd holds no value the IMPORT changeset
      // could address the resource by, so the skip flag does not bypass it.
      const noIdentifier = physicalIdIsNotImportIdentifier(resourceType);
      if (noIdentifier !== undefined) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `cdkd cannot export ${resourceType}: ${noIdentifier}, so an IMPORT changeset ` +
            `addressed by it would fail after the stack was locked. Remove the resource from the ` +
            `stack before exporting (it stays in AWS and can be re-declared in CloudFormation ` +
            `afterwards), or destroy it first and let CloudFormation create it fresh.`,
        });
        continue;
      }
      // The measured list needs no schema, so it is consulted BEFORE the
      // DescribeType fetch: a type on it has no PRIMARY_IDENTIFIER_FALLBACK
      // row, and a fetch failure (permissions, throttle) would otherwise
      // report `could not resolve resource identifier` in place of the
      // refusal that actually applies.
      const measuredRefusal = cfnRefusesImportDespiteRegistry(resourceType);
      if (!options.skipImportSupportPreflight && measuredRefusal !== undefined) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `AWS CloudFormation does not support ${resourceType} in IMPORT changesets, ` +
            `${measuredRefusal}. Its registry schema passes cdkd's read-handler pre-flight, so ` +
            `without this list CreateChangeSet would reject the whole export with ` +
            `"ResourceTypes [${resourceType}] are not supported for Import" after the stack was ` +
            `locked. Remove the resource from the stack before exporting (it stays in AWS and can ` +
            `be re-declared in CloudFormation afterwards), or destroy it first and let ` +
            `CloudFormation create it fresh. If AWS has since added IMPORT support for this ` +
            `type, re-run with --skip-import-support-preflight and please open a cdkd issue.`,
        });
        continue;
      }
      const schemaInfo = await cachedTypeSchemaInfo(resourceType, cfnClient, identifierCache);
      if (!options.skipImportSupportPreflight && typeIsImportUnsupported(schemaInfo)) {
        blocked.push({
          logicalId,
          resourceType,
          reason:
            `AWS CloudFormation does not support ${resourceType} in IMPORT changesets: its ` +
            `CloudFormation registry schema declares no 'read' handler (and reports the type as ` +
            `NON_PROVISIONABLE), and IMPORT needs that handler to look the resource up by ` +
            `identifier. CreateChangeSet would reject the whole export ` +
            `with "ResourceTypes [${resourceType}] are not supported for Import". Remove the ` +
            `resource from the stack before exporting (it stays in AWS and can be re-declared in ` +
            `CloudFormation afterwards), or destroy it first and let CloudFormation create it ` +
            `fresh. If AWS has since added IMPORT support for this type, please open a cdkd issue.`,
        });
        continue;
      }
      resolved = await resolveResourceIdentifier(
        resourceType,
        logicalId,
        stateEntry.physicalId,
        stateEntry.properties,
        stateEntry.attributes ?? {},
        schemaInfo,
        backfillDeps
      );
    } catch (err) {
      blocked.push({
        logicalId,
        resourceType,
        reason: 'could not resolve resource identifier: ' + describeAwsFailure(err).detail,
        ...(err instanceof RepairableRefusal ? { repair: err.repair } : {}),
      });
      continue;
    }

    const propertiesOverlay = resolved.propertiesOverlay ?? resolved.resourceIdentifier;

    // Issue #2932: the GUARANTEE that no redaction mask reaches the exported
    // template, stated once at the point the identifier is built rather than
    // relied on per resolver. Every resolver above happens to shape-validate
    // what it reads (`arn:` prefix, `sgr-` prefix), which is why a masked
    // `attributes` value was refused rather than emitted — by accident, and an
    // accident a third resolver added for a type whose identifier has no
    // distinguishing prefix would remove silently. This check sees the VALUE
    // the template would receive, whichever source produced it: a recorded
    // attribute, a physicalId that is itself masked, a splitter's output, or a
    // backfill's answer. It deliberately does NOT test the whole `attributes`
    // bag — see `maskedIdentifierAttributeReason` for why that would block
    // every Cloud-Control-imported record permanently.
    //
    // The overlay disjunct is DEFENCE with no witness today: every overlay is
    // the identifier map itself, a subset of it, or a value recovered from
    // `properties` (the `AWS::EC2::VPCCidrBlock` splitter), which the
    // `properties` blocker above already fences. It stays so a splitter that
    // one day reads a THIRD source into the overlay is still caught here.
    // go-to-k/cdkd#4043 Phase C: a record let through above whose identifier
    // was built from a marked position (a splitter reading a property) holds
    // the mask INSIDE the identifier, which the whole-leaf test below misses.
    // Whatever let the record through: another record's masked attribute
    // embedded through `Fn::Sub` reaches an identifier the same way. A whole
    // `***` leaf takes the general reason below.
    if (
      (JSON.stringify(resolved.resourceIdentifier).includes(SECRET_MASK) ||
        JSON.stringify(propertiesOverlay).includes(SECRET_MASK)) &&
      !(carriesSecretMask(resolved.resourceIdentifier) || carriesSecretMask(propertiesOverlay))
    ) {
      blocked.push({
        logicalId,
        resourceType,
        reason:
          "the CloudFormation import identifier of this resource embeds the redaction mask ('***'): it is " +
          'built from a value cdkd stores only as the mask (a NoEcho value). Export this stack ' +
          'without that resource and adopt it into CloudFormation by hand, passing the parameter value yourself.',
      });
      continue;
    }
    if (carriesSecretMask(resolved.resourceIdentifier) || carriesSecretMask(propertiesOverlay)) {
      blocked.push({
        logicalId,
        resourceType,
        // The repair command goes on its own labelled line through
        // `importRepairCommand`, the gate `maskedIdentifierAttributeReason`
        // uses (go-to-k/cdkd#3736). Inside a prose `'...'` span the
        // interpolated logical id RAN when pasted (go-to-k/cdkd#3363's shape).
        reason:
          'the CloudFormation import identifier cdkd resolved for this resource is the redaction ' +
          "mask ('***'), so the exported template would declare the mask as the resource's " +
          'identity — CloudFormation would either refuse it at IMPORT or write it onto the live ' +
          'resource at the next update. cdkd state holds only the mask where the identifier ' +
          'should be (a masked attribute, or a masked physical id). Repair the record with the ' +
          'command below, granting cloudformation:DescribeType first if the import warned that ' +
          'it could not read the schema, or export the stack without this resource and adopt it ' +
          'into CloudFormation by hand. See https://github.com/go-to-k/cdkd/issues/2932.',
        repair: importRepairCommand(logicalId),
      });
      continue;
    }

    // Pre-flight the OVERLAY, not just the identifier (issue #1787). See
    // `unrepresentableOverlayFields` for why this cannot live at the overlay
    // site: `--dry-run` returns before any overlay call, and the nested path
    // overlays inside the per-stack IMPORT loop, where a throw would abort with
    // earlier stacks already migrated. Reported through `blocked` so every
    // offender is named in ONE pass, like every other unfixable-resource
    // verdict here.
    const unrepresentable = unrepresentableOverlayFields(raw, propertiesOverlay);
    if (unrepresentable.length > 0) {
      for (const u of unrepresentable) {
        blocked.push({
          logicalId,
          resourceType,
          reason: unrepresentableOverlayMessage(
            { logicalId, resourceType },
            u.field,
            u.current,
            u.value
          ),
        });
      }
      continue;
    }

    phase1Imports.push({
      logicalId,
      resourceType,
      physicalId: stateEntry.physicalId,
      resourceIdentifier: resolved.resourceIdentifier,
      propertiesOverlay,
    });
  }

  // go-to-k/cdkd#4492: two rows can resolve to ONE AWS resource — two
  // `AWS::EC2::SecurityGroupIngress` records sharing one `sgr-` rule. An import
  // adopts a resource into exactly one logical id, so neither row can be
  // imported as it stands; both are refused, each naming the other, rather
  // than handing CloudFormation a changeset that imports one resource twice.
  const byIdentifier = new Map<string, ImportPlanEntry[]>();
  for (const entry of phase1Imports) {
    const key = sharedImportIdentifierKey(entry);
    byIdentifier.set(key, [...(byIdentifier.get(key) ?? []), entry]);
  }
  const shared = [...byIdentifier.values()].filter((entries) => entries.length > 1);
  if (shared.length > 0) {
    const refused = new Set(shared.flat());
    for (const entries of shared) {
      for (const entry of entries) {
        const others = entries.filter((other) => other !== entry).map((other) => other.logicalId);
        blocked.push({
          logicalId: entry.logicalId,
          resourceType: entry.resourceType,
          reason: sharedImportIdentifierReason(others),
        });
      }
    }
    return {
      phase1Imports: phase1Imports.filter((entry) => !refused.has(entry)),
      phase2Creates,
      recreateBeforePhase2,
      nestedStackRows,
      blocked,
    };
  }

  return { phase1Imports, phase2Creates, recreateBeforePhase2, nestedStackRows, blocked };
}

/**
 * One key per (type, full import identifier): rows sharing it name one AWS
 * resource. Exported for its test: rows of DIFFERENT types never share one.
 */
export function sharedImportIdentifierKey(entry: ImportPlanEntry): string {
  const identifier = Object.keys(entry.resourceIdentifier)
    .sort()
    .map((key) => [key, entry.resourceIdentifier[key]]);
  return JSON.stringify([entry.resourceType, identifier]);
}

/**
 * Why a row sharing its import identifier with `others` is refused. The other
 * logical ids are rendered only when they are plain identifiers, as every
 * other blocked reason renders a template-borne name.
 */
export function sharedImportIdentifierReason(others: readonly string[]): string {
  const named = others.filter((id) => isPasteableIdent(id));
  const which =
    named.length === others.length
      ? `${others.length === 1 ? 'resource' : 'resources'} ${named.join(', ')}`
      : `${others.length} other resource(s) of this stack`;
  return (
    `this resource and ${which} are the SAME AWS resource (template rules that resolve ` +
    'to one security group rule), and a CloudFormation import adopts a resource into only one ' +
    'logical id. Remove all but one of them from the app before exporting, then add the ' +
    'others back with a CloudFormation stack update: CloudFormation accepts a rule identical ' +
    'to an existing one and records the same rule for it.'
  );
}

/**
 * What a blocked-resource refusal says after its rows, scoped to the rows'
 * own remedies (go-to-k/cdkd#3910): a row carrying a `Repair with:` command
 * is fixed by that command, so the generic "destroy them first, or remove them
 * from the CDK app" is said only of the rows without one — telling the
 * operator to destroy a record the row just said to re-import contradicts it.
 */
export function blockedMigrationTail(blocked: readonly BlockedResource[]): string {
  const generic =
    'destroy them first (cdkd destroy / cdkd state destroy cherry-picked), or remove them ' +
    'from the CDK app and re-synthesize.';
  // Per RESOURCE, as the rows are grouped. A resource with ANY manual reason
  // is manual — no command, the generic one included, is safe for it. Of the
  // rest, one with ANY reason carrying neither a repair nor its own check is
  // one the generic remedy is said of, even if another of its reasons does
  // carry a repair.
  const manualIds = new Set(blocked.filter((b) => b.manual).map((b) => b.logicalId));
  const genericIds = new Set(
    blocked
      .filter((b) => b.repair === undefined && !b.manual && !manualIds.has(b.logicalId))
      .map((b) => b.logicalId)
  );
  const hasRepair = blocked.some(
    (b) => b.repair !== undefined && !genericIds.has(b.logicalId) && !manualIds.has(b.logicalId)
  );
  const hasManual = manualIds.size > 0;
  if (genericIds.size === 0 && !hasManual) {
    return `Run each row's 'Repair with:' command, then re-run ${cdkdRemedy('cdkd export')}.`;
  }
  if (!hasRepair && !hasManual) return `Either ${generic}`;
  const steps: string[] = [];
  if (hasRepair) steps.push("run each 'Repair with:' command given");
  if (hasManual) {
    steps.push(
      'resolve each row that names its own check as it says — destroying or removing that ' +
        'resource is not a remedy, since it would perform the very removal the row refuses'
    );
  }
  if (genericIds.size > 0) {
    steps.push(`for the resources with a reason that has neither, either ${generic}`);
  }
  const text = steps.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1) + (genericIds.size > 0 ? '' : '.');
}

/**
 * Render the `blocked` list one bullet per RESOURCE, folding a resource's
 * several reasons into it.
 *
 * The pre-flight pushes one entry per offending FIELD (issue #1787), so a
 * multi-field overlay such as `AWS::S3Tables::Namespace` contributes two rows
 * for one resource — which made the count ("1 resource(s)") disagree with the
 * bullets printed under it. Grouping keeps the two consistent without losing a
 * reason.
 */
export function groupBlockedReasons(blocked: readonly BlockedResource[]): string[] {
  const byResource = new Map<string, { resourceType: string; reasons: string[] }>();
  for (const b of blocked) {
    const entry = byResource.get(b.logicalId) ?? { resourceType: b.resourceType, reasons: [] };
    // Each reason is FOLDED to one line: reasons interpolate template keys and
    // state values (resolver messages echo physical ids and attributes), and
    // a newline in any of them would otherwise start a counterfeit labelled
    // row. The one labelled line a reason may carry is appended here, from
    // the gated `repair` field (go-to-k/cdkd#3736). BOUNDED too: a reason can
    // quote a record's values back, and a planted multi-kilobyte one would
    // otherwise push the rest of the refusal off screen (go-to-k/cdkd#3375).
    const text = displayAwsMessage(b.reason);
    // Labelled command lines follow the reason, each on its own line, the
    // read-only check before the repair it guards.
    const checkLine = b.checkFirst === undefined ? '' : `\nCheck first with: ${b.checkFirst}`;
    entry.reasons.push(
      b.repair === undefined ? text : `${text}${checkLine}\nRepair with: ${b.repair}`
    );
    byResource.set(b.logicalId, entry);
  }
  return [...byResource].map(([logicalId, { resourceType, reasons }]) => {
    const header = `${blockedRowId(logicalId)} (${blockedRowType(resourceType)})`;
    return reasons.length === 1
      ? `  - ${header}: ${reasons[0]}`
      : `  - ${header}:\n${reasons.map((r) => `      - ${r}`).join('\n')}`;
  });
}

/**
 * A blocked row's identifiers come from the synthesized template's keys and
 * print beside reasons that end in a labelled `Repair with:` line, so the row
 * names them only in a shape that cannot forge that line — by a newline, or by
 * interior padding that wraps on screen (go-to-k/cdkd#3736). A CloudFormation
 * logical id is always a plain identifier, and a type always matches
 * `BLOCKED_ROW_TYPE`, so a real template loses nothing.
 */
function blockedRowId(logicalId: string): string {
  return isPasteableIdent(logicalId)
    ? logicalId
    : 'a resource whose logical id is not a plain identifier';
}

const BLOCKED_ROW_TYPE = /^[A-Za-z0-9]+(?:::[A-Za-z0-9_@-]+)+$/;

function blockedRowType(resourceType: string): string {
  return BLOCKED_ROW_TYPE.test(resourceType) ? resourceType : 'an unrecognized type';
}

/**
 * The properties the IAM policy pre-delete reads (`policyDetachTargets`, and
 * `policyTemplateCheck`'s `PolicyName`): a NoEcho mask at one of them leaves
 * the export unable to say what to remove (go-to-k/cdkd#4043 Phase C).
 */
const NOECHO_PRE_DELETE_KEYS: ReadonlySet<string> = new Set([
  'Roles',
  'Users',
  'Groups',
  'PolicyName',
]);

/**
 * A copy of `bag` with every coordinate in `coordinates` removed, so a mask
 * test sees only what lies OUTSIDE them (go-to-k/cdkd#4043).
 */
function withoutCoordinates(
  bag: Record<string, unknown>,
  coordinates: readonly (readonly (string | number)[])[]
): Record<string, unknown> {
  const placeholder = Symbol('noecho-leaf');
  const marked = coordinates.reduce<unknown>(
    (current, coordinate) => replaceAtCoordinate(current, coordinate, placeholder),
    bag
  );
  return JSON.parse(
    JSON.stringify(marked, (_key, value: unknown) => (value === placeholder ? null : value))
  ) as Record<string, unknown>;
}

function replaceAtCoordinate(
  node: unknown,
  coordinate: readonly (string | number)[],
  replacement: unknown
): unknown {
  if (coordinate.length === 0) return replacement;
  const [head, ...rest] = coordinate;
  if (Array.isArray(node) && typeof head === 'number' && head < node.length) {
    const copy = [...node];
    copy[head] = replaceAtCoordinate(node[head], rest, replacement);
    return copy;
  }
  if (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    typeof head === 'string'
  ) {
    const record = node as Record<string, unknown>;
    if (!Object.hasOwn(record, head)) return node;
    return { ...record, [head]: replaceAtCoordinate(record[head], rest, replacement) };
  }
  return node;
}
