/** The policy SNS gives a topic with none set, and how cdkd recognizes it. A LEAF. */
import { ProvisioningError } from '../utils/error-handler.js';
import { SNS_DEFAULT_POLICY_ID } from './settle-after-own-write.js';

/** Whether a read topic policy is the default SNS gives a topic with none set. */
export function isSnsDefaultPolicy(document: unknown): boolean {
  return (
    typeof document === 'object' &&
    document !== null &&
    (document as Record<string, unknown>)['Id'] === SNS_DEFAULT_POLICY_ID
  );
}

/**
 * Recognize a single SNS topic ARN. AWS standard form is
 * `arn:<partition>:sns:<region>:<account>:<name>`; FIFO topics end in
 * `.fifo`. Accepts every partition (`aws` / `aws-cn` / `aws-us-gov` /
 * `aws-iso` / etc.) via the broader `arn:<partition>:sns:` prefix shape.
 */
export function isSnsTopicArn(value: string): boolean {
  return /^arn:[a-z0-9-]+:sns:[a-z0-9-]+:\d{12}:[\w.-]+$/.test(value);
}

/**
 * The policy SNS gives a new topic, which CloudFormation's TopicPolicy
 * delete and update handlers write to remove a policy (SNS rejects an empty
 * one): the topic owner's account may manage, subscribe to and publish to it.
 * The account and the `Resource` come from the topic ARN; `undefined` when
 * `topicArn` is not one.
 */
export function defaultTopicPolicy(topicArn: string): string | undefined {
  if (!isSnsTopicArn(topicArn)) return undefined;
  const account = topicArn.split(':')[4]!;
  return JSON.stringify({
    Version: '2008-10-17',
    Id: '__default_policy_ID',
    Statement: [
      {
        Sid: '__default_statement_ID',
        Effect: 'Allow',
        Principal: { AWS: '*' },
        Action: [
          'SNS:GetTopicAttributes',
          'SNS:SetTopicAttributes',
          'SNS:AddPermission',
          'SNS:RemovePermission',
          'SNS:DeleteTopic',
          'SNS:Subscribe',
          'SNS:ListSubscriptionsByTopic',
          'SNS:Publish',
        ],
        Resource: topicArn,
        Condition: { StringEquals: { 'AWS:SourceOwner': account } },
      },
    ],
  });
}

/**
 * What a topic gets when --aws-emulator sends no policy for the document
 * (only the TLS Deny was in it): the topic's default policy, since SNS
 * always holds one.
 */
export function defaultTopicPolicyOrThrow(
  topicArn: string,
  resourceType: string,
  logicalId: string
): string {
  const defaultPolicy = defaultTopicPolicy(topicArn);
  if (defaultPolicy === undefined) {
    throw new ProvisioningError(
      `Cannot set SNS topic policy ${logicalId} on ${topicArn}: not an SNS topic ARN`,
      resourceType,
      logicalId,
      topicArn
    );
  }
  return defaultPolicy;
}
