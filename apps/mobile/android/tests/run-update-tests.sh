#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
javac -d "$tmp" "$base/app/src/main/java/com/stonezhang/liveui/UpdatePolicy.java" "$base/tests/UpdatePolicyTest.java"
java -cp "$tmp" com.stonezhang.liveui.UpdatePolicyTest
