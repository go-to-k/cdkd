import os

import boto3

from pkg.marker import MARKER, VERSION


def handler(event, context):
    """
    ALPHA zip-asset Lambda handler.

    Returns its OWN distinct marker (proving the alpha asset ZIP is the running
    code for THIS function and was not cross-wired to beta/gamma), PLUS reads
    back the generic s3_assets.Asset that cdkd uploaded to the bootstrap bucket
    and wired in via the CONFIG_BUCKET / CONFIG_KEY env vars (proving the
    generic-asset upload reached AWS and the bucket/key intrinsic resolved).
    """
    bucket = os.environ.get("CONFIG_BUCKET", "")
    key = os.environ.get("CONFIG_KEY", "")

    config_bytes = 0
    config_error = None
    if bucket and key:
        try:
            s3 = boto3.client("s3")
            obj = s3.get_object(Bucket=bucket, Key=key)
            config_bytes = len(obj["Body"].read())
        except Exception as exc:  # noqa: BLE001 - surface any S3 error to the test
            config_error = str(exc)

    return {
        "marker": MARKER,
        "version": VERSION,
        "configBytes": config_bytes,
        "configError": config_error,
        "event": event,
    }
