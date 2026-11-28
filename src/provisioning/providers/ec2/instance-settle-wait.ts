import {
  DescribeIamInstanceProfileAssociationsCommand,
  DescribeInstancesCommand,
  type EC2Client,
  type IamInstanceProfileAssociation,
  type Instance,
  type InstanceMetadataOptionsRequest,
} from '@aws-sdk/client-ec2';
import { startInterruptWatch } from '../../interrupt-watch.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import type { SecretMasker } from '../../../types/resource.js';

/**
 * The waits after the asynchronous `AWS::EC2::Instance` update calls
 * (go-to-k/cdkd#7132). `MonitorInstances` answers `pending` and
 * `UnmonitorInstances` `disabling`, `ModifyInstanceMetadataOptions` answers
 * `pending`, and the IAM instance profile associate / replace / disassociate
 * calls answer `associating` / `disassociating`. Measured us-east-1: the
 * first DescribeInstances read right after `MonitorInstances` still read
 * `disabled` (4/4 trials) and after `UnmonitorInstances` `enabled` (3/4),
 * the metadata options read `pending` (1/8), and the association read
 * `associating` / `disassociating`; each settled within ~0.8 s.
 * CloudFormation's update completes only once they have (an update changing
 * all three took ~4 s, and the read right after `UPDATE_COMPLETE` was
 * terminal with the new values), while returning earlier froze the drift
 * baseline on the old value (`read-instance-state.ts` reads `pending` as
 * monitoring on, and DescribeInstances can show the old profile).
 *
 * None of these has an asynchronous failure status, so the wait ends on the
 * requested settled state, or THROWS non-retryably on its poll cap or the
 * enclosing per-resource deadline (`--resource-timeout`): the change is not
 * confirmed, never reported as applied, and a retry would send it again.
 * Ctrl-C-aware. A throttled or 5xx read counts as one more pending poll, since
 * the change itself was accepted; any other read failure ends the wait,
 * unchanged. `--no-wait` (`CDKD_NO_WAIT=true`) skips every wait, as for the
 * #7157 waits (maintainer decision there). Each wait runs only on the path
 * that sent its call, so an update that does not touch the setting makes no
 * new AWS call.
 */

export interface InstanceSettleWaitOptions {
  readonly maskSecrets: SecretMasker;
  readonly debug: (message: string) => void;
  /** Overrides for tests. */
  readonly pollMs?: number;
  readonly maxPolls?: number;
}

/** The instance a wait reads, with its options. */
export interface InstanceSettleSite extends InstanceSettleWaitOptions {
  readonly client: EC2Client;
  readonly logicalId: string;
  readonly instanceId: string;
}

/** Re-read every second, for up to 2 minutes (each settled in ~0.8 s). */
export const INSTANCE_SETTLE_POLL_MS = 1000;
export const INSTANCE_SETTLE_POLLS = 120;
/**
 * Reads right after `ModifyInstanceMetadataOptions` that may still show the
 * options from before it, `applied`, before the wait takes `applied` as the
 * result.
 */
export const METADATA_STALE_READ_GRACE_POLLS = 5;

async function pollUntilSettled<T>(
  what: string,
  opts: InstanceSettleWaitOptions,
  read: () => Promise<T>,
  /** `'settled'`, `'pending'`, or a failure to throw. */
  judge: (value: T, poll: number) => 'settled' | 'pending' | Error,
  describeLast: (value: T | undefined) => string
): Promise<void> {
  const { maskSecrets } = opts;
  const pollMs = opts.pollMs ?? INSTANCE_SETTLE_POLL_MS;
  const maxPolls = opts.maxPolls ?? INSTANCE_SETTLE_POLLS;
  if (process.env['CDKD_NO_WAIT'] === 'true') {
    opts.debug(maskSecrets(`Skipping the wait for ${what} (CDKD_NO_WAIT=true)`));
    return;
  }
  const watch = startInterruptWatch(maskSecrets(what));
  let last: T | undefined;
  try {
    for (let poll = 1; poll <= maxPolls; poll++) {
      if (watch.isInterrupted()) throw watch.onInterrupted();
      // The engine's deadline does not cancel this call chain, so a wait that
      // outlived it would keep polling with nobody waiting on it.
      if (enclosingDeadlineRemainingMs() <= 0) {
        throw markNonRetryable(
          new Error(
            maskSecrets(
              `The resource timeout expired while waiting for ${what} (last state: ` +
                `${describeLast(last)}); the change is not confirmed`
            )
          )
        );
      }
      let verdict: 'settled' | 'pending' | Error = 'pending';
      try {
        last = await read();
        verdict = judge(last, poll);
      } catch (error) {
        if (!(isThrottlingError(error) || isTransientServerError(error))) throw error;
        opts.debug(
          maskSecrets(
            `A read while waiting for ${what} was throttled or failed server-side; reading again`
          )
        );
      }
      if (verdict === 'settled') return;
      if (verdict instanceof Error) throw markNonRetryable(verdict);
      if (poll === maxPolls) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(pollMs, enclosingDeadlineRemainingMs())))
      );
    }
  } finally {
    watch.dispose();
  }
  throw markNonRetryable(
    new Error(
      maskSecrets(
        `Timed out waiting for ${what}: still ${describeLast(last)} after ` +
          `${(maxPolls * pollMs) / 1000} seconds; the change is not confirmed`
      )
    )
  );
}

