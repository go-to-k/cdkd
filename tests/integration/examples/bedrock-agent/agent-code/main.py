"""Simple AgentCore Runtime handler for cdkq integration testing."""

def handler(event, context):
    return {"statusCode": 200, "body": "Hello from AgentCore Runtime"}
