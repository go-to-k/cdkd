"""
Data Processor Lambda Function

Processes S3 events from SQS queue and stores metadata in DynamoDB.

Environment Variables:
- METADATA_TABLE_NAME: DynamoDB table name for metadata
- DATA_BUCKET_NAME: S3 bucket name for data files
- DLQ_URL: Dead Letter Queue URL for failed messages
"""

import json
import os
import time
import boto3
from typing import Dict, List, Any
from datetime import datetime

# Initialize AWS clients
s3_client = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
sqs_client = boto3.client('sqs')

# Get environment variables
METADATA_TABLE_NAME = os.environ['METADATA_TABLE_NAME']
DATA_BUCKET_NAME = os.environ['DATA_BUCKET_NAME']
DLQ_URL = os.environ['DLQ_URL']

# Get DynamoDB table
metadata_table = dynamodb.Table(METADATA_TABLE_NAME)


def handler(event: Dict[str, Any], context: Any) -> Dict[str, Any]:
    """
    Lambda handler function for processing S3 events from SQS.

    Args:
        event: SQS event containing S3 event notifications
        context: Lambda context object

    Returns:
        Dictionary with batch item failures for partial batch responses
    """
    print(f"Processing batch of {len(event['Records'])} messages")

    batch_item_failures = []

    for record in event['Records']:
        try:
            # Parse SQS message body (contains S3 event)
            message_body = json.loads(record['body'])

            # Handle S3 test events
            if 'Event' in message_body and message_body['Event'] == 's3:TestEvent':
                print("Received S3 test event, skipping")
                continue

            # Process S3 event records
            if 'Records' in message_body:
                for s3_record in message_body['Records']:
                    process_s3_event(s3_record, record)
            else:
                print(f"Unknown message format: {message_body}")

        except Exception as e:
            print(f"Error processing record: {str(e)}")
            # Add to batch item failures to retry later
            batch_item_failures.append({
                'itemIdentifier': record['messageId']
            })

            # Send to DLQ if critical failure
            send_to_dlq(record, str(e))

    return {
        'batchItemFailures': batch_item_failures
    }


def process_s3_event(s3_record: Dict[str, Any], sqs_record: Dict[str, Any]) -> None:
    """
    Process a single S3 event record.

    Args:
        s3_record: S3 event record from the message
        sqs_record: Original SQS record for error handling
    """
    # Extract S3 object information
    bucket_name = s3_record['s3']['bucket']['name']
    object_key = s3_record['s3']['object']['key']
    object_size = s3_record['s3']['object'].get('size', 0)
    event_time = s3_record['eventTime']
    event_name = s3_record['eventName']

    print(f"Processing S3 event: {event_name} for {bucket_name}/{object_key}")

    # Get object metadata from S3
    try:
        response = s3_client.head_object(Bucket=bucket_name, Key=object_key)
        content_type = response.get('ContentType', 'unknown')
        last_modified = response['LastModified'].isoformat()
    except Exception as e:
        print(f"Error getting object metadata: {str(e)}")
        content_type = 'unknown'
        last_modified = event_time

    # Generate file ID from object key
    file_id = object_key.replace('/', '-').replace('.', '-')

    # Store metadata in DynamoDB
    timestamp = int(time.time() * 1000)  # milliseconds

    item = {
        'fileId': file_id,
        'timestamp': timestamp,
        'bucketName': bucket_name,
        'objectKey': object_key,
        'objectSize': object_size,
        'contentType': content_type,
        'eventName': event_name,
        'eventTime': event_time,
        'lastModified': last_modified,
        'status': 'processed',
        'processedAt': datetime.utcnow().isoformat(),
        'sqsMessageId': sqs_record['messageId'],
    }

    try:
        metadata_table.put_item(Item=item)
        print(f"Successfully stored metadata for {file_id}")
    except Exception as e:
        print(f"Error storing metadata in DynamoDB: {str(e)}")
        raise


def send_to_dlq(record: Dict[str, Any], error_message: str) -> None:
    """
    Send failed message to Dead Letter Queue.

    Args:
        record: Original SQS record that failed
        error_message: Error message describing the failure
    """
    try:
        dlq_message = {
            'originalMessageId': record['messageId'],
            'errorMessage': error_message,
            'failedAt': datetime.utcnow().isoformat(),
            'originalBody': record['body'],
        }

        sqs_client.send_message(
            QueueUrl=DLQ_URL,
            MessageBody=json.dumps(dlq_message)
        )
        print(f"Sent failed message to DLQ: {record['messageId']}")
    except Exception as e:
        print(f"Error sending message to DLQ: {str(e)}")
