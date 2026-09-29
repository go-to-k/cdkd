exports.handler = async (event) => {
  // Issue #2419: the Lambda RIE puts every handler log line -- console.error
  // included -- on the CONTAINER's stdout. verify.sh test 7 asserts both
  // markers reach cdkd's STDERR and never its stdout (the response payload).
  console.log('CDKD-2419-HANDLER-STDOUT-MARKER');
  console.error('CDKD-2419-HANDLER-STDERR-MARKER');
  return {
    echoed: event,
    greeting: process.env.GREETING ?? 'unset',
    // Issue #1836: the CONTAINER's own AWS_REGION, echoed so verify.sh can
    // assert it arrives CANONICAL even when the invoking shell spelled it
    // upper-cased. Every SDK client a handler builds reads this value, and AWS
    // SDK endpoint resolution is case-SENSITIVE.
    awsRegion: process.env.AWS_REGION ?? 'unset',
    // Issue #3515: read `__proto__` as an OWN key -- a plain
    // `process.env.__proto__` could resolve to the inherited accessor instead.
    // verify.sh tests 3 / 4 pass one through --env-vars; test 1 is the control.
    protoEnv: Object.getOwnPropertyDescriptor(process.env, '__proto__')?.value ?? 'unset',
  };
};
