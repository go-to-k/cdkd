// Tiny handler baked into the Docker image asset that cdkd builds + pushes
// to ECR during `cdkd deploy`. The integ asserts this exact payload comes
// back from `aws lambda invoke`, proving the pushed image actually runs.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    message: 'hello from cdkd docker image asset',
    deployedBy: process.env.DEPLOYED_BY ?? 'unknown',
    echoed: event,
  };
};
