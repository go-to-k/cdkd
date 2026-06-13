// Tiny handler baked into the Docker image asset that cdkd builds + pushes to
// ECR during `cdkd deploy`. Returns a DISTINCT marker (`docker`) so the integ
// can prove THIS image (not one of the zip assets) is wired to THIS Lambda —
// a cross-wired asset would return a different marker and fail the test.
exports.handler = async (event) => {
  return {
    statusCode: 200,
    marker: 'cdkd-multi-asset-marker-docker',
    deployedBy: process.env.DEPLOYED_BY ?? 'unknown',
    echoed: event,
  };
};
