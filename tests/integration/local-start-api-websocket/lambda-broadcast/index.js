// broadcast handler — pushes a payload back via PostToConnection to
// prove the data-plane endpoint emulation works for ANY route, not
// just the canonical reply pattern.
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const endpoint = process.env.AWS_ENDPOINT_URL_APIGATEWAYMANAGEMENTAPI;
  const client = new ApiGatewayManagementApiClient({
    endpoint,
    region: 'us-east-1',
  });
  await client.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ route: 'broadcast', timestamp: Date.now() }),
    })
  );
  return { statusCode: 200 };
};
