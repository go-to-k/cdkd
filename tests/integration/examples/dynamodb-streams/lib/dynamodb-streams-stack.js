"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DynamodbStreamsStack = void 0;
const cdk = __importStar(require("aws-cdk-lib"));
const dynamodb = __importStar(require("aws-cdk-lib/aws-dynamodb"));
const lambda = __importStar(require("aws-cdk-lib/aws-lambda"));
const lambdaEventSources = __importStar(require("aws-cdk-lib/aws-lambda-event-sources"));
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
class DynamodbStreamsStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // Create DynamoDB table with stream enabled
        const table = new dynamodb.Table(this, 'EventsTable', {
            partitionKey: {
                name: 'id',
                type: dynamodb.AttributeType.STRING,
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
        });
        // Create Lambda function with inline code to process stream records
        const fn = new lambda.Function(this, 'StreamProcessor', {
            runtime: lambda.Runtime.PYTHON_3_12,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json

def handler(event, context):
    for record in event.get('Records', []):
        event_name = record.get('eventName', 'UNKNOWN')
        dynamodb_record = record.get('dynamodb', {})
        keys = dynamodb_record.get('Keys', {})
        print(f"Event: {event_name}, Keys: {json.dumps(keys)}")

        if event_name == 'INSERT':
            new_image = dynamodb_record.get('NewImage', {})
            print(f"New item: {json.dumps(new_image)}")
        elif event_name == 'MODIFY':
            old_image = dynamodb_record.get('OldImage', {})
            new_image = dynamodb_record.get('NewImage', {})
            print(f"Old: {json.dumps(old_image)}")
            print(f"New: {json.dumps(new_image)}")
        elif event_name == 'REMOVE':
            old_image = dynamodb_record.get('OldImage', {})
            print(f"Deleted item: {json.dumps(old_image)}")

    return {
        'statusCode': 200,
        'body': json.dumps({'processed': len(event.get('Records', []))})
    }
`),
            timeout: cdk.Duration.seconds(30),
            environment: {
                TABLE_NAME: table.tableName,
            },
        });
        // Add DynamoDB stream as event source for Lambda
        fn.addEventSource(new lambdaEventSources.DynamoEventSource(table, {
            startingPosition: lambda.StartingPosition.TRIM_HORIZON,
            batchSize: 10,
            retryAttempts: 3,
        }));
        // Outputs
        new cdk.CfnOutput(this, 'TableName', {
            value: table.tableName,
            description: 'DynamoDB table name',
        });
        new cdk.CfnOutput(this, 'TableArn', {
            value: table.tableArn,
            description: 'DynamoDB table ARN',
        });
        new cdk.CfnOutput(this, 'StreamArn', {
            value: table.tableStreamArn,
            description: 'DynamoDB stream ARN',
        });
        new cdk.CfnOutput(this, 'FunctionName', {
            value: fn.functionName,
            description: 'Stream processor Lambda function name',
        });
    }
}
exports.DynamodbStreamsStack = DynamodbStreamsStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZHluYW1vZGItc3RyZWFtcy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImR5bmFtb2RiLXN0cmVhbXMtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsaURBQW1DO0FBRW5DLG1FQUFxRDtBQUNyRCwrREFBaUQ7QUFDakQseUZBQTJFO0FBRTNFOzs7Ozs7Ozs7R0FTRztBQUNILE1BQWEsb0JBQXFCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFDakQsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxLQUFzQjtRQUM5RCxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4Qiw0Q0FBNEM7UUFDNUMsTUFBTSxLQUFLLEdBQUcsSUFBSSxRQUFRLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDcEQsWUFBWSxFQUFFO2dCQUNaLElBQUksRUFBRSxJQUFJO2dCQUNWLElBQUksRUFBRSxRQUFRLENBQUMsYUFBYSxDQUFDLE1BQU07YUFDcEM7WUFDRCxXQUFXLEVBQUUsUUFBUSxDQUFDLFdBQVcsQ0FBQyxlQUFlO1lBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87WUFDeEMsTUFBTSxFQUFFLFFBQVEsQ0FBQyxjQUFjLENBQUMsa0JBQWtCO1NBQ25ELENBQUMsQ0FBQztRQUVILG9FQUFvRTtRQUNwRSxNQUFNLEVBQUUsR0FBRyxJQUFJLE1BQU0sQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGlCQUFpQixFQUFFO1lBQ3RELE9BQU8sRUFBRSxNQUFNLENBQUMsT0FBTyxDQUFDLFdBQVc7WUFDbkMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLE1BQU0sQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTBCbEMsQ0FBQztZQUNJLE9BQU8sRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUM7WUFDakMsV0FBVyxFQUFFO2dCQUNYLFVBQVUsRUFBRSxLQUFLLENBQUMsU0FBUzthQUM1QjtTQUNGLENBQUMsQ0FBQztRQUVILGlEQUFpRDtRQUNqRCxFQUFFLENBQUMsY0FBYyxDQUNmLElBQUksa0JBQWtCLENBQUMsaUJBQWlCLENBQUMsS0FBSyxFQUFFO1lBQzlDLGdCQUFnQixFQUFFLE1BQU0sQ0FBQyxnQkFBZ0IsQ0FBQyxZQUFZO1lBQ3RELFNBQVMsRUFBRSxFQUFFO1lBQ2IsYUFBYSxFQUFFLENBQUM7U0FDakIsQ0FBQyxDQUNILENBQUM7UUFFRixVQUFVO1FBQ1YsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDbkMsS0FBSyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQ3RCLFdBQVcsRUFBRSxxQkFBcUI7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDbEMsS0FBSyxFQUFFLEtBQUssQ0FBQyxRQUFRO1lBQ3JCLFdBQVcsRUFBRSxvQkFBb0I7U0FDbEMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxXQUFXLEVBQUU7WUFDbkMsS0FBSyxFQUFFLEtBQUssQ0FBQyxjQUFlO1lBQzVCLFdBQVcsRUFBRSxxQkFBcUI7U0FDbkMsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUU7WUFDdEMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxZQUFZO1lBQ3RCLFdBQVcsRUFBRSx1Q0FBdUM7U0FDckQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBbEZELG9EQWtGQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcbmltcG9ydCAqIGFzIGR5bmFtb2RiIGZyb20gJ2F3cy1jZGstbGliL2F3cy1keW5hbW9kYic7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBsYW1iZGFFdmVudFNvdXJjZXMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxhbWJkYS1ldmVudC1zb3VyY2VzJztcblxuLyoqXG4gKiBEeW5hbW9EQiBTdHJlYW1zIGV4YW1wbGUgc3RhY2tcbiAqXG4gKiBEZW1vbnN0cmF0ZXM6XG4gKiAtIER5bmFtb0RCIHRhYmxlIHdpdGggc3RyZWFtIGVuYWJsZWQgKE5FV19BTkRfT0xEX0lNQUdFUylcbiAqIC0gTGFtYmRhIGZ1bmN0aW9uIHdpdGggaW5saW5lIGNvZGUgdHJpZ2dlcmVkIGJ5IER5bmFtb0RCIHN0cmVhbVxuICogLSBFdmVudCBzb3VyY2UgbWFwcGluZyBjb25uZWN0aW5nIHN0cmVhbSB0byBMYW1iZGFcbiAqIC0gSUFNIHJvbGUgd2l0aCBzdHJlYW0gcmVhZCBwZXJtaXNzaW9uc1xuICogLSBGbjo6R2V0QXR0IGZvciBvdXRwdXRzICh0YWJsZSBBUk4sIHN0cmVhbSBBUk4sIGZ1bmN0aW9uIG5hbWUpXG4gKi9cbmV4cG9ydCBjbGFzcyBEeW5hbW9kYlN0cmVhbXNTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIENyZWF0ZSBEeW5hbW9EQiB0YWJsZSB3aXRoIHN0cmVhbSBlbmFibGVkXG4gICAgY29uc3QgdGFibGUgPSBuZXcgZHluYW1vZGIuVGFibGUodGhpcywgJ0V2ZW50c1RhYmxlJywge1xuICAgICAgcGFydGl0aW9uS2V5OiB7XG4gICAgICAgIG5hbWU6ICdpZCcsXG4gICAgICAgIHR5cGU6IGR5bmFtb2RiLkF0dHJpYnV0ZVR5cGUuU1RSSU5HLFxuICAgICAgfSxcbiAgICAgIGJpbGxpbmdNb2RlOiBkeW5hbW9kYi5CaWxsaW5nTW9kZS5QQVlfUEVSX1JFUVVFU1QsXG4gICAgICByZW1vdmFsUG9saWN5OiBjZGsuUmVtb3ZhbFBvbGljeS5ERVNUUk9ZLFxuICAgICAgc3RyZWFtOiBkeW5hbW9kYi5TdHJlYW1WaWV3VHlwZS5ORVdfQU5EX09MRF9JTUFHRVMsXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgTGFtYmRhIGZ1bmN0aW9uIHdpdGggaW5saW5lIGNvZGUgdG8gcHJvY2VzcyBzdHJlYW0gcmVjb3Jkc1xuICAgIGNvbnN0IGZuID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnU3RyZWFtUHJvY2Vzc29yJywge1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfMTIsXG4gICAgICBoYW5kbGVyOiAnaW5kZXguaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tSW5saW5lKGBcbmltcG9ydCBqc29uXG5cbmRlZiBoYW5kbGVyKGV2ZW50LCBjb250ZXh0KTpcbiAgICBmb3IgcmVjb3JkIGluIGV2ZW50LmdldCgnUmVjb3JkcycsIFtdKTpcbiAgICAgICAgZXZlbnRfbmFtZSA9IHJlY29yZC5nZXQoJ2V2ZW50TmFtZScsICdVTktOT1dOJylcbiAgICAgICAgZHluYW1vZGJfcmVjb3JkID0gcmVjb3JkLmdldCgnZHluYW1vZGInLCB7fSlcbiAgICAgICAga2V5cyA9IGR5bmFtb2RiX3JlY29yZC5nZXQoJ0tleXMnLCB7fSlcbiAgICAgICAgcHJpbnQoZlwiRXZlbnQ6IHtldmVudF9uYW1lfSwgS2V5czoge2pzb24uZHVtcHMoa2V5cyl9XCIpXG5cbiAgICAgICAgaWYgZXZlbnRfbmFtZSA9PSAnSU5TRVJUJzpcbiAgICAgICAgICAgIG5ld19pbWFnZSA9IGR5bmFtb2RiX3JlY29yZC5nZXQoJ05ld0ltYWdlJywge30pXG4gICAgICAgICAgICBwcmludChmXCJOZXcgaXRlbToge2pzb24uZHVtcHMobmV3X2ltYWdlKX1cIilcbiAgICAgICAgZWxpZiBldmVudF9uYW1lID09ICdNT0RJRlknOlxuICAgICAgICAgICAgb2xkX2ltYWdlID0gZHluYW1vZGJfcmVjb3JkLmdldCgnT2xkSW1hZ2UnLCB7fSlcbiAgICAgICAgICAgIG5ld19pbWFnZSA9IGR5bmFtb2RiX3JlY29yZC5nZXQoJ05ld0ltYWdlJywge30pXG4gICAgICAgICAgICBwcmludChmXCJPbGQ6IHtqc29uLmR1bXBzKG9sZF9pbWFnZSl9XCIpXG4gICAgICAgICAgICBwcmludChmXCJOZXc6IHtqc29uLmR1bXBzKG5ld19pbWFnZSl9XCIpXG4gICAgICAgIGVsaWYgZXZlbnRfbmFtZSA9PSAnUkVNT1ZFJzpcbiAgICAgICAgICAgIG9sZF9pbWFnZSA9IGR5bmFtb2RiX3JlY29yZC5nZXQoJ09sZEltYWdlJywge30pXG4gICAgICAgICAgICBwcmludChmXCJEZWxldGVkIGl0ZW06IHtqc29uLmR1bXBzKG9sZF9pbWFnZSl9XCIpXG5cbiAgICByZXR1cm4ge1xuICAgICAgICAnc3RhdHVzQ29kZSc6IDIwMCxcbiAgICAgICAgJ2JvZHknOiBqc29uLmR1bXBzKHsncHJvY2Vzc2VkJzogbGVuKGV2ZW50LmdldCgnUmVjb3JkcycsIFtdKSl9KVxuICAgIH1cbmApLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLnNlY29uZHMoMzApLFxuICAgICAgZW52aXJvbm1lbnQ6IHtcbiAgICAgICAgVEFCTEVfTkFNRTogdGFibGUudGFibGVOYW1lLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8vIEFkZCBEeW5hbW9EQiBzdHJlYW0gYXMgZXZlbnQgc291cmNlIGZvciBMYW1iZGFcbiAgICBmbi5hZGRFdmVudFNvdXJjZShcbiAgICAgIG5ldyBsYW1iZGFFdmVudFNvdXJjZXMuRHluYW1vRXZlbnRTb3VyY2UodGFibGUsIHtcbiAgICAgICAgc3RhcnRpbmdQb3NpdGlvbjogbGFtYmRhLlN0YXJ0aW5nUG9zaXRpb24uVFJJTV9IT1JJWk9OLFxuICAgICAgICBiYXRjaFNpemU6IDEwLFxuICAgICAgICByZXRyeUF0dGVtcHRzOiAzLFxuICAgICAgfSlcbiAgICApO1xuXG4gICAgLy8gT3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYWJsZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGFibGUudGFibGVOYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiB0YWJsZSBuYW1lJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdUYWJsZUFybicsIHtcbiAgICAgIHZhbHVlOiB0YWJsZS50YWJsZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnRHluYW1vREIgdGFibGUgQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdTdHJlYW1Bcm4nLCB7XG4gICAgICB2YWx1ZTogdGFibGUudGFibGVTdHJlYW1Bcm4hLFxuICAgICAgZGVzY3JpcHRpb246ICdEeW5hbW9EQiBzdHJlYW0gQVJOJyxcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdGdW5jdGlvbk5hbWUnLCB7XG4gICAgICB2YWx1ZTogZm4uZnVuY3Rpb25OYW1lLFxuICAgICAgZGVzY3JpcHRpb246ICdTdHJlYW0gcHJvY2Vzc29yIExhbWJkYSBmdW5jdGlvbiBuYW1lJyxcbiAgICB9KTtcbiAgfVxufVxuIl19