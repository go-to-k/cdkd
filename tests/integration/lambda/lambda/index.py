import json
import os

def handler(event, context):
    """
    Simple Lambda function handler for testing cdkd deployment.

    Demonstrates:
    - Environment variable access (TABLE_NAME from CDK)
    - Basic JSON response
    """
    table_name = os.environ.get('TABLE_NAME', 'not-set')

    return {
        'statusCode': 200,
        'body': json.dumps({
            'message': 'Hello from cdkd Lambda!',
            'tableName': table_name,
            'event': event
        })
    }
