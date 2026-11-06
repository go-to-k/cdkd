import type { RDSDBProxyTargetGroupProvider } from '../rds-dbproxy-targetgroup-provider.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import {
  DeregisterDBProxyTargetsCommand,
  DBProxyNotFoundFault,
  DBProxyTargetGroupNotFoundFault,
  DBProxyTargetNotFoundFault,
} from '@aws-sdk/client-rds';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { requireConfigString } from '../../config-shape.js';
import type { ResourceDeleteResult } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  redactedDeleteAddressFields,
  redactedDeleteAddressSkip,
} from '../../redacted-delete-address.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  readTargetLists,
  readProxyName,
  MALFORMED_TARGETS_SKIP_REASON,
  NON_DEFAULT_GROUP_SKIP_REASON,
} from './shared.js';

export async function deleteImpl(
  this: RDSDBProxyTargetGroupProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  const props = properties ?? {};
  // go-to-k/cdkd#3952: DeregisterDBProxyTargets names the proxy, the group
  // and each target from the record, and the NotFound faults below read as
  // "already gone" -- a redacted one would DROP the record over live targets.
  // The physicalId is the target group ARN, which names none of them.
  const redactedSkip = redactedDeleteAddressSkip(
    this.logger,
    logicalId,
    'DB proxy target group',
    redactedDeleteAddressFields({
      DBProxyName: props['DBProxyName'],
      TargetGroupName: props['TargetGroupName'],
      DBClusterIdentifiers: props['DBClusterIdentifiers'],
      DBInstanceIdentifiers: props['DBInstanceIdentifiers'],
    })
  );
  if (redactedSkip) return redactedSkip;
  // A non-string name is read as absent, not cast: the SDK sends `{}` as
  // `[object Object]`, and the NotFound arm below would then read the miss as
  // "already gone" and drop the record over the live targets. `default` is
  // the only group name CloudFormation accepts.
  const dbProxyName = readProxyName(props['DBProxyName']);
  const targetGroupName = requireConfigString(
    props['TargetGroupName'],
    'default',
    'AWS::RDS::DBProxyTargetGroup TargetGroupName',
    { onUnusable: (message) => this.logger.warn(message) }
  );
  // go-to-k/cdkd#3945: a recorded list that is not a list of identifiers is
  // skipped before any call rather than guessing which targets it names: the
  // SDK sends no list for a string, so the Deregister below would name no
  // target, and returning after it drops the record over the still-registered
  // real one.
  const targets = readTargetLists({
    DBClusterIdentifiers: props['DBClusterIdentifiers'],
    DBInstanceIdentifiers: props['DBInstanceIdentifiers'],
  });
  // A well-formed record naming no target has nothing to deregister, whatever
  // its proxy or group name says: it finishes before either name is needed.
  if (
    targets.malformed.length === 0 &&
    targets.lists.DBClusterIdentifiers.length === 0 &&
    targets.lists.DBInstanceIdentifiers.length === 0
  ) {
    this.logger.debug(`No targets recorded for ${logicalId}; nothing to deregister`);
    return;
  }

  // CloudFormation accepts only `default` here, so any other recorded name
  // addresses no group this resource made: a NotFound for it proves nothing
  // about the real `default` group's targets, and reading it as "already
  // gone" (the Deregister catch below) would drop the record over them.
  // Checked BEFORE the missing-DBProxyName remedy, which would otherwise
  // paste the bogus name into a command. A parent proxy that is itself gone
  // still finishes.
  if (targetGroupName !== 'default') {
    if (
      dbProxyName &&
      (await this.proxyConfirmedGone(
        dbProxyName,
        undefined,
        resourceType,
        logicalId,
        physicalId,
        context
      ))
    ) {
      return;
    }
    this.logger.warn(
      safeMsg`The state record for DB proxy target group ${logicalId} holds a TargetGroupName other than 'default', the only value CloudFormation accepts — skipping deletion rather than addressing a group this resource did not make. No deregistration is issued, so its targets stay REGISTERED on the proxy unless this run later deletes the parent DB proxy. The state record is KEPT: repair TargetGroupName in state.json to 'default' and re-run, or deregister the targets by hand. A deploy-side REPLACEMENT or rollback delete instead FAILS the resource (https://github.com/go-to-k/cdkd/issues/1762); there, deregister the targets by hand.`
    );
    return { outcome: 'skipped', reason: NON_DEFAULT_GROUP_SKIP_REASON };
  }

  if (!dbProxyName) {
    // No way to deregister without DBProxyName. This shouldn't happen
    // when cdkd state was populated by this provider's create(), but
    // could occur on an imported / hand-edited state. Surface as a real
    // error rather than silently no-op so the user knows to clean up
    // manually. The group name is state-borne, so the command goes through
    // `pasteableAwsCommand` (go-to-k/cdkd#3136). Only `default` reaches here
    // — any other recorded name took the skip above — so the command never
    // pastes a record-chosen name.
    const aws = pasteableAwsCommand();
    const command =
      aws`aws rds deregister-db-proxy-targets --db-proxy-name '<proxy-name>' --target-group-name ${targetGroupName}`.render();
    throw new ProvisioningError(
      `DBProxyName missing from state.properties for AWS::RDS::DBProxyTargetGroup ${logicalId}; cannot deregister targets. ` +
        `Manually run ${command} ` +
        `with --db-cluster-identifiers / --db-instance-identifiers naming the registered targets`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  if (targets.malformed.length > 0) {
    // Exhaust the live source before skipping: a proxy or group already
    // gone (deleted earlier in this run, or by CASCADE) is a finished delete,
    // not a skip that would repeat on every destroy. Any other probe outcome
    // — the group exists, or the probe failed — keeps the skip.
    if (
      await this.proxyConfirmedGone(
        dbProxyName,
        targetGroupName,
        resourceType,
        logicalId,
        physicalId,
        context
      )
    ) {
      return;
    }
    this.logger.warn(
      safeMsg`The state record for DB proxy target group ${logicalId} holds a ${targets.malformed.join(' / ')} that is not a list of RDS DB identifiers — skipping deletion rather than guessing which targets it names. The target group still exists (or could not be checked) and no deregistration is issued, so the targets stay REGISTERED on the proxy unless this run later deletes the parent DB proxy (then only the record is stale). The state record is KEPT: on 'cdkd destroy' / 'cdkd state destroy' (which exits non-zero) and on the plain DELETE of a resource removed from the template during cdkd deploy, repair the recorded list in state.json to the identifiers the target group holds ('aws rds describe-db-proxy-targets' lists them) and re-run, or deregister the targets by hand. A deploy-side REPLACEMENT or rollback delete instead FAILS the resource (https://github.com/go-to-k/cdkd/issues/1762); there, deregister the targets by hand.`
    );
    return { outcome: 'skipped', reason: MALFORMED_TARGETS_SKIP_REASON };
  }
  const dbClusterIdentifiers = targets.lists.DBClusterIdentifiers;
  const dbInstanceIdentifiers = targets.lists.DBInstanceIdentifiers;

  // Every identifier here passed `readTargetLists` after the redacted-address
  // skip, so none is a reference or a mask, but one can be a plaintext an
  // in-process rollback resolved: masked with the caller's masker
  // (go-to-k/cdkd#2007).
  const mask = maskerOrIdentity(context?.maskSecrets);
  this.logger.debug(
    mask(
      `Deregistering targets from ${mask(dbProxyName)}/${mask(targetGroupName)}: ` +
        `clusters=[${dbClusterIdentifiers.map(mask).join(',')}], ` +
        `instances=[${dbInstanceIdentifiers.map(mask).join(',')}]`
    )
  );

  try {
    await this.getClient().send(
      new DeregisterDBProxyTargetsCommand({
        DBProxyName: dbProxyName,
        TargetGroupName: targetGroupName,
        DBClusterIdentifiers: dbClusterIdentifiers.length > 0 ? dbClusterIdentifiers : undefined,
        DBInstanceIdentifiers: dbInstanceIdentifiers.length > 0 ? dbInstanceIdentifiers : undefined,
      })
    );
  } catch (error) {
    // Idempotent success when the parent DBProxy, the TargetGroup, or
    // any individual target is already gone — typically because a sibling
    // cdkd delete or AWS-side CASCADE already removed them. Region-match
    // guard prevents silently masking a wrong-region destroy that would
    // otherwise leave the actual AWS resources orphaned.
    if (
      error instanceof DBProxyNotFoundFault ||
      error instanceof DBProxyTargetGroupNotFoundFault ||
      error instanceof DBProxyTargetNotFoundFault
    ) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        mask(
          `${mask(dbProxyName)}/${mask(targetGroupName)} or its target is already gone, treating as success`
        )
      );
      return;
    }
    const thrown = this.wrapError(error, 'DELETE', resourceType, logicalId, physicalId, mask);
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFound` in a message as "already deleted": only the typed
    // not-founds above mean this registration is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}
