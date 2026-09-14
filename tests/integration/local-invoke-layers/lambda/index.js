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
const { execFileSync } = require('child_process');
const greetings = require('util-greetings');
const counters = require('util-counters');

exports.handler = async (event) => {
  // The counters layer ships `bin/real.sh` plus a RELATIVE symlink
  // `bin/rel-link -> real.sh`. Executing through the LINK proves the merged
  // /opt kept it relative (issue #3106): a link rewritten to the host's
  // absolute asset path is dangling in here and this exec throws ENOENT.
  const linkOutput = execFileSync('/opt/bin/rel-link', { encoding: 'utf8' }).trim();
  return {
    greeting: greetings.greet(event.name ?? 'world'),
    greetingSource: greetings.source,
    counter: counters.count(event.n ?? 0),
    counterSource: counters.source,
    linkOutput,
  };
};
