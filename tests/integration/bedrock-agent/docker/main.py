"""Simple handler for Docker-based AgentCore Runtime."""

def handler(event, context):
    return {"statusCode": 200, "body": "Hello from Docker AgentCore Runtime"}
