"""Simple AgentCore Runtime handler for cdkd integration testing."""

def handler(event, context):
    return {"statusCode": 200, "body": "Hello from AgentCore Runtime"}
