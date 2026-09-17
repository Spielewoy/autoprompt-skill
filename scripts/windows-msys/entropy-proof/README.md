# Native entropy observation

This standalone Win32 executable diagnoses the native Node CSPRNG startup refusal observed when Node is launched through the adapted MSYS runtime. It does not depend on MSYS, modify an ACL, enable a capability, generate a runtime admission, or print random bytes. Native Windows execution is still required; source-derived host contracts do not prove native API behavior.

Reuse the exact native MSVC toolchain JSON produced by `descriptor-proof/discover-toolchain.ps1`. Bind its raw SHA-256 independently, then run:

```text
node scripts/windows-msys/entropy-proof/build.cjs REPO TOOLCHAIN_JSON EXPECTED_TOOLCHAIN_SHA256 NEW_OUTPUT
node --test scripts/windows-msys/entropy-proof/parser.test.cjs
```

`NEW_OUTPUT` must not exist. The builder verifies physical compiler/linker/include/lib inputs, the toolchain digest and native architecture. It creates an owned private output directory and compiles with `/MT`, using a minimal explicit compiler environment. Compilation, linking and the direct host observation share a four-minute deadline. Compiler and linker each have a 100-second subprocess bound; the host observation has 15 seconds. Failure preserves logs and never writes a successful manifest. A timed-out compiler is not evidence that all compiler descendants exited; the output directory is retained.

The PE must be a native x64 or ARM64 executable, with system imports only (Kernel32, Advapi32 and API-set names). BCrypt and SystemFunction036 are dynamically resolved from libraries loaded with `LOAD_LIBRARY_SEARCH_SYSTEM32`; the actual module paths are recorded. Compiler, linker, source, builder, toolchain and executable hashes are recorded and rechecked. `manifest.json` contains `schemaVersion`, `purpose`, `architecture`, `sourceSha256`, `buildScriptSha256`, `toolchainSha256`, `compilerSha256`, `linkerSha256`, `executableSha256`, `executable`, `systemImports`, and `hostProof`. This is a diagnostic build manifest, not a release provenance or acceptance statement.

The executable accepts no arguments. Its single ASCII JSON record contains:

- Actual primary token user/package SID, AppContainer flag and integrity RID; a separate actual thread-token observation distinguishes impersonation.
- `IsWow64Process2` results and pointer width.
- BCrypt system-preferred RNG, explicit RNG-provider open/generate/close, and SystemFunction036 results. The latter reports its Boolean result; `rtlError` is only the observed LastError value after first clearing it, not a documented SystemFunction036 error contract.
- Legacy `CryptAcquireContextW(PROV_RSA_FULL, CRYPT_VERIFYCONTEXT | CRYPT_SILENT)`, generation and provider release results. This covers the alternative OpenSSL Windows seed implementation without guessing which branch the compiled Node binary contains.
- Ordered self-process access probes for query-limited, query-information, and query-information plus VM-read; self-thread query-limited and query-information probes. All successful handles close immediately.
- Bounded DACL SDDL from the process and thread pseudo-handles. Failures are recorded; security is never changed.
- Only SYSTEMROOT, WINDIR, PATH, TEMP, TMP, LOCALAPPDATA, OPENSSL_CONF, OPENSSL_MODULES, NODE_OPTIONS, SYSTEMDRIVE, USERPROFILE, HOME, and APPDATA environment values. A value over 2,048 UTF-16 code units is reported as error 234 without its content. No other environment values are enumerated.

All strings use ASCII-escaped UTF-16 code units. The whole record is bounded to 128 KiB. Loader, token, RNG, access and security-query failures are observations, not fabricated successes. The parser checks closed fields, bounded values, exact requested access masks, API result consistency and optionally the exact expected package SID with no thread impersonation. A structurally valid failed RNG result remains a failed RNG result. The differential controller also preserves denied primary-token inspection as an explicit error with null identity fields; it never substitutes the expected SID for missing data. If inspection succeeds, the identity must still match the launched profile. Strict identity proof parsing remains separate. The separately owned differential controller preserves direct-versus-Bash output under authentic job drain; neither this executable nor its parser approves a production runtime.

The source-derived C++ contract compiles the actual serializer and legacy RNG function with explicit API substitutes. It checks escaped output, NTSTATUS formatting, all CryptoAPI failure stages, release behavior and random-buffer erasure. Parser tests cover malformed, missing and contradictory records; these tests run on Node 20 and 24. The native compiler step exercises the complete actual Windows source and headers.
