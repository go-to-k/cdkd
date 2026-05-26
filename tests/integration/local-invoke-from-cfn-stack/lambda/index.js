// Echoes back the env vars the container saw. The integ asserts that
// TABLE_NAME is the deployed DynamoDB table's actual physical name (not
// the literal string "${Token[...]}" or the unresolved intrinsic shape).
exports.handler = async (event) => {
  return {
    tableName: process.env.TABLE_NAME ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    event,
  };
};
