// Echoes back the env vars the container saw. The integ asserts that
// BUCKET_NAME is the deployed S3 bucket's actual physical name (not the
// literal string "${Token[...]}" or the unresolved intrinsic shape), and that
// the secret-bearing values arrived RESOLVED rather than as their
// `{{resolve:...}}` token (issue #2056). Nothing here is logged: the integ
// asserts the plaintext never reaches the CLI's own output.
exports.handler = async (event) => {
  return {
    bucketName: process.env.BUCKET_NAME ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    accountTag: process.env.ACCOUNT_TAG ?? 'unset',
    importedSecret: process.env.IMPORTED_SECRET ?? 'unset',
    sameStackSecret: process.env.SAME_STACK_SECRET ?? 'unset',
    event,
  };
};
