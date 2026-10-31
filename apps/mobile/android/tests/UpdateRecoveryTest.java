package com.stonezhang.liveui;

import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;

/** Runs the real recovery transition against an in-memory SharedPreferences implementation. */
public final class UpdateRecoveryTest {
    private static int checks;
    private static void require(boolean value) { if (!value) throw new AssertionError(); checks++; }
    private static SharedPreferences preferences(Map<String,Object> data) {
        SharedPreferences.Editor editor = (SharedPreferences.Editor)Proxy.newProxyInstance(UpdateRecoveryTest.class.getClassLoader(), new Class[]{SharedPreferences.Editor.class}, (proxy, method, args) -> {
            if (method.getName().equals("putString")) { data.put((String)args[0], args[1]); return proxy; }
            if (method.getName().equals("apply")) return null;
            throw new UnsupportedOperationException(method.getName());
        });
        return (SharedPreferences)Proxy.newProxyInstance(UpdateRecoveryTest.class.getClassLoader(), new Class[]{SharedPreferences.class}, (proxy, method, args) -> {
            if (method.getName().equals("edit")) return editor;
            if (method.getName().equals("getString") || method.getName().equals("getInt")) return data.getOrDefault(args[0], args[1]);
            throw new UnsupportedOperationException(method.getName());
        });
    }
    public static void main(String[] args) {
        Map<String,Object> data = new HashMap<>(); SharedPreferences p = preferences(data);
        data.put("session_id", 41); data.put("session_token", "session-token");
        for (String state : new String[]{"confirmation_required", "installed", "failed", "deferred"}) {
            data.put("install_status", state);
            require(!AppUpdater.recoverInterruptedState(p, 41, "session-token", "committed"));
            require(state.equals(data.get("install_status")));
            require(!AppUpdater.recoverInterruptedState(p, 41, "session-token", "failed"));
            require(state.equals(data.get("install_status")));
        }
        data.put("install_status", "preparing");
        require(!AppUpdater.recoverInterruptedState(p, 42, "session-token", "committed"));
        require(!AppUpdater.recoverInterruptedState(p, 41, "other-token", "committed"));
        require("preparing".equals(data.get("install_status")));
        require(AppUpdater.recoverInterruptedState(p, 41, "session-token", "committed"));
        require("committed".equals(data.get("install_status")));
        require(AppUpdater.recoverInterruptedState(p, 41, "session-token", "failed"));
        require("failed".equals(data.get("install_status")));
        data.put("install_status", "preparing"); data.remove("session_token");
        require(!AppUpdater.recoverInterruptedState(p, 41, "session-token", "committed"));
        System.out.println(checks + " interrupted-install state checks passed");
    }
}
