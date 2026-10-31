#!/bin/sh
set -eu
device_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
device_out=$(mktemp -d)
trap 'rm -rf "$device_out"' EXIT HUP INT TERM
device_javac="${JAVA_HOME:+$JAVA_HOME/bin/}javac"
device_java="${JAVA_HOME:+$JAVA_HOME/bin/}java"
"$device_javac" -d "$device_out" "$device_root/app/src/main/java/com/stonezhang/liveui/DeviceAccessPolicy.java" "$device_root/tests/DeviceAccessPolicyTest.java"
"$device_java" -cp "$device_out" com.stonezhang.liveui.DeviceAccessPolicyTest
