# Lo-fi Your Life — phone app

The phone page (`mobile.html`) is wrapped as a native app with [Capacitor](https://capacitorjs.com):
the same code runs on the web, on Android and on iPhone.

| Path | Cost | Time | What you get |
| --- | --- | --- | --- |
| **Home-screen web app** | free | now | Open the site on the phone → Share / ⋮ → *Add to Home Screen*. Full screen, own icon. |
| **Android APK** | free | now | Every push to `main` builds one (GitHub → Actions → *Android app* → Artifacts). Install it on any Android phone. |
| **Google Play** | $25 once | ~2–3 weeks | See below. |
| **Apple App Store** | $99 / year | ~1–2 weeks | Needs a Mac (or a cloud Mac). See below. |

## Day to day

```
npm run app:sync      # build the site, copy it into android/ and ios/
npm run app:android   # …and open Android Studio (needs Android Studio installed)
npm run app:ios       # …and open Xcode (Mac only)
node scripts/make-icons.mjs   # redraw icons + splash screens after changing the design
```

`dist-app/` is the site with the phone page as `index.html` (the app always opens `index.html`).
App id: `app.lofiyourlife.hum`, name: *Lo-fi Your Life* — both in `capacitor.config.json`.
Change the id **before** the first store upload; it can never change afterwards.

## Google Play

1. Make a developer account at play.google.com/console ($25, ID check takes a few days).
2. Make an upload key once (keep the file and passwords safe, forever):
   `keytool -genkey -v -keystore upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000`
3. Build a signed bundle: Android Studio → *Build → Generate Signed App Bundle* (`.aab`), or add the key as
   GitHub secrets and a `bundleRelease` step to `.github/workflows/android.yml`.
4. Store listing: icon (`public/icons/icon-512.png`), 2+ phone screenshots, short + full description,
   a **privacy policy URL** (required because the app uses the microphone — a simple page saying
   recordings stay on the phone is enough), content rating, data safety form.
5. New personal accounts must run a **closed test with at least 12 testers for 14 days** before going
   public. Start this as early as possible — it's the slowest part.

## Apple App Store

1. Apple Developer Program ($99/year), at developer.apple.com.
2. A Mac with Xcode: `npm run app:ios`, pick your team under *Signing & Capabilities*, then
   *Product → Archive → Distribute → App Store Connect*. No Mac: a cloud build service
   (Codemagic, or a GitHub Actions `macos` runner) can archive and upload it for you.
3. In App Store Connect: screenshots (6.7" and 6.5" iPhone), description, privacy policy URL,
   privacy questionnaire ("audio data, not collected" if nothing leaves the phone).
4. TestFlight first (testers install it the same day), then *Submit for Review* (usually 1–3 days).

Review tip: Apple rejects apps that feel like "just a website". This one records, works offline,
has its own share sheet for exports and native icons/splash, which is the usual bar.

## Essentia

Essentia (the WASM audio library) only supplies two optional extras: a key read from the raw audio and
a second tempo opinion. `npx vite-node tests/essentia-ab.ts` runs 36 sung takes both ways:
the same key and tempo on all 36 (35/36 correct either way), and about half the time without it.
Dropping it would shrink the app and speed up analysis on phones. Not yet tested: recordings of
**piano/guitar chords**, where the audio key matters more than for singing.
