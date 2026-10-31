#!/usr/bin/env bash
set -euo pipefail
out="${1:-mobile-artifacts}"
mkdir -p "$out"
# Keep the recorder PID in this shell. The emulator action runs script lines separately.
adb shell screenrecord --time-limit 32 /sdcard/ulemi-motion.mp4 &
record_pid=$!
trap 'kill -INT "$record_pid" 2>/dev/null || true' EXIT
sleep 1
adb shell am instrument -w -e motionPreview true com.stonezhang.liveui.test/com.stonezhang.liveui.NativeTests | tee "$out/android-motion-preview.txt"
wait "$record_pid"
trap - EXIT
adb pull /sdcard/ulemi-motion.mp4 "$out/android-motion.mp4"
ffprobe -v error -show_entries format=duration "$out/android-motion.mp4"
for frame in android-motion-1.png android-motion-2.png android-preview-loading.png android-preview-login.png android-preview-guide.png android-preview-local.png; do
  adb exec-out run-as com.stonezhang.liveui cat "files/$frame" > "$out/$frame"
done
grep -F 'MOTION PREVIEW OK' "$out/android-motion-preview.txt"
