exports.handler = async (event) => {
  return {
    echoed: event,
    greeting: process.env.GREETING ?? 'unset',
    // Issue #1836: the CONTAINER's own AWS_REGION, echoed so verify.sh can
    // assert it arrives CANONICAL even when the invoking shell spelled it
    // upper-cased. Every SDK client a handler builds reads this value, and AWS
    // SDK endpoint resolution is case-SENSITIVE.
    awsRegion: process.env.AWS_REGION ?? 'unset',
  };
};
