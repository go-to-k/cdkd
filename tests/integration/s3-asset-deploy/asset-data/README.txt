This directory is packaged as a generic s3_assets.Asset by the
CdkdS3AssetDeployExample stack. cdkd zips it and uploads it to the CDK
bootstrap asset bucket during deploy; the Lambda reads it back via the
CONFIG_BUCKET / CONFIG_KEY env vars that cdkd resolves and wires in.

Having more than one file here keeps the asset a real multi-file directory
ZIP rather than a single trivial object.
