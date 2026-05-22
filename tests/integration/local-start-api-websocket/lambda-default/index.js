// $default handler — fires for messages whose RouteSelectionExpression
// value doesn't match any user-declared route. The handler pushes a
// `dropped` notification back via PostToConnection so the client can
// assert the dispatch fired.
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = process.env.AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI;
  console.log('$default:', connectionId, 'endpoint:', endpoint);
  const client = new ApiGatewayManagementApiClient({
    endpoint,
    // Region is required by the SDK client constructor; the override
    // makes the actual call hit cdkd's local server.
    region: 'us-east-1',
  });
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ route: '$default', received: event.body }),
      })
    );
  } catch (err) {
    console.error('PostToConnection failed:', err.message);
  }
  return { statusCode: 200 };
};
