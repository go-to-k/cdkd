// Handler under test for the layers integ.
//
// Loads two modules that ONLY exist inside Lambda layers:
//   - `util-greetings` lives in BOTH greetings-a and greetings-b
//     layers under /opt/nodejs/node_modules/util-greetings/index.js;
//     `Layers: [greetingsA, greetingsB]` means the LAST one wins, so
//     `greet(...)` should produce the layer-B output.
//   - `util-counters` lives only in the counters layer.
//
// /opt/nodejs/node_modules/ is on the Node module-resolution path inside
// the AWS Lambda Node.js base image (the runtime sets NODE_PATH to
// include it on boot), so `require('util-greetings')` resolves to the
// bind-mounted layer code.
const greetings = require('util-greetings');
const counters = require('util-counters');

exports.handler = async (event) => {
  return {
    greeting: greetings.greet(event.name ?? 'world'),
    greetingSource: greetings.source,
    counter: counters.count(event.n ?? 0),
    counterSource: counters.source,
  };
};
