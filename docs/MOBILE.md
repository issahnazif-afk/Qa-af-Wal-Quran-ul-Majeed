# Publishing Qāf as an Android and iOS app

The phone app is this same website, packaged with **Capacitor** (free, open source). The site is
bundled inside the app, so it opens instantly and works offline apart from audio. The one native
addition is speech recognition: phone web views have no Web Speech API, so the app uses the phone's
own recogniser through `@capacitor-community/speech-recognition` (see `src/lib/speech.mjs`).

GitHub Actions builds both apps, so no Android Studio or Mac is needed on your computer.

## What it costs

| Item | Cost |
|---|---|
| Building (GitHub Actions, public repo) | Free |
| Android test APK, shared from GitHub Releases | Free |
| Google Play Console account | US$25, once |
| Apple Developer Program (TestFlight and App Store) | US$99 per year |
| iPhone without the App Store | Free: open the site in Safari → Share → Add to Home Screen |

## 1. Android test build (free, about 10 minutes)

1. Repo → **Actions** → **Android app** → **Run workflow**.
2. When it is green, open the run → **Artifacts** → download **qaaf-android-test-apk**.
3. Copy the `.apk` to an Android phone and open it. Allow "install unknown apps" when asked.
4. Test it: open Recite and allow the microphone when asked.

## 2. Android release for Google Play

1. **Make a signing key, once.** Keep the file and its passwords safe forever: without them you can
   never update the app. On a computer with Java installed:
   `keytool -genkeypair -v -keystore qaaf-release.keystore -alias qaaf -keyalg RSA -keysize 2048 -validity 10000`
2. Turn the key into text: PowerShell
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("qaaf-release.keystore")) | Set-Clipboard`
3. Repo → **Settings → Secrets and variables → Actions**, add:
   `ANDROID_KEYSTORE_B64` (paste), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`qaaf`), `ANDROID_KEY_PASSWORD`.
4. Run **Android app** again. Artifacts now also hold **qaaf-android-release** with the `.aab`.
5. **Google Play Console** (play.google.com/console) → Create app → fill in name, language, free.
   Complete **App content**: privacy policy URL, data safety (microphone used on the device, no data
   collected by you), content rating, target audience.
6. **Testing → Internal testing** → upload the `.aab` → add testers' emails → share the link.
7. When happy: **Production → Create release** → upload the same `.aab` → submit for review.

## 3. iOS

1. Run **Actions → iOS app**. Without Apple secrets it builds for the iOS Simulator only, which
   proves the project compiles.
2. Join the **Apple Developer Program** (developer.apple.com, US$99/year).
3. In the developer site: create the App ID `io.github.issahnazifafk.qaaf`, an **Apple Distribution
   certificate** (export it as `.p12` with a password) and an **App Store provisioning profile** for
   that App ID. Creating the certificate needs a Mac (Keychain Access) or a cloud Mac.
4. Add secrets: `IOS_CERT_P12_B64`, `IOS_CERT_PASSWORD`, `IOS_PROFILE_B64`, `IOS_TEAM_ID`.
5. Run **iOS app** again → artifact **qaaf-ios-ipa**.
6. **App Store Connect** (appstoreconnect.apple.com) → My Apps → New App. Upload the `.ipa` with
   Apple's **Transporter** app (free, Mac) → test with **TestFlight** → submit for App Review.

## 4. Before submitting to either store

- **Privacy policy page:** both stores require one. It can be a page on this site stating that audio
  is processed by the phone's speech service and nothing is stored by the app.
- **Store listing:** icon (`resources/icon.png`), screenshots from a phone, a short description, and
  credits for Tanzil, QUL, KFGQPC fonts, AlQuran.cloud, EveryAyah and the Quranic Arabic Corpus.
- **Version numbers:** push a tag like `v1.0.0` to build that version; each run gets a new build number.
- **Apple review:** Apple rejects apps that are "just a website". This app ships its content inside,
  works offline, and uses native speech recognition, which helps; say so in the review notes.
