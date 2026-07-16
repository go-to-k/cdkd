# Handler for the gc-custom-asset-names integ fixture. Importing a sibling
# module makes the deployed package provably the multi-file ZIP asset cdkd
# published to the CUSTOM asset bucket (an inline stub could not import it).
from helper import MARKER


def handler(event, context):
    return {"marker": MARKER, "source": "gc-custom-asset-names"}
