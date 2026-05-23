// broadcast handler — multi-client broadcast (#528 M4) via
// PostToConnection to every connectionId in `body.recipients`. When
// `recipients` is absent or empty, falls back to echoing the sender
// (pre-PR behavior, preserved so the single-client smoke test still
// works).
//
// AWS-deployed broadcast handlers track connection IDs in DynamoDB /
// Redis since AWS API Gateway doesn't expose a `list connections`
// endpoint. The local integ caller supplies the recipient list
// explicitly via the message body — equivalent fan-out shape, just
// stateless on the handler side.
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');

exports.handler = async (event) => {
  const senderConnectionId = event.requestContext.connectionId;
  const endpoint = process.env.AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI;
  const client = new ApiGatewayManagementApiClient({ endpoint, region: 'us-east-1' });

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    parsed = {};
  }
  const recipients =
    Array.isArray(parsed.recipients) && parsed.recipients.length > 0
      ? parsed.recipients
      : [senderConnectionId];

  const timestamp = Date.now();
  for (const target of recipients) {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: target,
        Data: JSON.stringify({
          route: 'broadcast',
          from: senderConnectionId,
          timestamp,
        }),
      })
    );
  }
  return { statusCode: 200 };
};
