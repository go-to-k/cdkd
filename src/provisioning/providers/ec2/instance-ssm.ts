import {
  CreateAssociationCommand,
  DeleteAssociationCommand,
  DescribeAssociationCommand,
  ListAssociationsCommand,
} from '@aws-sdk/client-ssm';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markRedactedCause } from '../../../deployment/retryable-errors.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import { isNamedError } from './common.js';
import {
  type InstanceMemberPlan,
  type InstanceSsmAssociation,
  SSM_ASSOCIATION_ROLE_POLL_MS,
  SSM_ASSOCIATION_ROLE_WAIT_CAP_MS,
  ssmDocumentName,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// go-to-k/cdkd#5630: `AWS::EC2::Instance SsmAssociations`. CloudFormation
// (measured us-east-1) launches the instance, then calls the instance-id form
// of `CreateAssociation { Name, InstanceId, Parameters }`, and reads it back
// through `ListAssociations(InstanceId)` + `DescribeAssociation`. It reports
// the create complete while the association is still Pending, so nothing here
// waits for an execution. CloudTrail withholds the parameters as sensitive,
// so no line here ever names a parameter VALUE, and every AWS error text goes
// through the operation's masker.

/** What Systems Manager answers while it does not yet see the instance's IAM role. */
const IAM_ROLE_NOT_YET_SEEN = 'must associate an IAM role';

/** DeleteAssociation's answer for an association that is already gone. */
const ASSOCIATION_GONE_NAMES: ReadonlySet<string> = new Set(['AssociationDoesNotExist']);

/** One instance-id association Systems Manager lists for an instance. */
export interface ListedSsmAssociation {
  AssociationId: string;
  Name: string;
}

/**
 * Create `entry` on `instanceId` and return its association id. The "must
 * associate an IAM role" refusal is retried: the profile cdkd just associated
 * can take a moment to reach Systems Manager. The retry ends at whichever
 * comes first, the resource deadline or {@link SSM_ASSOCIATION_ROLE_WAIT_CAP_MS},
 * and on Ctrl-C with an `InterruptedWaitError`; any other failure is thrown
 * as is.
 */
export async function createInstanceSsmAssociation(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  entry: InstanceSsmAssociation,
  mask: MaskerFn
): Promise<string | undefined> {
  const watch = startInterruptWatch(`EC2 Instance ${logicalId} SSM association`);
  const capAt = Date.now() + SSM_ASSOCIATION_ROLE_WAIT_CAP_MS;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await this.awsClients.ssm.send(
          new CreateAssociationCommand({
            Name: entry.DocumentName,
            InstanceId: instanceId,
            ...(Object.keys(entry.Parameters).length > 0 && { Parameters: entry.Parameters }),
          })
        );
        return resp.AssociationDescription?.AssociationId;
      } catch (error) {
        const detail = describeAwsFailure(error).detail;
        if (!detail.includes(IAM_ROLE_NOT_YET_SEEN)) throw error;
        const remaining = Math.min(enclosingDeadlineRemainingMs(), capAt - Date.now());
        if (remaining <= 0) throw error;
        if (watch.isInterrupted()) throw watch.onInterrupted();
        this.logger.debug(
          mask(
            `Systems Manager does not see the IAM role of instance ${instanceId} (${logicalId}) yet (CreateAssociation attempt ${attempt}: ${mask(detail)}); retrying`
          )
        );
        await this.sleep(Math.max(0, Math.min(SSM_ASSOCIATION_ROLE_POLL_MS, remaining)));
        if (watch.isInterrupted()) throw watch.onInterrupted();
      }
    }
  } finally {
    watch.dispose();
  }
}

/**
 * The instance-id associations of `instanceId` (`ListAssociations`, every
 * page), narrowed to the documents named in `documentNames`. An
 * association that targets the instance some other way (an
 * `AWS::SSM::Association` with `Targets`) carries no `InstanceId` and is left
 * out: it is not this property's.
 */
export async function listInstanceSsmAssociations(
  this: EC2Provider,
  instanceId: string,
  documentNames: readonly string[]
): Promise<ListedSsmAssociation[]> {
  const wanted = new Set(documentNames.map(ssmDocumentName));
  const out: ListedSsmAssociation[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await this.awsClients.ssm.send(
      new ListAssociationsCommand({
        AssociationFilterList: [{ key: 'InstanceId', value: instanceId }],
        ...(nextToken !== undefined && { NextToken: nextToken }),
      })
    );
    for (const a of resp.Associations ?? []) {
      if (a.InstanceId !== instanceId || typeof a.AssociationId !== 'string') continue;
      const name = typeof a.Name === 'string' ? a.Name : '';
      if (!wanted.has(ssmDocumentName(name))) continue;
      out.push({ AssociationId: a.AssociationId, Name: name });
    }
    nextToken = resp.NextToken || undefined;
  } while (nextToken !== undefined);
  return out;
}

/** DeleteAssociation by id; an association already gone is deleted. */
export async function deleteSsmAssociationById(
  this: EC2Provider,
  associationId: string
): Promise<void> {
  try {
    await this.awsClients.ssm.send(new DeleteAssociationCommand({ AssociationId: associationId }));
  } catch (error) {
    if (isNamedError(error, ASSOCIATION_GONE_NAMES)) return;
    throw error;
  }
}

