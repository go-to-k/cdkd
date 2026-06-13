# Marker constants imported by the handler. Having a separate module (plus
# the padding lines below) keeps the asset directory comfortably above the
# few-hundred-byte size that would let CDK / cdkd treat the code as trivial,
# forcing a genuine multi-file ZIP upload to the bootstrap asset bucket.

MARKER = "cdkd-s3-asset-deploy-marker-v1"
VERSION = "1.0.0"

# --- padding to keep the asset a real, non-trivial directory tree ----------
# (Intentionally inert constants; they make the ZIP a few KB so the upload
# path is unmistakably exercised rather than a near-empty single file.)
_PAD = {
    "alpha": "the quick brown fox jumps over the lazy dog",
    "beta": "pack my box with five dozen liquor jugs",
    "gamma": "how vexingly quick daft zebras jump",
    "delta": "sphinx of black quartz judge my vow",
    "epsilon": "the five boxing wizards jump quickly",
    "zeta": "jackdaws love my big sphinx of quartz",
    "eta": "waltz bad nymph for quick jigs vex",
    "theta": "glib jocks quiz nymph to vex dwarf",
}
