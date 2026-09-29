# macOS distribution

Reedar can be packaged as a `.app`, a drag-to-Applications DMG, and a ZIP archive. Recipients do not need Bun or the source checkout to run a packaged app. AI reading still requires a supported CLI, its existing login, and model access on the recipient's Mac.

The current configuration produces **ad-hoc-signed, unnotarized preview builds**. These are not Developer ID releases. macOS may block a downloaded preview, and a successful launch on the build machine does not establish Gatekeeper approval on another Mac.

The verified preview scope is **macOS on Apple Silicon with Codex / GPT-5.3-Codex-Spark**. Successful Claude Code reading, Antigravity reading, Intel execution, and installation on another Mac are not verified; Antigravity article submission remains disabled. Include this scope and the signing limitations in every preview's release notes.

## Build locally

Use macOS with Bun and the requirements listed in [Contributing](../CONTRIBUTING.md).

```sh
bun install --frozen-lockfile
bun run check
bun run dist:mac --arm64
bun run checksums
```

The packaging command rebuilds the app, creates the ICNS icon using macOS `sips` and `iconutil`, and invokes electron-builder with publishing disabled.

For development version 0.1.3, Apple Silicon outputs are:

```text
release/
  mac-arm64/Reedar.app
  Reedar-0.1.3-mac-arm64-preview.dmg
  Reedar-0.1.3-mac-arm64-preview.zip
  Reedar-0.1.3-mac-arm64-preview.dmg.blockmap
  Reedar-0.1.3-mac-arm64-preview.zip.blockmap
  latest-mac.yml
  SHA256SUMS.txt
```

The DMG includes an Applications shortcut. The ZIP contains the same application bundle. After installation, the app stores its library under `~/Library/Application Support/Reedar/`; it does not store articles inside the application bundle.

Use `bun run dist:mac --x64` to request an Intel build or `bun run dist:mac --universal` for a single DMG/ZIP containing both architectures. Intel execution is not currently validated. Without an architecture flag, electron-builder uses the build machine's architecture. Generated bundles and archives are ignored by Git.

To verify downloaded archives, place them beside `SHA256SUMS.txt` and run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Checksums detect accidental changes relative to the supplied manifest; they are not a replacement for trusted code signing.

## Build with GitHub Actions

The [Build macOS preview workflow](../.github/workflows/build-macos.yml) runs only through `workflow_dispatch`:

1. Put the repository on GitHub and enable Actions.
2. Open **Actions → Build macOS preview → Run workflow**.
3. Choose `arm64`, `x64`, or `universal` and the source ref. Leave `sign_and_notarize` off for an ad-hoc preview; enable it only after configuring the signing secrets below.
4. Download the artifact containing the DMG, ZIP, block maps, update metadata, and checksum manifest.

The workflow pins action revisions, runs the automated checks, and packages on a macOS runner. Pushing a `v*` tag additionally publishes a prerelease on GitHub with the DMG, ZIP, block maps, `latest-mac.yml`, and checksum manifest attached. Workflow artifacts expire after 14 days; Release assets are the intended download location.

For a manual release instead, create a GitHub Release from the intended source tag and attach the same files. Describe the architecture, source commit, signing status, and known agent limitations in the release notes.

