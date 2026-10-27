#!/usr/bin/env bash
# Generates the standard Flutter platform scaffolding (Gradle wrapper, Xcode project, icons)
# around the code in this repo, then applies the few platform settings the app needs.
# Safe to re-run: `flutter create` never overwrites files that already exist.
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 not found"; exit 1; }; }
need flutter

ver=$(flutter --version --machine 2>/dev/null | sed -n 's/.*"frameworkVersion": *"\([0-9.]*\)".*/\1/p')
major=$(echo "$ver" | cut -d. -f1); minor=$(echo "$ver" | cut -d. -f2)
if [ -z "$ver" ] || [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 44 ]; }; then
  echo "error: Flutter >= 3.44 required (found ${ver:-unknown}). iOS needs Swift Package Manager for HaishinKit."
  exit 1
fi
echo "Flutter $ver"

flutter create --org com.cogolfers --project-name cogolfer_live --platforms android,ios \
  --description "Go Live: multi-camera live broadcasts from phones" . >/dev/null
echo "✓ platform scaffolding generated (existing files kept)"

# ---------------------------------------------------------------- iOS
PLIST=ios/Runner/Info.plist
if [ -f "$PLIST" ] && [ "$(uname)" = "Darwin" ]; then
  pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" 2>/dev/null || true; }
  set_string() {
    /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 string $2" "$PLIST"
  }
  set_string CFBundleDisplayName "Go Live"
  set_string NSCameraUsageDescription "Go Live streams this camera to the event control room when you tap Go Live, and scans the organiser's QR code."
  set_string NSMicrophoneUsageDescription "Go Live sends event audio with the camera feed, and your voice when you commentate."
  # Status bar hidden on the full-screen camera.
  pb "Add :UIStatusBarHidden bool false"
  pb "Add :UIViewControllerBasedStatusBarAppearance bool true"
  echo "✓ iOS camera/microphone usage descriptions set"
elif [ -f "$PLIST" ]; then
  echo "! Not on macOS: add NSCameraUsageDescription and NSMicrophoneUsageDescription to $PLIST manually (see docs/MOBILE.md)."
fi

# iOS 15 minimum (HaishinKit). New Flutter templates already use 15.0; enforce for older projects.
PBX=ios/Runner.xcodeproj/project.pbxproj
if [ -f "$PBX" ]; then
  sed -i.bak -E 's/IPHONEOS_DEPLOYMENT_TARGET = 1[0-4]\.[0-9]+;/IPHONEOS_DEPLOYMENT_TARGET = 15.0;/g' "$PBX" && rm -f "$PBX.bak"
fi

flutter config --enable-swift-package-manager >/dev/null 2>&1 || true

# ---------------------------------------------------------------- Android
# App name under the icon. The package id (com.cogolfers.cogolfer_live) stays the same so
# installed apps keep updating.
MANIFEST=android/app/src/main/AndroidManifest.xml
if [ -f "$MANIFEST" ]; then
  sed -i.bak -E 's/android:label="[^"]*"/android:label="Go Live"/' "$MANIFEST" && rm -f "$MANIFEST.bak"
  echo "✓ Android app name set to Go Live"
fi
# share_plus 13 needs Android Gradle Plugin >= 8.12.1 and Gradle >= 8.13.
SETTINGS=android/settings.gradle.kts
if [ -f "$SETTINGS" ]; then
  agp=$(sed -n 's/.*id("com.android.application") version "\([0-9.]*\)".*/\1/p' "$SETTINGS")
  if [ -n "$agp" ] && [ "$(printf '%s\n8.12.1\n' "$agp" | sort -V | head -1)" != "8.12.1" ]; then
    sed -i.bak -E 's/(id\("com.android.application"\) version ")[0-9.]+"/\18.12.1"/' "$SETTINGS" && rm -f "$SETTINGS.bak"
    echo "✓ Android Gradle Plugin raised from $agp to 8.12.1 (share_plus)"
  fi
fi
WRAPPER=android/gradle/wrapper/gradle-wrapper.properties
if [ -f "$WRAPPER" ]; then
  gv=$(sed -n 's/.*gradle-\([0-9.]*\)-.*/\1/p' "$WRAPPER")
  if [ -n "$gv" ] && [ "$(printf '%s\n8.13\n' "$gv" | sort -V | head -1)" != "8.13" ]; then
    sed -i.bak -E "s/gradle-[0-9.]+-(all|bin)\.zip/gradle-8.13-\1.zip/" "$WRAPPER" && rm -f "$WRAPPER.bak"
    echo "✓ Gradle wrapper raised from $gv to 8.13"
  fi
fi
# Permissions, the camera foreground service and JitPack are provided by
# packages/cg_streamer (merged manifest) and android/build.gradle.kts (kept from this repo).
flutter pub get
echo
echo "Done. Next:"
echo "  flutter test                      # unit + widget tests"
echo "  flutter run                       # on a connected Android phone or iPhone"
echo "  flutter build apk --release       # Android"
echo "  flutter build ipa                 # iOS (needs your Apple team in Xcode: Runner > Signing)"
