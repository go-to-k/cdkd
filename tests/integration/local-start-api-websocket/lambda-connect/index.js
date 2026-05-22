// $connect handler — admits every client. Returning {statusCode: 200}
// is the AWS-canonical allow signal.
exports.handler = async (event) => {
  console.log('$connect:', event.requestContext.connectionId);
  return { statusCode: 200, body: 'OK' };
};
