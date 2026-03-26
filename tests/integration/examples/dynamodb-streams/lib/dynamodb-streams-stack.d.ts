import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
/**
 * DynamoDB Streams example stack
 *
 * Demonstrates:
 * - DynamoDB table with stream enabled (NEW_AND_OLD_IMAGES)
 * - Lambda function with inline code triggered by DynamoDB stream
 * - Event source mapping connecting stream to Lambda
 * - IAM role with stream read permissions
 * - Fn::GetAtt for outputs (table ARN, stream ARN, function name)
 */
export declare class DynamodbStreamsStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps);
}
