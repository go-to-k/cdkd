from pkg.marker import MARKER, VERSION


def handler(event, context):
    """
    BETA zip-asset Lambda handler. Returns its OWN distinct marker, proving the
    beta asset ZIP is the running code for THIS function and was not cross-wired
    to alpha/gamma.
    """
    return {
        "marker": MARKER,
        "version": VERSION,
        "event": event,
    }
