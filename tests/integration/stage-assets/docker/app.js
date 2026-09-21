// Marker is asserted by verify.sh: proves THIS image, built from a Docker
// asset declared inside a cdk.Stage, is what the Lambda runs.
exports.handler = async () => ({ marker: 'stage-docker-asset' });
