import json
import os


def handler(event, context):
    """Simple Lambda handler running in a Docker container."""
    return {
        "statusCode": 200,
        "body": json.dumps({
            "message": "Hello from Docker Lambda deployed by cdkq!",
            "deployed_by": os.environ.get("DEPLOYED_BY", "unknown"),
        }),
    }
