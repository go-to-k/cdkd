// Echoes back the artifacts baked into the image during the build so the
// integ verify.sh can prove each BuildKit feature actually flowed through:
//   - `buildArg`: value of the `--build-arg GREETING_BUILD_ARG=...` flag
//   - `secretSha`: sha256 of the secret file that `--secret id=mysecret,...`
//                  mounted (the secret content itself NEVER lands in the image)
const fs = require('fs');

const buildArg = fs
  .readFileSync(`${process.env.LAMBDA_TASK_ROOT}/build-arg.txt`, 'utf-8')
  .trim();
const secretSha = fs
  .readFileSync(`${process.env.LAMBDA_TASK_ROOT}/secret-sha.txt`, 'utf-8')
  .trim();

exports.handler = async (event) => {
  return {
    echoed: event,
    greeting: process.env.GREETING ?? 'unset',
    buildArg,
    secretSha,
    multiStageTarget: 'final',
    fromBuildkitImage: true,
  };
};
