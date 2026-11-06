import type { ELBv2Provider } from '../elbv2-provider.js';
import {
  CreateListenerCommand,
  DeleteListenerCommand,
  ModifyListenerCommand,
  DescribeListenersCommand,
  ModifyListenerAttributesCommand,
  type Tag,
  type ProtocolEnum,
  type MutualAuthenticationAttributes,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { withRetry } from '../../../deployment/retry.js';
import { isInterruptedWaitError, startInterruptWatch } from '../../interrupt-watch.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNotGone } from '../../not-gone.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  SecretMasker,
} from '../../../types/resource.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import {
  hasErrorName,
  nameHeldBefore,
  skippedCleanupText,
  type NameHeldBefore,
} from '../create-ownership.js';
import {
  RETAIN_REMOVED_ATTRIBUTE,
  MISLEADING_IF_KEPT_ATTRIBUTE,
  LISTENER_LEFT_IN_PLACE_ON_REMOVAL,
  LISTENER_TLS_DOWNGRADE,
  CLEARED_BY_TLS_DOWNGRADE,
  listenerLeftInPlaceWarning,
} from './shared.js';

// ─── AWS::ElasticLoadBalancingV2::Listener ─────────────────────────

/**
 * Does a listener already sit on `port` of `loadBalancerArn`? The listener
 * twin of the by-name lookups (go-to-k/cdkd#4403): a listener has no name,
 * and its port is what CreateListener hands an existing listener back on.
 * Pages through every listener; a page loop that does not end throws, so
 * the caller reads it as `unknown`.
 */
export async function listenerPortHeld(
  this: ELBv2Provider,
  loadBalancerArn: string,
  port: number | undefined
): Promise<boolean> {
  let marker: string | undefined;
  for (let page = 0; page < 100; page++) {
    const response = await this.getClient().send(
      new DescribeListenersCommand({
        LoadBalancerArn: loadBalancerArn,
        ...(marker !== undefined && { Marker: marker }),
      })
    );
    if ((response.Listeners ?? []).some((l) => l.Port === port)) return true;
    if (!response.NextMarker) return false;
    marker = response.NextMarker;
  }
  throw new Error('DescribeListeners did not finish paging');
}

