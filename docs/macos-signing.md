# Consistently signed macOS builds

Use an Apple **Developer ID Application** identity for every installed prune build. Keep the bundle identifier `com.pro.desktop` and the same Apple Developer team. Do not substitute ad-hoc signing (`-`), Apple Development, or a new self-signed certificate on each build.

The signing script refuses to build without exactly one matching valid certificate/private key, embeds only public Supabase configuration, enables hardened runtime, and verifies the resulting app's signature, team and identifier. This is separate from `npm run desktop`, which is still a development workflow.

## 1. Install your identity (one-time, outside this repository)

You need a paid Apple Developer Program membership with permission to create Developer ID certificates.

1. In Keychain Access, use **Certificate Assistant → Request a Certificate From a Certificate Authority** to create a certificate signing request (CSR), saved to disk. The private key stays in your Keychain.
2. In Apple's developer portal, open **Certificates, Identifiers & Profiles**, create a **Developer ID Application** certificate using that CSR, download it, and open the `.cer` file to install it. If importing an existing identity from another Mac instead, import its password-protected `.p12`, including the private key, into your login Keychain.
3. Confirm Keychain Access shows the certificate with its private key under **My Certificates**, and run:

   ```sh
   security find-identity -v -p codesigning
   ```

   You should see `Developer ID Application: Your Name (TEAMID1234)`. Zero valid identities means signing cannot proceed; check certificate expiry, its private key, and Apple intermediate certificates. Do not weaken system trust settings.

Never commit a private key, `.p12`, notarization API key, export password, or Apple account credentials. Do not paste them into chat. Back up the identity securely for future releases.

## 2. Build and install the signed app

In your terminal, set the **exact** certificate name printed above and your public project configuration:

```sh
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID1234)'
export PRO_SUPABASE_URL='https://YOUR_PROJECT_REF.supabase.co'
export PRO_SUPABASE_ANON_KEY='YOUR_PUBLIC_PUBLISHABLE_OR_ANON_KEY'
npm run desktop:mac:check
npm run desktop:mac:release
```

No unsigned fallback is permitted. The output is:

```text
src-tauri/target/release/bundle/macos/prune.app
```

Quit **all** running prune instances first (the single-instance handler otherwise forwards launches to the old development process). Copy `prune.app` into `/Applications`, replacing the previous copy, then launch **that app**. Do not keep using `npm run desktop` if you want the installed build's signing identity.

Use the same signing identity/team for subsequent builds and replace the installed app only after quitting it. Renew an expiring certificate through the same team; verify Keychain behavior across renewal before distributing an update.

## 3. Notarize before distributing

Store notarization credentials in Keychain, interactively, using Apple's tool:

```sh
xcrun notarytool store-credentials 'PRO-notary'
```

Follow its prompts for your Apple ID, **app-specific password**, and team ID. Keep these out of shell scripts, repository files, and chat. Then build:

```sh
export PRO_NOTARY_PROFILE='PRO-notary'
npm run desktop:mac:release
```

The script submits a temporary ZIP to Apple (this uploads the compiled app), waits for notarization, staples and validates the ticket, and checks Gatekeeper acceptance. Failed signing, notarization or verification stops the command; do not distribute an artifact from a failed run. The temporary ZIP is removed automatically. Without `PRO_NOTARY_PROFILE`, the command produces a signed app but explicitly reports that it is **not notarized**.

## 4. Verify the Keychain transition

An existing login item created by an unsigned build may still prompt during the first signed launch. When macOS names the expected prune app, you can choose **Always Allow** to trust it. Do not grant all applications access, disable Keychain locking, or delete the saved login just to suppress a prompt.

Test first launch, quit/relaunch, token refresh, reboot, and replacement with a second build signed by the same team. A locked Keychain, previously denied permissions, certificate changes, or existing item access rules can still require interaction. Signing makes the app's identity stable; it does not override macOS access controls or guarantee zero prompts.

The build checks do not test real Keychain permission dialogs. A real signed-build smoke test is required.
