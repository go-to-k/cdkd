import json
import os

import boto3

from helpers.formatter import format_response
from vendored.constants import MARKER, VERSION


def handler(event, context):
    """
    Asset-backed Lambda handler.

    Returns a marker that proves THIS uploaded ZIP (not inline code) is the
    function's running code, plus the contents of the generic S3 asset that
    cdkd uploaded to the bootstrap bucket and wired in via env vars. The
    integ verify.sh invokes this function and asserts the marker + the
    downloaded config payload.
    """
    bucket = os.environ.get("CONFIG_BUCKET", "")
    key = os.environ.get("CONFIG_KEY", "")

    config = {}
    config_error = None
    if bucket and key:
        try:
            s3 = boto3.client("s3")
            obj = s3.get_object(Bucket=bucket, Key=key)
            body = obj["Body"].read()
            # The generic asset is a directory; CDK zips it. boto3 hands us
            # the raw ZIP bytes, so we just confirm it is non-empty + report
            # its size. (The verify.sh only needs proof the object exists and
            # was readable from the function's wired env vars.)
            config = {
                "configBytes": len(body),
                "configBucket": bucket,
                "configKey": key,
            }
        except Exception as exc:  # noqa: BLE001 - surface any S3 error to the test
            config_error = str(exc)

    return format_response(
        {
            "marker": MARKER,
            "version": VERSION,
            "config": config,
            "configError": config_error,
            "event": event,
        }
    )
