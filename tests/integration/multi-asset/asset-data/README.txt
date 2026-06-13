This directory is a generic s3_assets.Asset (NOT Lambda code). cdkd zips it and
uploads it to the CDK bootstrap asset bucket during deploy; the ALPHA Lambda
reads it back at runtime via the CONFIG_BUCKET / CONFIG_KEY env vars to prove
the upload reached AWS and the bucket/key intrinsic references resolved.
