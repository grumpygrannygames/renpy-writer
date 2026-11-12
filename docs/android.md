# The Android app

The same app as the web version, running entirely on the phone: scripts,
notes and outline are kept on the phone, everything works without a
connection, and Save and send syncs with the project's repository exactly as
the desktop does.

## What it does differently

- **Projects are copied, not opened.** There is no folder of games on a phone,
  so a project is added from its repository address (GitLab or GitHub) and an
  access token. It must already be a Ren'Py Writer project: open the game once
  on a computer, then Save and send, so the `.renpywriter` folder is in the
  repository.
- **No artwork.** Only the scripts (`*.rpy`), the `.renpywriter` folder and
  `.gitignore` files are copied. Pictures are never downloaded, and are kept
  untouched in every commit sent from the phone. A 3.8 GB game copies as a few
  megabytes.
- **Like the web version, no picture previews, render syncing or
  translation/proofreading passes.**

## The token

For a private repository the app needs a token that can read and write it:

- GitLab: *Preferences → Access tokens*, scope `write_repository`.
- GitHub: *Settings → Developer settings → Fine-grained tokens*, with
  *Contents: read and write* on the repository.

It is stored with the copy of the project on the phone (in its git settings,
in the app's private storage) and nowhere else.

## Building it

Needs Node, Python 3, Java 21 (Eclipse Temurin) and the Android SDK
(command-line tools, `platforms/android-36`, `build-tools/36.1.0`).

```
npm run android
```

The first run fetches git built for Android from the Termux project
(`scripts/android-git.py`, every file checked against Termux's published
hashes). The result is `android/app/build/outputs/apk/debug/app-debug.apk`.
Copy it to the phone and open it to install (Android asks to allow installing
from that source once).

## How it works

The interface is the same React app. The operations that run in Node on the
desktop and the server run in the phone's WebView instead, with the few Node
modules they use answered by a small Java plugin
(`android/app/src/main/java/.../RwHostPlugin.java`): reading and writing files,
and running git. git is real git, so syncing, merging and conflicts behave
exactly as on the desktop.

`npm run test:android` runs the phone code on a computer, with the Java plugin
played by Node.
