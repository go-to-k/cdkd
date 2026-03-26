import json
import os


def handler(event, context):
    """Simple Lambda handler that reads environment variables set via cross-stack references."""
    table_name = os.environ.get('TABLE_NAME', 'unknown')
    bucket_name = os.environ.get('BUCKET_NAME', 'unknown')

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Multi-stack deps example',
            'tableName': table_name,
            'bucketName': bucket_name,
        }),
    }
