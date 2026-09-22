'use strict'
module.exports=Object.freeze({
  "schema": 1,
  "state": "candidate-unaccepted",
  "manifest": {
    "length": 1100,
    "sha256": "86ac90884454aa9fbf062aeb6f61b0e1d094e2ad40ad719e26d9b8cb1e12f2d5"
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
      "length": 1484871,
      "sha256": "9135b2c3715659b74b809b9967516dc8575a27c3fa10bcb5d83a931cfa888121",
      "rawLength": 4152765,
      "rawSha256": "ca3f40b48a86159ec6a483e63ab4007e93a0066ff033c358baa6dd9ebc07f100"
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
    "windows-worker-capture.js": "791b2aa7eb09e905c8d9ebfe423f7d6d4dafa076c5324ae5016026d44f36bb7c",
    "windows-worker-decoder.js": "e006e1eec10b6c112dd95f8e2cfb3546622ee0b33bb9412b07b38b51a8104423",
    "windows-worker-loader.js": "ebe0023a453629dcc17c18d6b4a9274f683f8f56e1982314c88668cc73213ecd",
    "windows-worker-pe.js": "d8914396f52767d203374369a1d785fe7b744a57d77f1d13219d1c88b1992845",
    "safe-run-root.js": "b6c8a3027ac48e028f5106a721826443fce7994507144ceb5c2c1142346ae796"
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
  "sourceIdentity": "aa46a22239d93daec8ef2858e685f85dca43c25083247aaa63404687d02dd8f8"
})
