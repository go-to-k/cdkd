import os


def handler(event, context):
    return {
        "echoed": event,
        "greeting": os.environ.get("GREETING", "unset"),
    }
