import json


def format_response(payload):
    """Wrap a payload dict into an API-Gateway-style JSON response.

    Lives in a sub-package so the asset is a genuine multi-file directory
    tree (handler + helpers/ + vendored/), guaranteeing cdkd zips a real
    directory rather than a single inline file.
    """
    return {
        "statusCode": 200,
        "body": json.dumps(payload),
    }
