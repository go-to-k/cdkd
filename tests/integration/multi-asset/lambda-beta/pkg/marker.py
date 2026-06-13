# BETA asset marker. Distinct content from alpha/gamma so the asset hashes (and
# therefore the uploaded S3 objects) differ. The integ asserts THIS marker
# comes back from the beta Lambda.

MARKER = "cdkd-multi-asset-marker-beta"
VERSION = "1.0.0"

# --- beta-specific padding (keeps content distinct from alpha/gamma) --------
_PAD = {
    "beta_1": "the five boxing wizards jump quickly",
    "beta_2": "jackdaws love my big sphinx of quartz",
    "beta_3": "waltz bad nymph for quick jigs vex",
    "beta_4": "glib jocks quiz nymph to vex dwarf",
}
