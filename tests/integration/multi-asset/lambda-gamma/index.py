from pkg.marker import MARKER, VERSION


def handler(event, context):
    """
    GAMMA zip-asset Lambda handler. Returns its OWN distinct marker, proving the
    gamma asset ZIP is the running code for THIS function and was not
    cross-wired to alpha/beta.
    """
    return {
        "marker": MARKER,
        "version": VERSION,
        "event": event,
    }