async function describeInstance(
  client: EC2Client,
  instanceId: string
): Promise<Instance | undefined> {
  const resp = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
  return resp.Reservations?.[0]?.Instances?.[0];
}

/**
 * After `MonitorInstances` (`enabled` true) / `UnmonitorInstances` (false):
 * wait until `Monitoring.State` reads `enabled` / `disabled`. The state from
 * before the call is what the first read can still answer, so any other state
 * is pending.
 */
export async function waitForInstanceMonitoringSettled(
  opts: InstanceSettleSite,
  enabled: boolean
): Promise<void> {
  const { client, logicalId, instanceId } = opts;
  const expected = enabled ? 'enabled' : 'disabled';
  await pollUntilSettled(
    `detailed monitoring on EC2 Instance ${logicalId} (${instanceId}) to read ${expected}`,
    opts,
    () => describeInstance(client, instanceId),
    (instance) => (instance?.Monitoring?.State === expected ? 'settled' : 'pending'),
    (instance) => instance?.Monitoring?.State ?? 'none read'
  );
}

/**
 * After `ModifyInstanceMetadataOptions`: wait until `MetadataOptions.State`
 * reads `applied`. An `applied` read whose values still differ from the
 * request can be the options from before the call, so it counts only after
 * {@link METADATA_STALE_READ_GRACE_POLLS} polls (AWS may also normalize a
 * value, which must not fail the deploy).
 */
export async function waitForInstanceMetadataOptionsSettled(
  opts: InstanceSettleSite,
  requested: InstanceMetadataOptionsRequest
): Promise<void> {
  const { client, logicalId, instanceId } = opts;
  type Scalars = Record<string, string | number | undefined>;
  const sent = requested as Scalars;
  await pollUntilSettled(
    `the metadata options of EC2 Instance ${logicalId} (${instanceId}) to read applied`,
    opts,
    () => describeInstance(client, instanceId),
    (instance, poll) => {
      const md = instance?.MetadataOptions as Scalars | undefined;
      if (md?.['State'] !== 'applied') return 'pending';
      const matches = Object.keys(sent).every(
        (k) => sent[k] === undefined || String(md[k]) === String(sent[k])
      );
      return matches || poll > METADATA_STALE_READ_GRACE_POLLS ? 'settled' : 'pending';
    },
    (instance) => instance?.MetadataOptions?.State ?? 'none read'
  );
}

/** What {@link waitForInstanceProfileAssociationSettled} waits for. */
export type InstanceProfileAssociationTarget =
  | {
      /** After `AssociateIamInstanceProfile` / `ReplaceIamInstanceProfileAssociation`. */
      readonly kind: 'associated';
      /** The association id the call answered, when it answered one. */
      readonly associationId?: string | undefined;
      /** The requested profile, matched when no association id was answered. */
      readonly arn?: string | undefined;
      readonly name?: string | undefined;
    }
  | {
      /** After `DisassociateIamInstanceProfile`. */
      readonly kind: 'disassociated';
      readonly associationId: string;
    };

function profileMatches(
  a: IamInstanceProfileAssociation,
  arn: string | undefined,
  name: string | undefined
): boolean {
  const live = a.IamInstanceProfile?.Arn;
  if (live === undefined) return false;
  if (arn !== undefined) return live === arn;
  return name !== undefined && live.endsWith(`/${name}`);
}

/**
 * After the IAM instance profile associate / replace (`kind: 'associated'`):
 * wait until the new association reads `associated`. It reading
 * `disassociated` fails (the profile is not bound and never will be by this
 * call); it being absent, or `associating`, is pending (the list can lag the
 * call). After a disassociate: wait until the association is gone or reads
 * `disassociated`.
 */
export async function waitForInstanceProfileAssociationSettled(
  opts: InstanceSettleSite,
  target: InstanceProfileAssociationTarget
): Promise<void> {
  const { client, logicalId, instanceId } = opts;
  const find = (list: readonly IamInstanceProfileAssociation[]) =>
    target.associationId !== undefined
      ? list.find((a) => a.AssociationId === target.associationId)
      : target.kind === 'associated'
        ? (list.find(
            (a) => profileMatches(a, target.arn, target.name) && a.State !== 'disassociated'
          ) ?? list.find((a) => profileMatches(a, target.arn, target.name)))
        : undefined;
  const what =
    `the IAM instance profile association of EC2 Instance ${logicalId} (${instanceId}) ` +
    `to read ${target.kind}`;
  await pollUntilSettled(
    what,
    opts,
    async () =>
      find(
        (
          await client.send(
            new DescribeIamInstanceProfileAssociationsCommand({
              Filters: [{ Name: 'instance-id', Values: [instanceId] }],
            })
          )
        ).IamInstanceProfileAssociations ?? []
      ),
    (assoc) => {
      const state = assoc?.State;
      if (target.kind === 'disassociated') {
        return state === undefined || state === 'disassociated' ? 'settled' : 'pending';
      }
      if (state === 'associated') return 'settled';
      if (state === 'disassociated') {
        return new Error(
          opts.maskSecrets(
            `The IAM instance profile association of EC2 Instance ${logicalId} (${instanceId}) ` +
              `settled as disassociated, expected associated; the profile is not bound`
          )
        );
      }
      return 'pending';
    },
    (assoc) => assoc?.State ?? 'absent'
  );
}
