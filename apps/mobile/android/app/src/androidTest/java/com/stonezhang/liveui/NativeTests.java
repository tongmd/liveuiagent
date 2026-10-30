package com.stonezhang.liveui;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import android.util.Base64;

/** Platform-only instrumentation runner, with no runtime or test library dependencies. */
public final class NativeTests extends Instrumentation {
    private interface Check { void run() throws Exception; }
    private int current = 0, failed = 0;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    @Override public void onStart() {
        check("encryptedRoundTripAndLogout", () -> {
            Context c = getTargetContext(); CredentialStore store = new CredentialStore(c, ".test");
            try {
                store.clear(); store.save(ConnectionPolicy.DEFAULT_URL, "test-user", "test-password-unique");
                require("test-user".equals(store.load().getString("user")));
                require("test-password-unique".equals(store.load().getString("password")));
                String encrypted = c.getSharedPreferences("connection.test", 0).getString("data", "");
                require(!new String(Base64.decode(encrypted, Base64.NO_WRAP), java.nio.charset.StandardCharsets.UTF_8).contains("test-password-unique"));
                store.clear(); require(store.load() == null);
            } finally { store.clear(); }
        });
        check("tamperedCredentialRejected", () -> {
            Context c = getTargetContext(); CredentialStore store = new CredentialStore(c, ".test");
            try {
                store.save(ConnectionPolicy.DEFAULT_URL, "test-user", "test-password-unique");
                android.content.SharedPreferences prefs = c.getSharedPreferences("connection.test", 0);
                byte[] data = Base64.decode(prefs.getString("data", ""), Base64.NO_WRAP); data[0] ^= 1;
                prefs.edit().putString("data", Base64.encodeToString(data, Base64.NO_WRAP)).commit();
                boolean rejected = false; try { store.load(); } catch (Exception expected) { rejected = true; }
                require(rejected);
            } finally { store.clear(); }
        });
        check("originAndFiniteAuth", () -> {
            java.net.URI endpoint = ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL);
            require(!ConnectionPolicy.sameOrigin(endpoint, "https://liveui.stonezhang.com:8443/"));
            require(!ConnectionPolicy.sameOrigin(endpoint, "http://liveui.stonezhang.com/"));
            AuthBootstrap gate = new AuthBootstrap(endpoint);
            require(gate.take(endpoint.toString(), endpoint.getHost(), ConnectionPolicy.AUTH_REALM));
            require(!gate.take(endpoint.toString(), endpoint.getHost(), ConnectionPolicy.AUTH_REALM));
        });
        Bundle result = new Bundle(); result.putString("stream", failed == 0 ? "\nOK (3 tests)\n" : "\nFAILURES!!! Tests run: 3, Failures: " + failed + "\n");
        result.putInt("numtests", 3); finish(Activity.RESULT_OK, result);
    }
    private void check(String name, Check task) {
        Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putString("class", getClass().getName()); b.putString("test", name); b.putInt("numtests", 3); b.putInt("current", ++current);
        sendStatus(1, b);
        try { task.run(); sendStatus(0, b); }
        catch (Throwable e) { failed++; b.putString("stack", android.util.Log.getStackTraceString(e)); sendStatus(-2, b); }
    }
    private static void require(boolean condition) { if (!condition) throw new AssertionError("Native boundary check failed"); }
}
