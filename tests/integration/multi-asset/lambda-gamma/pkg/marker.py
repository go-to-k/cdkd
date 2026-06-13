# GAMMA asset marker. Distinct content from alpha/beta so the asset hashes (and
# therefore the uploaded S3 objects) differ. The integ asserts THIS marker
# comes back from the gamma Lambda.

MARKER = "cdkd-multi-asset-marker-gamma"
VERSION = "1.0.0"

# --- gamma-specific padding (keeps content distinct from alpha/beta) --------
_PAD = {
    "gamma_1": "two driven jocks help fax my big quiz",
    "gamma_2": "the jay pig fox zebra and my wolves quack",
    "gamma_3": "blowzy red vixens fight for a quick jump",
    "gamma_4": "quick zephyrs blow vexing daft jim",
}
