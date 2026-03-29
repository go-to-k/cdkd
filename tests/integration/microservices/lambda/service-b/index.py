import json
import os


def handler(event, context):
    """
    Service B Lambda handler.
    Processes messages from service-b-queue (SNS fan-out via SQS).
    Only receives messages with eventType='order' filter.
    """
    service_name = os.environ.get('SERVICE_NAME', 'service-b')
    config_path = os.environ.get('CONFIG_PATH', 'not-set')

    processed = []
    for record in event.get('Records', []):
        body = json.loads(record['body'])
        message = body.get('Message', body)
        processed.append({
            'service': service_name,
            'configPath': config_path,
            'message': message,
        })

    return {
        'statusCode': 200,
        'body': json.dumps({
            'service': service_name,
            'processed': len(processed),
            'results': processed,
        }),
    }