/**
 * Apply a planned `SsmAssociations` change in place: delete the instance's
 * recorded association (by id), then create the desired one.
 *
 * CloudFormation's own handler fails every in-place change but "absent ->
 * one entry" (measured: it deletes the association, then fails the update),
 * so this is a deliberate deviation: cdkd completes the change it was asked
 * for. When the create fails after the delete, the error says plainly that
 * the instance is left with NO association.
 */
export async function applyInstanceSsmAssociationChange(
  this: EC2Provider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  plan: NonNullable<InstanceMemberPlan['ssmAssociation']>,
  mask: MaskerFn
): Promise<void> {
  const deleted: string[] = [];
  if (plan.documentNames.length > 0) {
    for (const a of await this.listInstanceSsmAssociations(physicalId, plan.documentNames)) {
      await this.deleteSsmAssociationById(a.AssociationId);
      deleted.push(a.Name);
    }
  }
  if (plan.create === undefined) return;
  try {
    await this.createInstanceSsmAssociation(logicalId, physicalId, plan.create, mask);
  } catch (error) {
    if (deleted.length === 0) throw error;
    const cause = error instanceof Error ? error : undefined;
    const failure = describeAwsFailure(error);
    // Stamped as wrapCaughtError stamps its wrap: an AWS-authored text is
    // withheld, and a cdkd-authored one is stamped when the mask changed it,
    // so the retry classifiers read the original text on the cause chain.
    const stamp = failure.redacted || mask(failure.detail) !== failure.detail;
    // AWS-authored text is named by its class here (its own words go to
    // debug, masked), as the other EC2 wraps do; the rest of the message is
    // cdkd's.
    const head = `Failed to update EC2 Instance ${logicalId}: cdkd deleted its SSM association (document ${deleted.join(', ')}) and then could not create the new one, so the instance ${physicalId} now has NO SSM association. Fix the cause and deploy again to create it: `;
    const thrown = new ProvisioningError(
      mask(`${head}${this.warnFailureText(head, error, mask)}`),
      resourceType,
      logicalId,
      physicalId,
      cause
    );
    throw stamp && cause !== undefined ? markRedactedCause(thrown) : thrown;
  }
}

/**
 * Delete the terminated instance's associations of the recorded documents,
 * best effort. CloudFormation never deletes them (they stay "Associated" on
 * the terminated instance, measured); cdkd does, so a destroy leaves nothing
 * of the stack behind. An association of another document is not this
 * resource's and is left alone. A failure is a warning: it never blocks the
 * delete.
 */
export async function deleteInstanceSsmAssociationsBestEffort(
  this: EC2Provider,
  logicalId: string,
  instanceId: string,
  documentNames: readonly string[],
  mask: MaskerFn
): Promise<void> {
  try {
    for (const a of await this.listInstanceSsmAssociations(instanceId, documentNames)) {
      await this.deleteSsmAssociationById(a.AssociationId);
    }
  } catch (error) {
    const head = `Could not delete the SSM association of EC2 Instance ${logicalId} (${instanceId}): `;
    this.logger.warn(
      safeMsg`${head}${this.warnFailureSentence(head, error, mask)} The instance is deleted; the association stays listed by Systems Manager until it is deleted (aws ssm delete-association --association-id <id>).`
    );
  }
}

/**
 * The drift readback of `SsmAssociations`: each instance-id association of
 * a declared document (another document's is not this resource's), its
 * `DescribeAssociation` parameters in the CloudFormation shape, the
 * declared parameter order kept (keys the template does not declare follow,
 * sorted) so the comparison and the secret masking line up with the
 * template. `undefined` when Systems Manager could not be read.
 */
export async function readInstanceSsmAssociations(
  this: EC2Provider,
  instanceId: string,
  declared: readonly InstanceSsmAssociation[]
): Promise<Array<Record<string, unknown>> | undefined> {
  try {
    const listed = await this.listInstanceSsmAssociations(
      instanceId,
      declared.map((d) => d.DocumentName)
    );
    const out: Array<Record<string, unknown>> = [];
    for (const a of listed) {
      let resp;
      try {
        resp = await this.awsClients.ssm.send(
          new DescribeAssociationCommand({ AssociationId: a.AssociationId })
        );
      } catch (error) {
        // Deleted between the list and this read: it is not there.
        if (isNamedError(error, ASSOCIATION_GONE_NAMES)) continue;
        throw error;
      }
      const description = resp.AssociationDescription;
      const name = description?.Name ?? a.Name;
      const match = declared.find((d) => ssmDocumentName(d.DocumentName) === ssmDocumentName(name));
      const params = description?.Parameters ?? {};
      const order = match?.parameterKeys ?? [];
      const keys = [
        ...order.filter((k) => k in params),
        ...Object.keys(params)
          .filter((k) => !order.includes(k))
          .sort(),
      ];
      const entry: Record<string, unknown> = {
        // The declared spelling (a name or an ARN) when it names this document.
        DocumentName: match?.DocumentName ?? name,
      };
      if (keys.length > 0 || match?.declaresParameters === true) {
        entry['AssociationParameters'] = keys.map((Key) => ({ Key, Value: params[Key] ?? [] }));
      }
      out.push(entry);
    }
    return out;
  } catch (error) {
    this.logger.debug(
      safeMsg`ListAssociations / DescribeAssociation for ${instanceId} failed: ${describeAwsFailure(error).summary}`
    );
    return undefined;
  }
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceSsmMethods = {
  createInstanceSsmAssociation,
  listInstanceSsmAssociations,
  deleteSsmAssociationById,
  applyInstanceSsmAssociationChange,
  deleteInstanceSsmAssociationsBestEffort,
  readInstanceSsmAssociations,
};
