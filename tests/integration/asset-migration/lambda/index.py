import os


def handler(event, context):
    return {
        "statusCode": 200,
        "body": "asset-migration integ",
        "dataAssetUrl": os.environ.get("DATA_ASSET_URL", ""),
    }
