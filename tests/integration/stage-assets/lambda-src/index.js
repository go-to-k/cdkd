// Marker is asserted by verify.sh: proves the ZIP asset staged for a Stage
// stack was uploaded and wired to this function.
exports.handler = async () => ({ marker: 'stage-file-asset' });
