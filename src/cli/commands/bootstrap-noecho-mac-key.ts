import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  ScheduleKeyDeletionCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';
import { awsEndpointOverrideActive } from '../../utils/aws-client-defaults.js';
import { NOECHO_MAC_KEY_ALIAS } from '../../deployment/noecho-value-macs.js';

/** What {@link ensureNoEchoMacKey} reports, for the bootstrap summary. */
export type NoEchoMacKeyOutcome = 'created' | 'exists' | 'skipped' | 'failed';

/** An AWS error's `name`, never its message (which can quote account and role). */
function errorName(error: unknown): string {
  const raw = (error as { name?: unknown } | null)?.name;
  return typeof raw === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw) ? raw : 'Error';
}

/**
 * The actions the key policy lets IAM policies of the account grant on the
 * key: administration (no `kms:CreateGrant`, which could hand out any
 * operation) plus `kms:GenerateMac`. Not `kms:VerifyMac` nor anything else a
 * deploy does not call.
 */
export const NOECHO_MAC_KEY_ADMIN_ACTIONS = [
  'kms:DescribeKey',
  'kms:GetKeyPolicy',
  'kms:PutKeyPolicy',
  'kms:ListResourceTags',
  'kms:ListGrants',
  'kms:RevokeGrant',
  'kms:CreateAlias',
  'kms:UpdateAlias',
  'kms:DeleteAlias',
  'kms:EnableKey',
  'kms:DisableKey',
  'kms:UpdateKeyDescription',
  'kms:TagResource',
  'kms:UntagResource',
  'kms:ScheduleKeyDeletion',
  'kms:CancelKeyDeletion',
] as const;

/**
 * The key policy of the MAC key: the account root (so IAM policies decide who
 * may act) for {@link NOECHO_MAC_KEY_ADMIN_ACTIONS} and `kms:GenerateMac`
 * only. `kms:PutKeyPolicy` stays in, so the policy passes KMS's lockout check.
 */
export function noEchoMacKeyPolicy(partition: string, accountId: string): string {
  const root = { AWS: `arn:${partition}:iam::${accountId}:root` };
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'KeyAdministration',
        Effect: 'Allow',
        Principal: root,
        Action: [...NOECHO_MAC_KEY_ADMIN_ACTIONS],
        Resource: '*',
      },
      {
        Sid: 'GenerateMacThroughIam',
        Effect: 'Allow',
        Principal: root,
        Action: 'kms:GenerateMac',
        Resource: '*',
      },
    ],
  });
}

/** The partition of an ARN (`aws` when unreadable). */
export function partitionOfArn(arn: string | undefined): string {
  const partition = arn?.split(':')[1];
  return partition !== undefined && /^aws(-[a-z]+)*$/.test(partition) ? partition : 'aws';
}

/**
 * go-to-k/cdkd#6146: the HMAC KMS key whose `GenerateMac` lets a deploy tell
 * whether a `NoEcho` parameter value changed since the last deploy, under
 * {@link NOECHO_MAC_KEY_ALIAS} in the bootstrapped region.
 *
 * Idempotent: an alias already naming an enabled HMAC key is kept, its policy
 * untouched. A new key takes {@link noEchoMacKeyPolicy} (least privilege: the
 * account's IAM policies may grant `kms:GenerateMac` and administration, never
 * `kms:VerifyMac`): a deploying identity needs `kms:GenerateMac` on it.
 * Never fails the bootstrap: without the key every deploy behaves as before
 * (a write-only property a `NoEcho` parameter feeds is re-sent), so a failure
 * warns with the error name and the bootstrap goes on. Not made against an
 * AWS Emulator target.
 */
