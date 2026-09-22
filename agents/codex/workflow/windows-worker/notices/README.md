# Windows worker sources and notices

Original notices and exact byte ranges are recorded in SOURCE-PROVENANCE.json. Corresponding source archives, patches and build recipes are split into hash-bound parts at commit 984c2ca002ccaabcc26178495a9709f4fe02c9e9. Download the complete commit-pinned release-source tree below. From the checkout root, run this command; reassembled-sources must not already exist:

    node release-source/archive-parts.cjs reassemble release-source/trusted-pins.json release-source/parts 69a8033c3de5ec4a821ac7ced0e690f5779da47cda589dabf91263aa27270cfa ./reassembled-sources

The independent archive pins file release-source/trusted-pins.json has SHA256 1f52fed605e65b86c54e165dbdaeb9bd896170b993ad0f3af1fd331a2d4bbf31. The supplied index SHA256 and both archive hashes must match SOURCE-PROVENANCE.json; do not replace them with values learned only from a downloaded index.

Source tree: https://github.com/Spielewoy/autoprompt-skill/tree/984c2ca002ccaabcc26178495a9709f4fe02c9e9/release-source

The bundled Node and MSYS adaptations and their modification date are recorded in SOURCE-PROVENANCE.json. This document makes no runtime acceptance claim; each process must pass its local native canary.
