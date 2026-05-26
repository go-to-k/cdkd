// Echoes back the env vars the container saw. The integ asserts that
// SHARED_VALUE is the deployed SSM parameter name (the producer stack's
// exported Ref) when invoked with --from-cfn-stack, and "unset" without
// it (because Fn::ImportValue is an intrinsic and the default behavior
// is warn-and-drop).
exports.handler = async (event) => {
  return {
    sharedValue: process.env.SHARED_VALUE ?? 'unset',
    staticValue: process.env.STATIC_VALUE ?? 'unset',
    event,
  };
};
