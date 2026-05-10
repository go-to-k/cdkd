// Echoes back the env vars the container saw. The integ asserts that
// BUCKET_NAME is the deployed S3 bucket's actual physical name (not the
// literal string "${Token[...]}" or the unresolved intrinsic shape).
exports.handler = async (event) => {
  return {
    bucketName: process.env.BUCKET_NAME ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    event,
  };
};
