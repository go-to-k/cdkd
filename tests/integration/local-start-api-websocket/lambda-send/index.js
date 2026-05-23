// sendMessage handler — echoes the received body back to the same
// connection via PostToConnection. The AWS-canonical WebSocket
// reply path; the handler's HTTP response is discarded by both
// AWS-deployed API Gateway AND cdkd's local emulator.
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = process.env.AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI;
  console.log('sendMessage:', connectionId, 'body:', event.body);

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    parsed = { raw: event.body };
  }

  const client = new ApiGatewayManagementApiClient({
    endpoint,
    region: 'us-east-1',
  });
  await client.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ route: 'sendMessage', echo: parsed.text || null }),
    })
  );
  return { statusCode: 200 };
};
