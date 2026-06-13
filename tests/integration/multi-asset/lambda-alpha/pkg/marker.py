# ALPHA asset marker. Lives in a sub-package (plus padding below) so the alpha
# directory is a genuine multi-file ZIP with content DISTINCT from beta/gamma
# (distinct content -> distinct content-addressed asset hash -> distinct S3
# object). The integ asserts THIS marker comes back from the alpha Lambda; a
# cross-wired asset would return a different marker.

MARKER = "cdkd-multi-asset-marker-alpha"
VERSION = "1.0.0"

# --- alpha-specific padding (keeps content distinct from beta/gamma) --------
_PAD = {
    "alpha_1": "the quick brown fox jumps over the lazy dog",
    "alpha_2": "pack my box with five dozen liquor jugs",
    "alpha_3": "how vexingly quick daft zebras jump",
    "alpha_4": "sphinx of black quartz judge my vow",
}
