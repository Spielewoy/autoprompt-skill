'use strict'
module.exports=Object.freeze({
  "schema": 1,
  "state": "candidate-unaccepted",
  "manifest": {
    "length": 1100,
    "sha256": "f27934c1046a93bbf558d6bf64f6984cbcee46dc0aa8a60f34acdde7a3e15ade"
  },
  "files": [
    {
      "path": "assets/bash.br",
      "output": "usr/bin/bash.exe",
      "encoding": "br",
      "length": 1416320,
      "sha256": "c8a7e1e2f9037f2016c6b6d1aa0bea6c2a54c42cbb291d2893fb8d97df22c886",
      "rawLength": 2449886,
      "rawSha256": "9b88ee446e1f9ddf67106526068e37e3a983ea1e327d47ca08bb5d1fdbe914c3"
    },
    {
      "path": "assets/msys.br",
      "output": "usr/bin/msys-2.0.dll",
      "encoding": "br",
      "length": 1489117,
      "sha256": "5aa0f9256180b2f4b4b7b2979d410d46963c17a24ac259ae77a06d72a8684661",
      "rawLength": 4154301,
      "rawSha256": "c77dfefbebd27b307cdbd2c61c89f4b44e6fadaa9e7194d941ca0f1e4b3836eb"
    },
    {
      "path": "assets/node-arm64.br",
      "output": "usr/bin/node-arm64.exe",
      "encoding": "br",
      "length": 32018654,
      "sha256": "934b761fadd477175e2b58cab81ec32928d01a93ccdb328ac3191684f87c1a72",
      "rawLength": 96414208,
      "rawSha256": "0fcf7a0ef617acf97017f10a9ffcc611d6725294f8a363bd95f9f4a5c9a5694c"
    },
    {
      "path": "assets/node-x64.br",
      "output": "usr/bin/node-x64.exe",
      "encoding": "br",
      "length": 34327335,
      "sha256": "c3927022944572c89838d5837ed83002da61c429dbeed978f278d23ac1d3b21a",
      "rawLength": 104267776,
      "rawSha256": "723c1ef8a49dcbfa997aa2eaf05852fdb3752d07d0a21ca74946ef2911d082f0"
    }
  ],
  "bootstraps": {
    "x64": {
      "length": 23040,
      "sha256": "261e4348ddd2af2736f32bf017aaad93660bf3e6c79d2f7a88cd4f0b349becae",
      "configLength": 117,
      "configSha256": "38beae50222462e769206cbc1e3f6b3e1c49617b1ac34e268fe116dffba8a44f"
    },
    "arm64": {
      "length": 23040,
      "sha256": "301187e22d3d7bae4c8832fb770a8569f5e88168e8c426ab42043b7595283fcd",
      "configLength": 117,
      "configSha256": "38beae50222462e769206cbc1e3f6b3e1c49617b1ac34e268fe116dffba8a44f"
    }
  },
  "pipeline": {
    "windows-worker-capture.js": "be7a84dc0ab2eb8a7a2f250ac315b628736fcc89eb46d9a331547750a58b146f",
    "windows-worker-decoder.js": "7f05d14735b5281188ee09002c1a0d822fd7e6bc13f2ff631818032f6fba7709",
    "windows-worker-loader.js": "2437d01f180e8e06a8dcd513304f3f6033efdab90db006d0d71e5c987dfcc79a",
    "windows-worker-pe.js": "d8914396f52767d203374369a1d785fe7b744a57d77f1d13219d1c88b1992845",
    "safe-run-root.js": "c0caca2d804cfb85082f145756a6c63dcbb41764d174060caefb8e61d6457986"
  },
  "imports": {
    "assets/bash.br": [
      "kernel32.dll",
      "msys-2.0.dll",
      "user32.dll"
    ],
    "assets/msys.br": [
      "kernel32.dll",
      "ntdll.dll"
    ],
    "assets/node-arm64.br": [
      "advapi32.dll",
      "crypt32.dll",
      "dbghelp.dll",
      "iphlpapi.dll",
      "kernel32.dll",
      "ole32.dll",
      "shell32.dll",
      "user32.dll",
      "userenv.dll",
      "winmm.dll",
      "ws2_32.dll"
    ],
    "assets/node-x64.br": [
      "advapi32.dll",
      "crypt32.dll",
      "dbghelp.dll",
      "iphlpapi.dll",
      "kernel32.dll",
      "ole32.dll",
      "shell32.dll",
      "user32.dll",
      "userenv.dll",
      "winmm.dll",
      "ws2_32.dll"
    ]
  },
  "sharedId": "msys-2.0S5",
  "sourceIdentity": "5cb561d007f5b7edb2d89912c4db5b2280ddd70ec4973f33505dedab66a13b7d"
})
