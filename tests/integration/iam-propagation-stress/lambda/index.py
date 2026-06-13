import json


def handler(event, context):
    """
    Minimal worker Lambda for the iam-propagation-stress integ.

    Invoked directly by verify.sh AND as the Step Functions state machine's
    only task. Echoes a stable marker so the integ can assert the function
    (running on its brand-new exec role) actually responds.
    """
    return {
        'marker': 'cdkd-iam-propagation-stress-marker-v1',
        'event': event,
    }
