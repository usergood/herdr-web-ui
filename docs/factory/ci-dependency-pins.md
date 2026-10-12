# Immutable CI action and Windows prerequisite pins

Research date: 2026-10-11. Read-only official GitHub APIs and exact source blobs; no workflow activation, source edits, repository rename, installations, tags, or publication. Temporary source downloads only.

## GitHub Actions

The official `git/ref/tags/<major>` APIs resolved every requested major tag directly to an object of type `commit`, so no annotated-tag peeling was necessary. Use the complete 40-character SHA and retain the human-readable major version in a YAML comment. These are the current tag targets at audit time; a full SHA prevents later tag movement from changing executed code.

| Action | Current tag | Immutable commit | Official evidence |
| --- | --- | --- | --- |
| `actions/checkout` | `v7` | `3d3c42e5aac5ba805825da76410c181273ba90b1` | [tag API](https://api.github.com/repos/actions/checkout/git/ref/tags/v7), [immutable source](https://github.com/actions/checkout/tree/3d3c42e5aac5ba805825da76410c181273ba90b1) |
| `actions/setup-node` | `v7` | `949feb2413d6458794dcd2491c4babbbce0c15c1` | [tag API](https://api.github.com/repos/actions/setup-node/git/ref/tags/v7), [immutable source](https://github.com/actions/setup-node/tree/949feb2413d6458794dcd2491c4babbbce0c15c1) |
| `actions/cache` | `v4` | `0057852bfaa89a56745cba8c7296529d2fc39830` | [tag API](https://api.github.com/repos/actions/cache/git/ref/tags/v4), [immutable source](https://github.com/actions/cache/tree/0057852bfaa89a56745cba8c7296529d2fc39830) |
| `actions/upload-artifact` | `v7` | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` | [tag API](https://api.github.com/repos/actions/upload-artifact/git/ref/tags/v7), [immutable source](https://github.com/actions/upload-artifact/tree/cf430e030ddbb5b0abf93d22962f4752f3646cd9) |
| `actions/download-artifact` | `v8` | `9000827ccba6bdab643e8b6fd33ac0654aef8333` | [tag API](https://api.github.com/repos/actions/download-artifact/git/ref/tags/v8), [immutable source](https://github.com/actions/download-artifact/tree/9000827ccba6bdab643e8b6fd33ac0654aef8333) |
| `actions/upload-pages-artifact` | `v5` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | [tag API](https://api.github.com/repos/actions/upload-pages-artifact/git/ref/tags/v5), [immutable source](https://github.com/actions/upload-pages-artifact/tree/fc324d3547104276b827a68afc52ff2a11cc49c9) |
| `actions/deploy-pages` | `v5` | `368f82528645a54fb793d4d04e342629a3f51346` | [tag API](https://api.github.com/repos/actions/deploy-pages/git/ref/tags/v5), [immutable source](https://github.com/actions/deploy-pages/tree/368f82528645a54fb793d4d04e342629a3f51346) |
| `oven-sh/setup-bun` | `v2` | `0c5077e51419868618aeaa5fe8019c62421857d6` | [tag API](https://api.github.com/repos/oven-sh/setup-bun/git/ref/tags/v2), [immutable source](https://github.com/oven-sh/setup-bun/tree/0c5077e51419868618aeaa5fe8019c62421857d6) |

Example:

```yaml
uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7
```

Action-source pins do not by themselves pin tools downloaded by an action. Continue specifying explicit Bun and Node versions and retain frozen package installs. Runtime artifact pinning and network policy remain separate from the action commit.

## Herdr Windows installation

Official stable `v0.9.3` is annotated, resolving to commit `7b116c05bfda646af39d2524c54e70c751f57ee8`. The pinned PowerShell installer accepts `-Channel`, `-ManifestUrl`, `-InstallDir`, `-ExpectedBuildId`, `-Retain`, and the four local-package arguments. It does **not** accept a `-Version` parameter. [Exact argument list](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1#L1)

| Resource | Immutable/source or release URL | Reviewed SHA-256 |
| --- | --- | --- |
| Herdr installer script | https://raw.githubusercontent.com/herdrdev/herdr/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1 | `369e0d2b5a5f976e11b512f3c4b610a2eba6119732b292a2f587ca8f80fe0baf` |
| Herdr Windows x64 archive | https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-windows-x86_64.zip | `c75b1fa49f7a3ba4b8b11789912a6147e4214a3b6fd3556d0f80076c8887d795` |

Installer script hash was computed from the exact release source and independently downloaded raw URL; both matched. Archive digest comes from the official GitHub release asset metadata `digest` field. The archive was not installed or run during research. [Official release metadata](https://api.github.com/repos/herdrdev/herdr/releases/tags/v0.9.3)

The smallest change that preserves Herdr's managed Windows installation layout, persistent user PATH, installation locking/rollback, and bundled ConPTY is:

1. Download the pinned script and exact release archive to a private temporary directory.
2. Check both files' SHA-256 against the reviewed constants before executing or extracting either.
3. Invoke the pinned script with `-Channel stable -LocalPackagePath <downloaded zip> -LocalPackageFormat zip -LocalPackageIdentity 0.9.3 -LocalPackageSha256 c75b…d795`.
4. Clean up the download directory and retain ordinary exit-code/version checks.

All four local-package parameters are required together. Local-package mode bypasses live `latest.json` and `preview.json` discovery and checks the archive again before extraction. The official installer then checks ConPTY completeness and executes the verified staged `herdr.exe --version`. Explicit `-Channel stable` avoids interpreting an existing executable or environment setting to choose a channel. [Local-package validation](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1#L24), [live-manifest bypass](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1#L755), [hash/extract/ConPTY checks](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/distribution/install.ps1#L830)

This can replace both our root `install.ps1` unpinned `herdr.dev/install.cmd` path and the remote-bundle smoke workflow's same command. A small repository-owned helper shared by those two callers prevents checksum/behavior drift. For the smoke job alone, direct archive verification/extraction into its temporary PATH is even smaller, but sharing the official managed install path also exercises the real installer behavior.

## Bun Windows installation

Official `bun-v1.4.2` resolves to commit `744846f844374847c902b5e7fd59b4342a51ef99`. Its installer supports `-Version 1.4.2`, `-ForceBaseline`, `-NoPathUpdate`, `-NoRegisterInstallation`, `-NoCompletions`, and `-DownloadWithoutCurl`. It selects architecture from Windows registry and uses `BUN_INSTALL` or the user's `.bun` directory. [Exact installer parameters](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1#L1), [target and URL selection](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1#L94)

| Resource | Source/release URL | Reviewed SHA-256 |
| --- | --- | --- |
| Bun installer script | https://raw.githubusercontent.com/oven-sh/bun/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1 | `b293e028d51c5728efcceb401e2552c170497b8f18bdb381a88c55169c41cc6f` |
| Bun Windows x64 archive | https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64.zip | `ce4c17497b2f29712a99d3d53f028de28cd42e3bacb8589599e7f000e49b6405` |
| Bun Windows x64 baseline archive | https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-windows-x64-baseline.zip | `78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6` |
| Bun release SHA sums file | https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/SHASUMS256.txt | `99ebf3e6afe003b57eae3f257abce7e9aa851452429e84ef16b1b401e9d7cff1` |

Script hash was calculated from exact source and separately downloaded immutable raw URL, matching both times. Release asset hashes are from official asset metadata. The normal x64 archive digest already matches `WINDOWS_BUN_SHA` in our bundle builder. [Official Bun release metadata](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.2), [existing repository bundle pin](https://github.com/usergood/herdr-web-ui/blob/c7cdd569b431757a58f771a0369bce1b46c5f291/scripts/build-remote-bundle.ts#L43)

**Pinning and hashing Bun's installer script alone does not verify its executable archive:** this official installer downloads and extracts the ZIP without an archive checksum guard and has no local-package/hash argument. It subsequently executes Bun to check its revision and install completions. Therefore the smallest robust replacement for our installer is a repository-owned checksum-verified ZIP installation: download the exact normal or baseline ZIP, verify before extraction, stage `bun.exe`, verify its version, then publish to the user's Bun bin directory and set current/persistent user PATH. [Download/extract path without SHA guard](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1#L149), [first binary execution](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1#L202), [completion side effects](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/runtime/cli/install.ps1#L242)

Our root installer supports Windows AMD64 only, so no ARM64 pin is required for this task. The official installer chooses the baseline target for an x64 CPU without AVX2 (or with `-ForceBaseline`). Preserve that choice if supporting those machines, or deliberately use the baseline archive for all x64 installs to simplify selection while retaining the broader CPU floor. Do not use one target's checksum for the other ZIP. Native Windows verification is still required for PATH behavior, running-executable replacement, and extraction; research on Linux does not certify those behaviors.

## Relevant temporary sources

## Unix prerequisite pins

The official release asset APIs returned the following SHA-256 digests. Herdr's four binary values match `scripts/build-remote-bundle.ts`. [Herdr metadata](https://api.github.com/repos/herdrdev/herdr/releases/tags/v0.9.3), [Bun metadata](https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.2)

| Installer platform | Herdr v0.9.3 filename | SHA-256 |
| --- | --- | --- |
| `linux-x64` | `herdr-linux-x86_64` | `18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7` |
| `linux-arm64` | `herdr-linux-aarch64` | `4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0` |
| `darwin-x64` | `herdr-macos-x86_64` | `db62d548ff3e832b087a96b1894a08d26be3905f1830309cd556783f215d4054` |
| `darwin-arm64` | `herdr-macos-aarch64` | `5173a3e0ae42d5d1ab7ebfa5d5e6329f7c3d23f8e1a3677c7ce3231da2884157` |

Herdr base URL: `https://github.com/herdrdev/herdr/releases/download/v0.9.3/`.

| Installer platform | Bun v1.4.2 filename | SHA-256 |
| --- | --- | --- |
| `linux-x64` | `bun-linux-x64-baseline.zip` | `c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f` |
| `linux-arm64` | `bun-linux-aarch64.zip` | `54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7` |
| `darwin-x64` | `bun-darwin-x64-baseline.zip` | `bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0` |
| `darwin-arm64` | `bun-darwin-aarch64.zip` | `90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f` |

Bun base URL: `https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/`. Both macOS and Linux x64 baseline archives exist in that release. A normal macOS x64 archive is also available (`bun-darwin-x64.zip`, SHA-256 `80520d7e17526308c9185d261679ac6d27798d3803a0e9f7ff9121ab8affb012`), matching the existing remote-bundle builder; the baseline selection above deliberately supports the wider CPU floor.

Smallest direct install for the existing shell script: download each resource into an owned temporary directory, verify its digest with the existing `sha256` helper before running or extracting anything, chmod/move the verified Herdr binary into `$HOME/.local/bin/herdr`, unzip the verified Bun archive, then move its `<archive-basename>/bun` into `$HOME/.bun/bin/bun`. Keep the current `.local/bin/bun` symlink and in-process PATH handling. A `bunx` symlink to `bun` is sufficient for that alias without executing a remotely fetched completion script. Stage files before replacing an existing executable; clean up on errors.

The old-Bun `bun upgrade` branch also selects an unpinned latest runtime, so reuse the same reviewed install function for missing and too-old Bun. Existing sufficiently recent prerequisites can remain in place. The script already explains when the owner must add `.local/bin` to their shell PATH, so no new startup-file mutation is needed. macOS architecture/version/code-signing behavior and Linux libc/CPU compatibility still need appropriate native tests; research does not certify them.

- `/tmp/saurons-herdr-093-source/distribution/install.ps1`
- `/tmp/saurons-herdr-093-raw-install.ps1`
- `/tmp/saurons-bun-142-install.ps1`
- `/tmp/saurons-bun-142-raw-install.ps1`

No source, secret, token, or GitHub setting was modified.

