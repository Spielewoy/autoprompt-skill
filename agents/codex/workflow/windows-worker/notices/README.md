# Windows worker sources and notices

Original notices and exact byte ranges are recorded in SOURCE-PROVENANCE.json. Corresponding source archives, patches and build recipes are split into hash-bound parts at commit 7553f7a17ba0ad55688e4e0a3e35b227da71174d. Download the complete commit-pinned release-source tree below. From the checkout root, run this command; reassembled-sources must not already exist:

    node release-source/archive-parts.cjs reassemble release-source/trusted-pins.json release-source/parts d7fc41ff5e7c7ad5e413aabfc85ff111794cd37f322bacf4f1b6101e34861d36 ./reassembled-sources

The independent archive pins file release-source/trusted-pins.json has SHA256 0a175f9c1ba160a69adbef7eff4f7d26695b16fb57d61cb6ce51b125cf996acc. The supplied index SHA256 and both archive hashes must match SOURCE-PROVENANCE.json; do not replace them with values learned only from a downloaded index.

Source tree: https://github.com/Spielewoy/autoprompt-skill/tree/7553f7a17ba0ad55688e4e0a3e35b227da71174d/release-source

The bundled Node and MSYS adaptations and their modification date are recorded in SOURCE-PROVENANCE.json. This document makes no runtime acceptance claim; each process must pass its local native canary.
