import {
  ListSubscriptionsByTopicCommand,
  NotFoundException,
  type SNSClient,
} from '@aws-sdk/client-sns';

/**
 * Whether a subscription `GetSubscriptionAttributes` answered for is still on
 * its topic (go-to-k/cdkd#6711).
 *
 * SNS keeps answering `GetSubscriptionAttributes` for a subscription whose
 * topic was deleted, or deleted and re-created under the same name, with the
 * attributes of a live one, while `ListSubscriptionsByTopic` no longer lists it
 * and nothing published to the topic reaches it. The topic's own list is the
 * answer that matches delivery, so a subscription it does not list is gone.
 *
 * - `listed`: the topic lists the subscription's ARN. A subscription still
 *   `PendingConfirmation` is listed under that literal instead of its ARN, so
 *   for one (`pending`) an entry of that spelling with the same `Protocol` and
 *   `Endpoint` counts (the endpoint compared with any basic-auth password
 *   masked, as the list spells it): SNS keeps one subscription per (topic,
 *   protocol, endpoint).
 * - `absent`: the topic exists and does not list it.
 * - `topic-gone`: the topic itself is `NotFound`.
 *
 * Paginated, stopping at the page that lists it. Any other failure (an access
 * denied, a throttle) is thrown, so the caller reports the read as failed
 * rather than as clean or deleted.
 */
export async function readTopicMembership(
  client: SNSClient,
  topicArn: string,
  subscriptionArn: string,
  pending: { protocol: string | undefined; endpoint: string | undefined } | undefined
): Promise<'listed' | 'absent' | 'topic-gone'> {
  let nextToken: string | undefined;
  do {
    let resp;
    try {
      resp = await client.send(
        new ListSubscriptionsByTopicCommand({
          TopicArn: topicArn,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
    } catch (err) {
      if (err instanceof NotFoundException) return 'topic-gone';
      throw err;
    }
    for (const s of resp?.Subscriptions ?? []) {
      if (s.SubscriptionArn === subscriptionArn) return 'listed';
      if (
        pending !== undefined &&
        s.SubscriptionArn === 'PendingConfirmation' &&
        s.Protocol === pending.protocol &&
        s.Endpoint !== undefined &&
        pending.endpoint !== undefined &&
        maskUrlPassword(s.Endpoint) === maskUrlPassword(pending.endpoint)
      ) {
        return 'listed';
      }
    }
    nextToken = resp?.NextToken;
  } while (nextToken);
  return 'absent';
}

/**
 * An http(s) endpoint with its basic-auth password replaced by `****`.
 * `GetSubscriptionAttributes` returns the password in the clear, while
 * `ListSubscriptionsByTopic` returns it as `****` (measured), so the pending
 * match compares both in the masked spelling.
 */
function maskUrlPassword(endpoint: string): string {
  return endpoint.replace(/^(https?:\/\/[^:/?#@]*:)[^/?#@]*@/i, '$1****@');
}