export async function createListener(
  this: ELBv2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  maskSecrets?: SecretMasker
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating Listener ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const tags: Tag[] = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // delete the listener this call created.
  let leftBehindArn: string | undefined;
  try {
    const defaultActions = this.convertActions(
      properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
    );
    const certificates = this.convertCertificates(
      properties['Certificates'] as Array<Record<string, unknown>> | undefined
    );

    const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
    const mutualAuth = properties['MutualAuthentication'] as
      | MutualAuthenticationAttributes
      | undefined;

    // Whether the cleanup below may delete what CreateListener returns: on
    // identical settings it hands back the listener already on this port
    // (go-to-k/cdkd#4403). Asked only when a wiring step can fail.
    const listenerAttributes = this.normalizeAttributes(properties['ListenerAttributes']);
    const heldBefore: NameHeldBefore =
      listenerAttributes.length > 0
        ? await nameHeldBefore(
            () =>
              this.listenerPortHeld(
                properties['LoadBalancerArn'] as string,
                properties['Port'] !== undefined ? Number(properties['Port']) : undefined
              ),
            (error) => hasErrorName(error, ['LoadBalancerNotFoundException'])
          )
        : 'free';

    const response = await this.getClient().send(
      new CreateListenerCommand({
        LoadBalancerArn: properties['LoadBalancerArn'] as string,
        Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
        Protocol: properties['Protocol'] as ProtocolEnum | undefined,
        SslPolicy: properties['SslPolicy'] as string | undefined,
        DefaultActions: defaultActions ?? [],
        ...(certificates && { Certificates: certificates }),
        ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
        ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
        ...(tags.length > 0 && { Tags: tags }),
      })
    );

    const listener = response.Listeners?.[0];
    if (!listener || !listener.ListenerArn) {
      throw new Error('CreateListener did not return Listener ARN');
    }
    const listenerArn = listener.ListenerArn;

    this.logger.debug(`Successfully created Listener ${logicalId}: ${listenerArn}`);
    // go-to-k/cdkd#5511: only a listener the port was free for.
    if (heldBefore === 'free') reportCreatedResource(logicalId, resourceType, listenerArn);

    // CreateListener does NOT accept ListenerAttributes (e.g.
    // `tcp.idle_timeout.seconds`, `routing.http.response.server.enabled`) —
    // they ride on a separate post-create `ModifyListenerAttributes`
    // control-plane call. CreateListener has already committed the listener
    // on AWS, so a failure here would strand a half-configured listener (the
    // throw aborts before the success-return, cdkd state is NOT written, and
    // the next deploy plans CREATE again — but the LB already has a listener
    // on this port, which AWS rejects with `DuplicateListener`). Wrap the
    // attributes call in an inner try/catch that issues a best-effort
    // `DeleteListener` before re-throwing the original error (atomicity),
    // mirroring the LoadBalancer create path above.
    try {
      if (listenerAttributes.length > 0) {
        // Interruptible (issue #2053): without the watch a Ctrl-C here sits
        // out the whole backoff schedule before anything responds.
        const watch = startInterruptWatch(`ELBv2 Listener ${logicalId} attributes`);
        try {
          await withRetry(
            () =>
              this.getClient().send(
                new ModifyListenerAttributesCommand({
                  ListenerArn: listenerArn,
                  Attributes: listenerAttributes,
                })
              ),
            logicalId,
            // NOT `this.logger` (issue #2050): `Attributes` here is
            // `properties['ListenerAttributes']`, already RESOLVED, and an AWS
            // rejection quotes the offending value back into the message
            // `withRetry` interpolates.
            {
              logger: this.maskedRetryLogger(maskSecrets),
              isInterrupted: watch.isInterrupted,
              onInterrupted: watch.onInterrupted,
            }
          );
        } finally {
          watch.dispose();
        }
        this.logger.debug(
          `Applied ${listenerAttributes.length} ListenerAttribute(s) for ${logicalId}`
        );
      }
    } catch (innerError) {
      // An interrupt takes the SAME cleanup as any other attributes-wiring
      // failure. That is not symmetry for its own sake, and the tempting
      // opposite — "a Ctrl-C must not delete what the user just made" — was
      // written here first and is WRONG, because it assumes this listener is
      // tracked. It is not: `create()` is throwing, so `newResources[logicalId]`
      // is never set, and only a cleanup that FAILS below marks the ARN for
      // the rollback journal (go-to-k/cdkd#4583). Nothing else holds it.
      //
      // So the choice is not "delete vs preserve" but "delete vs ORPHAN
      // FOREVER". A preserved listener fails the next deploy with
      // `DuplicateListener` — permanently, since `cdkd rollback` skips it and
      // `cdkd destroy` has no record of it — while the engine prints "run
      // deploy again to resume, `cdkd rollback` to revert, or destroy to
      // clean up", all three of which would be false.
      //
      // The handle is printed BEFORE the delete is attempted, at default
      // verbosity, so a process that dies mid-cleanup still leaves the user
      // something to act on. Silent orphan is the one unacceptable outcome.
      if (heldBefore !== 'free') {
        this.logger.warn(
          maskerOrIdentity(maskSecrets)(
            skippedCleanupText(
              heldBefore,
              `Listener ${logicalId} (${listenerArn})`,
              pasteableAwsCommand(
                maskSecrets
              )`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()
            )
          )
        );
        throw markAuxiliaryFailure(innerError, logicalId);
      }
      if (isInterruptedWaitError(innerError)) {
        // Routed through the masked sink like every other line in this catch.
        // The three interpolated values are safe on their own — an AWS-minted
        // ARN and a CFn logical id — but the sibling `warn` two lines down
        // argues the discipline directly: an unmasked line sitting beside
        // masked ones is what a later author copies.
        this.logger.warn(
          maskerOrIdentity(maskSecrets)(
            `Interrupted after creating Listener ${logicalId} (${listenerArn}) but before its ` +
              `attributes were applied. Nothing in cdkd state refers to it, so cdkd is deleting ` +
              `it now — left behind it would fail the next deploy with DuplicateListener and ` +
              `destroy could not reach it. If that delete fails, outside a rollback's re-create, the failed deploy's rollback journal records it for \`cdkd rollback --revert-failed\`; ` +
              `otherwise remove it yourself: ${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()}`
          )
        );
      }
      try {
        await this.getClient().send(new DeleteListenerCommand({ ListenerArn: listenerArn }));
        retractCreatedResource(logicalId, resourceType, listenerArn);
        this.logger.debug(
          `Cleaned up partially-created Listener ${logicalId} (${listenerArn}) after attributes-wiring failure`
        );
      } catch (cleanupError) {
        leftBehindArn = listenerArn;
        const listenerCleanupHead = `Failed to clean up partially-created Listener ${logicalId} (${listenerArn}): `;
        this.logger.warn(
          // Masked for the same reason as the TargetGroup cleanup above
          // (issue #2050).
          `${listenerCleanupHead}${this.cleanupFailureText(listenerCleanupHead, cleanupError, maskSecrets)} Outside a rollback's re-create, the failed deploy's rollback ` +
            `journal records it for \`cdkd rollback --revert-failed\`; otherwise delete it yourself ` +
            `before the next deploy: ` +
            `${pasteableAwsCommand(maskSecrets)`aws elbv2 delete-listener --listener-arn ${listenerArn}`.render()}`
        );
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }

    return {
      physicalId: listenerArn,
      attributes: {
        ListenerArn: listenerArn,
      },
    };
  } catch (error) {
    // `cause` carries the ORIGINAL error untouched (issue #2050): the
    // classifier walks it for `$metadata`, so only the human-readable
    // message is masked.
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Listener ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
    if (leftBehindArn !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindArn);
    }
    throw thrown;
  }
}

export async function updateListener(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  const maskSecrets = context?.maskSecrets;
  const fromReadback = context?.desiredFromAwsReadback === true;
  this.logger.debug(`Updating Listener ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

  // Issue #1160: a removed property ModifyListener is not sent stays live,
  // as CloudFormation leaves it (LISTENER_LEFT_IN_PLACE_ON_REMOVAL).
  // Exempt: SslPolicy / Certificates on an HTTPS -> HTTP or TLS -> TCP
  // change, which AWS drops itself. Named once, and only after the update
  // SUCCEEDED (the shared caller's warning has the same timing). Not on
  // `drift --revert`: its previous side is an AWS readback, so a key the
  // desired side lacks was never removed from a template.
  const removed = context?.removedProperties;
  const desiredProtocol = properties['Protocol'];
  const previousProtocol = previousProperties['Protocol'];
  const tlsDowngrade =
    typeof desiredProtocol === 'string' &&
    typeof previousProtocol === 'string' &&
    LISTENER_TLS_DOWNGRADE.get(previousProtocol) === desiredProtocol;
  const leftInPlaceNames = LISTENER_LEFT_IN_PLACE_ON_REMOVAL.filter(
    (key) =>
      (removed !== undefined
        ? removed.has(key)
        : properties[key] === undefined && previousProperties[key] !== undefined) &&
      !(tlsDowngrade && CLEARED_BY_TLS_DOWNGRADE.has(key))
  );

  try {
    const defaultActions = this.convertActions(
      properties['DefaultActions'] as Array<Record<string, unknown>> | undefined
    );
    const certificates = this.convertCertificates(
      properties['Certificates'] as Array<Record<string, unknown>> | undefined
    );

    const alpnPolicy = properties['AlpnPolicy'] as string[] | undefined;
    const mutualAuth = properties['MutualAuthentication'] as
      | MutualAuthenticationAttributes
      | undefined;

    await this.getClient().send(
      new ModifyListenerCommand({
        ListenerArn: physicalId,
        Port: properties['Port'] !== undefined ? Number(properties['Port']) : undefined,
        Protocol: properties['Protocol'] as ProtocolEnum | undefined,
        SslPolicy: properties['SslPolicy'] as string | undefined,
        ...(defaultActions && { DefaultActions: defaultActions }),
        ...(certificates && { Certificates: certificates }),
        // AlpnPolicy is a TLS-listener-only field; only forward it
        // when the diff actually carries values (CFn template-side it
        // is an array of one entry). An empty array would be rejected
        // by AWS on non-TLS listeners.
        ...(alpnPolicy && alpnPolicy.length > 0 && { AlpnPolicy: alpnPolicy }),
        // MutualAuthentication is HTTPS-listener-only. Forward when
        // the user templated it; AWS will reject on non-HTTPS.
        ...(mutualAuth !== undefined && { MutualAuthentication: mutualAuth }),
      })
    );

    // ─── ListenerAttributes ──────────────────────────────────────────
    const removedMisleadingKeys: string[] = [];
    // ModifyListenerAttributes replaces ONLY the listed attrs — keys not
    // in the request are left untouched. Only added / changed keys are
    // sent; a removed key keeps its live value, as CloudFormation leaves it
    // (RETAIN_REMOVED_ATTRIBUTE). No listener attribute names an external
    // destination (they are response-header, request-header-name and
    // timeout settings), but a kept CORS key or request-header rename can
    // mislead a client or the backend (MISLEADING_IF_KEPT_ATTRIBUTE).
    // CloudFormation keeps those too (CFn A/B us-east-1 2026-10-18 on the
    // CORS keys), so they are kept and warned about, naming the keys (never
    // values). Skip the call entirely when nothing changed so
    // the no-drift round-trip is a clean no-op. A failure here
    // THROWS (caught by the outer try/catch and re-wrapped as a
    // ProvisioningError) so cdkd state is not written as-if-applied — the
    // next deploy retries. `drift --revert` sends no removal at all
    // (go-to-k/cdkd#4147).
    const submittedAttrs = this.diffAttributeBag(
      'ListenerAttributes',
      logicalId,
      properties['ListenerAttributes'],
      previousProperties['ListenerAttributes'],
      (key) => {
        if (MISLEADING_IF_KEPT_ATTRIBUTE.test(key)) removedMisleadingKeys.push(key);
        return RETAIN_REMOVED_ATTRIBUTE();
      },
      fromReadback,
      maskSecrets
    );
    if (submittedAttrs.length > 0) {
      // Interruptible for the same reason as the create path (issue #2053).
      const watch = startInterruptWatch(`ELBv2 Listener ${logicalId} attributes`);
      try {
        await withRetry(
          () =>
            this.getClient().send(
              new ModifyListenerAttributesCommand({
                ListenerArn: physicalId,
                Attributes: submittedAttrs,
              })
            ),
          logicalId,
          // Masked for the same reason as the create path (issue #2050) — the
          // submitted diff is built from `properties` / `previousProperties`,
          // both RESOLVED.
          {
            logger: this.maskedRetryLogger(maskSecrets),
            isInterrupted: watch.isInterrupted,
            onInterrupted: watch.onInterrupted,
          }
        );
      } finally {
        watch.dispose();
      }
      this.logger.debug(
        `Applied ${submittedAttrs.length} ListenerAttributes change(s) for ${logicalId}`
      );
    }

    // Apply tag diff. ELBv2 uses AddTags / RemoveTags with [arn].
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      maskSecrets
    );

    this.logger.debug(`Successfully updated Listener ${logicalId}`);
    if (removedMisleadingKeys.length > 0) {
      const mask = maskerOrIdentity(maskSecrets);
      const keys = removedMisleadingKeys.map((key) => mask(key)).join(', ');
      const one = removedMisleadingKeys.length === 1;
      this.logger.warn(
        safeMsg`${logicalId}: ListenerAttributes ${one ? 'key' : 'keys'} ${keys} ${one ? 'is' : 'are'} no longer declared and ${one ? 'keeps its live value' : 'keep their live values'}, as CloudFormation leaves ${one ? 'it' : 'them'}, so the listener may keep sending a CORS response header, or keep writing a request header under its renamed name. To change ${one ? 'it' : 'them'}, declare the value you want and deploy, or set ${one ? 'it' : 'them'} with 'aws elbv2 modify-listener-attributes'.`
      );
    }
    if (leftInPlaceNames.length > 0 && !fromReadback) {
      this.logger.warn(
        listenerLeftInPlaceWarning(
          logicalId,
          leftInPlaceNames,
          context?.replayingState ? 'rollback' : 'deploy'
        )
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ListenerArn: physicalId,
      },
    };
  } catch (error) {
    // `cause` carries the ORIGINAL error untouched (issue #2050) — see the
    // create path above.
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      maskerOrIdentity(maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update Listener ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteListener(
  this: ELBv2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Listener ${logicalId}: ${physicalId}`);

  try {
    await this.getClient().send(new DeleteListenerCommand({ ListenerArn: physicalId }));
    this.logger.debug(`Successfully deleted Listener ${logicalId}`);
  } catch (error) {
    if (this.isDeleteTargetGone(error, context, 'ListenerNotFoundException')) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logDeleteTargetGone(
        context,
        'Listener',
        physicalId,
        logicalId,
        `Listener ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Listener ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
