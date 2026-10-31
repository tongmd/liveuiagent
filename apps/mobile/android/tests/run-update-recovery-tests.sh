#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] && [ -f "$sdk/platforms/android-35/android.jar" ] || { echo 'Set ANDROID_HOME to an SDK with android-35.' >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/stubs/com/stonezhang/liveui" "$tmp/classes"
# Only activity type references are stubbed; the state transition under test is production AppUpdater.
printf '%s\n' 'package com.stonezhang.liveui; class MainActivity extends android.app.Activity {}' > "$tmp/stubs/com/stonezhang/liveui/MainActivity.java"
printf '%s\n' 'package com.stonezhang.liveui; class LocalAssistantActivity { static boolean isUpdateBlocked() { return false; } }' > "$tmp/stubs/com/stonezhang/liveui/LocalAssistantActivity.java"
javac -cp "$sdk/platforms/android-35/android.jar" -d "$tmp/classes" "$tmp/stubs/com/stonezhang/liveui/"*.java \
 "$base/app/src/main/java/com/stonezhang/liveui/AppUpdater.java" \
 "$base/app/src/main/java/com/stonezhang/liveui/UpdatePolicy.java" \
 "$base/app/src/main/java/com/stonezhang/liveui/UpdateRelease.java" \
 "$base/app/src/main/java/com/stonezhang/liveui/UpdateJobService.java" \
 "$base/app/src/main/java/com/stonezhang/liveui/UpdateInstallReceiver.java" \
 "$base/tests/UpdateRecoveryTest.java"
java -cp "$tmp/classes:$sdk/platforms/android-35/android.jar" com.stonezhang.liveui.UpdateRecoveryTest