The public repository is [YunosukeYoshino/reedar](https://github.com/YunosukeYoshino/reedar). The [v0.1.2 prerelease](https://github.com/YunosukeYoshino/reedar/releases/tag/v0.1.2) contains the first downloadable preview. See [GitHub Actions](https://github.com/YunosukeYoshino/reedar/actions) for current hosted checks and packaging runs. Release notes identify which build produced the attached archives.

## Developer ID releases

For a normal publicly distributed macOS release, prepare a **Developer ID Application** certificate and Apple notarization credentials. An Apple Development certificate is not a substitute for this distribution identity.

The default `electron-builder.json` deliberately uses an ad-hoc identity and `-preview` artifact names. The optional `electron-builder.signed.cjs` profile removes that override, requires signing, enables Hardened Runtime with the entitlements in `build/entitlements.mac.plist` (the standard Electron JIT / unsigned-executable-memory set; the app is not sandboxed, so spawning agent CLIs stays possible), requests notarization, and drops the `-preview` marker from artifact names. Build it with `bun run dist:mac:signed --arm64` (or `--universal`). Signing must fail if the required identity is unavailable.

For the workflow’s `sign_and_notarize` option, configure these repository secrets:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate, including its private key |
| `MAC_CSC_KEY_PASSWORD` | Password protecting the certificate export |
| `APPLE_ID` | Apple developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization |
| `APPLE_TEAM_ID` | Apple developer team ID |

The workflow maps the certificate secrets to electron-builder’s `CSC_LINK` / `CSC_KEY_PASSWORD`; the local command can use those environment variables or a certificate already in the keychain. Local notarization uses the same `APPLE_*` variables. No credentials are bundled in the app. Before a Developer ID release:

- Select the Developer ID Application signing identity and require successful code signing.
- Enable Hardened Runtime and the Electron entitlements required by the selected runtime version. The signed profile already applies `build/entitlements.mac.plist`.
- Enable notarization and supply credentials through a secure environment or keychain profile.
- Verify the resulting signature, notarization/stapling, and Gatekeeper assessment, then test the downloaded app on another Mac. The workflow's signed path runs `codesign --verify` and `xcrun stapler validate` after packaging.
- Signed builds already use release artifact names; keep `-preview` names only on ad-hoc output.

Do not store certificates, passwords, or API keys in the repository or upload them as build artifacts. Refer to the [electron-builder macOS guide](https://www.electron.build/docs/mac/) for the current signing and notarization options. The signed pipeline and automatic updater are implemented, but a successful signed/notarized build and live app replacement remain unverified.

## App update delivery

The packaged `app-update.yml` points to the public GitHub repository; the release’s `latest-mac.yml` describes package versions, sizes, and SHA-512 hashes. The updater accepts both public releases and prereleases on this preview channel and explicitly disables downgrades. Keep the ZIP target: Squirrel.Mac requires it even when users initially install the DMG.

Publish all files from the matching workflow artifact together. In particular, the ZIP and `latest-mac.yml` are required for signed-app updates, and block maps support differential downloads. Do not mix metadata from one version or architecture with another build. Current distribution is Apple Silicon only; adding simultaneous Intel updates requires publishing metadata that contains both architectures.

The app checks after 30 seconds and every six hours while open, with a manual check in the Reedar menu. Ad-hoc previews use the public release list and offer a download-page link; they never download or execute an installer. Developer ID signed builds download with electron-updater, wait for native Squirrel validation, and offer a restart. A staged update also applies after a normal quit. The existing shutdown path saves the library and stops active reading/import jobs before an explicit update restart.

Version 0.1.2 contains no updater. Its users must install an updater-enabled build manually, and ad-hoc users must manually install the first Developer ID signed build. To validate automatic installation, publish two increasing signed/notarized versions with the same application identity, install the older version on another Mac, verify the new version is detected, and exercise both immediate restart and normal-quit application while preserving a test library. Also test network failure and a rejected signature. Do not disable signature validation to make an ad-hoc preview self-update.

Implementation references: [Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater), [electron-builder auto-update](https://www.electron.build/docs/features/auto-update), and [macOS code signing](https://www.electron.build/docs/features/code-signing/code-signing-mac/). The implementation uses electron-updater 6.8.9; API examples for newer major versions may differ.

## Package contents

The package configuration allows the built `dist/` application and its package manifest. electron-builder also includes production dependencies. It does not include the local library, Git checkout, tests, or CLI login directories. Agent CLIs are discovered on the recipient's machine and are not bundled.

Reedar's MIT license, Electron's license, and Chromium third-party notices are copied to `Reedar.app/Contents/Resources/licenses/`. Production dependency license files remain within `app.asar`. The generated icon's source prompt is recorded in [assets/README.md](../assets/README.md).

The project uses the [MIT License](../LICENSE). Rebuild the archives from the intended release commit before publication so the package contains the current license and metadata.
