const preview = require("./electron-builder.json");

module.exports = {
  ...preview,
  forceCodeSigning: true,
  // Signed builds are the release channel: drop the "-preview" marker from artifact names.
  artifactName: "Reedar-${version}-mac-${arch}.${ext}",
  mac: {
    ...preview.mac,
    // Remove the preview's ad-hoc override so electron-builder selects a Developer ID identity.
    identity: undefined,
    hardenedRuntime: true,
    notarize: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
  },
};
