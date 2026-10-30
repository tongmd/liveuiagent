#!/bin/sh
set -eu
policy_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
policy_out=$(mktemp -d)
trap 'rm -rf "$policy_out"' EXIT HUP INT TERM
policy_javac=javac
policy_java=java
if [ -n "${JAVA_HOME:-}" ]; then
    policy_javac="$JAVA_HOME/bin/javac"
    policy_java="$JAVA_HOME/bin/java"
fi
"$policy_javac" -d "$policy_out" \
    "$policy_root/app/src/main/java/com/stonezhang/liveui/ConnectionPolicy.java" \
    "$policy_root/app/src/main/java/com/stonezhang/liveui/AuthBootstrap.java" \
    "$policy_root/tests/ConnectionPolicyTest.java"
"$policy_java" -cp "$policy_out" com.stonezhang.liveui.ConnectionPolicyTest
