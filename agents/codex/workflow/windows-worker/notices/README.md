# Windows worker sources and notices

Original notices and exact byte ranges are recorded in SOURCE-PROVENANCE.json. Corresponding source archives, patches and build recipes are split into hash-bound parts at commit efeccd5f48ddb4b2fb02f81ed233f276d933a21c. Download the complete commit-pinned release-source tree below. From the checkout root, run this command; reassembled-sources must not already exist:

    node release-source/archive-parts.cjs reassemble release-source/trusted-pins.json release-source/parts d0fe59940da89ada488f61dcee257f3431c9507986378e05ee1e5c6356289f03 ./reassembled-sources

The independent archive pins file release-source/trusted-pins.json has SHA256 3cead21c42da83a59a0ef5e3f9693ccdf76aa5a6015c1059cdfa8848f5ab4d95. The supplied index SHA256 and both archive hashes must match SOURCE-PROVENANCE.json; do not replace them with values learned only from a downloaded index.

Source tree: https://github.com/Spielewoy/autoprompt-skill/tree/efeccd5f48ddb4b2fb02f81ed233f276d933a21c/release-source

The bundled Node and MSYS adaptations and their modification date are recorded in SOURCE-PROVENANCE.json. This document makes no runtime acceptance claim; each process must pass its local native canary.
