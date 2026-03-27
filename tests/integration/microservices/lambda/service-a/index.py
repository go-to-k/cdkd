import json
import os


def handler(event, context):
    """
    Service A Lambda handler.
    Processes messages from service-a-queue (SNS fan-out via SQS).
    """
    service_name = os.environ.get('SERVICE_NAME', 'service-a')
    config_path = os.environ.get('CONFIG_PATH', 'not-set')

    processed = []
    for record in event.get('Records', []):
        body = json.loads(record['body'])
        # SNS messages wrapped in SQS have a 'Message' field
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
