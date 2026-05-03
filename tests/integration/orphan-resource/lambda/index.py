import json
import os


def handler(event, context):
    """
    Trivial handler used only as a deploy target for the orphan integ test.

    Reads BUCKET_NAME from the env. After `cdkd orphan` rewrites the
    sibling reference to a literal string, the deployed function still
    sees the same value here — proving the rewrite preserved behavior.
    """
    bucket_name = os.environ.get('BUCKET_NAME', 'not-set')
    return {
        'statusCode': 200,
        'body': json.dumps({
            'bucketName': bucket_name,
            'event': event,
        }),
    }