export async function ensureNoEchoMacKey(args: {
  kms: Pick<KMSClient, 'send'>;
  region: string;
  accountId: string;
  partition: string;
  report: (message: string) => void;
  warn: (message: string) => void;
}): Promise<NoEchoMacKeyOutcome> {
  const { kms, region, accountId, partition, report, warn } = args;
  if (awsEndpointOverrideActive()) {
    report(`Skipping the NoEcho value MAC key (${NOECHO_MAC_KEY_ALIAS}): AWS Emulator target`);
    return 'skipped';
  }
  const failed = (step: string, error: unknown): NoEchoMacKeyOutcome => {
    warn(
      `Could not set up the NoEcho value MAC key ${NOECHO_MAC_KEY_ALIAS} in ${region} ` +
        `(${errorName(error)} from ${step}). Deploys keep working: a write-only property a ` +
        `NoEcho parameter feeds is re-sent on every deploy. Re-run 'cdkd bootstrap' with ` +
        'kms:CreateKey, kms:PutKeyPolicy, kms:CreateAlias and kms:DescribeKey to create it.'
    );
    return 'failed';
  };
  try {
    const described = await kms.send(new DescribeKeyCommand({ KeyId: NOECHO_MAC_KEY_ALIAS }));
    const meta = described.KeyMetadata;
    if (
      meta?.KeySpec === 'HMAC_256' &&
      meta.KeyUsage === 'GENERATE_VERIFY_MAC' &&
      meta.KeyState === 'Enabled'
    ) {
      report(`NoEcho value MAC key ${NOECHO_MAC_KEY_ALIAS} already exists`);
      return 'exists';
    }
    warn(
      `${NOECHO_MAC_KEY_ALIAS} in ${region} does not name an enabled HMAC_256 key ` +
        `(${meta?.KeySpec ?? 'unknown spec'}, ${meta?.KeyState ?? 'unknown state'}), so deploys ` +
        'make no NoEcho value MACs. Point the alias at an enabled HMAC_256 key, or delete it ' +
        "and re-run 'cdkd bootstrap'."
    );
    return 'failed';
  } catch (error) {
    if (errorName(error) !== 'NotFoundException') return failed('kms:DescribeKey', error);
  }
  let keyId: string | undefined;
  try {
    const created = await kms.send(
      new CreateKeyCommand({
        KeySpec: 'HMAC_256',
        KeyUsage: 'GENERATE_VERIFY_MAC',
        Policy: noEchoMacKeyPolicy(partition, accountId),
        Description:
          'cdkd: MACs of NoEcho parameter values, so a deploy re-sends a write-only property only when its value changed',
        Tags: [{ TagKey: 'cdkd:purpose', TagValue: 'noecho-value-mac' }],
      })
    );
    keyId = created.KeyMetadata?.KeyId;
    if (keyId === undefined) return failed('kms:CreateKey', new Error('no key id'));
  } catch (error) {
    return failed('kms:CreateKey', error);
  }
  try {
    await kms.send(new CreateAliasCommand({ AliasName: NOECHO_MAC_KEY_ALIAS, TargetKeyId: keyId }));
  } catch (error) {
    // A concurrent bootstrap won the alias: keep its key, retire ours.
    const name = errorName(error);
    await kms
      .send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }))
      .catch((retireError: unknown) =>
        warn(
          `Could not schedule the deletion of the unused KMS key ${keyId} in ${region} ` +
            `(${errorName(retireError)}); schedule it by hand: aws kms schedule-key-deletion ` +
            `--key-id ${keyId} --pending-window-in-days 7 --region ${region}`
        )
      );
    if (name !== 'AlreadyExistsException') return failed('kms:CreateAlias', error);
    // The winner's alias must name a key deploys can use.
    try {
      const won = (await kms.send(new DescribeKeyCommand({ KeyId: NOECHO_MAC_KEY_ALIAS })))
        .KeyMetadata;
      if (
        won?.KeySpec === 'HMAC_256' &&
        won.KeyUsage === 'GENERATE_VERIFY_MAC' &&
        won.KeyState === 'Enabled'
      ) {
        report(`NoEcho value MAC key ${NOECHO_MAC_KEY_ALIAS} already exists`);
        return 'exists';
      }
    } catch (describeError) {
      return failed('kms:DescribeKey', describeError);
    }
    warn(
      `${NOECHO_MAC_KEY_ALIAS} in ${region} does not name an enabled HMAC_256 key, so deploys ` +
        "make no NoEcho value MACs. Point the alias at an enabled HMAC_256 key, or delete it and re-run 'cdkd bootstrap'."
    );
    return 'failed';
  }
  report(`Created the NoEcho value MAC key ${NOECHO_MAC_KEY_ALIAS}`);
  return 'created';
}
