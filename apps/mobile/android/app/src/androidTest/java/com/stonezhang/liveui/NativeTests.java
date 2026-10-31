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
        check("loginPresentationDoesNotExposeInfrastructure", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            runOnMainSync(() -> {
                try {
                    java.lang.reflect.Method login = MainActivity.class.getDeclaredMethod("showLogin", String.class); login.setAccessible(true); login.invoke(a, new Object[]{null});
                    android.view.View decor = a.getWindow().getDecorView(); String labels = labels(decor);
                    require(labels.contains("登录，开始创造你的应用")); require(labels.contains("加入候补名单"));
                    require(!labels.contains("服务地址") && !labels.contains("连接设置") && !labels.contains("https://"));
                    require(countInputs(decor) == 2);
                } catch (Exception e) { throw new AssertionError(e); }
            });
            runOnMainSync(a::finish);
        });
        check("guideCanSkipAndReplayWithoutCreatingData", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            try {
                runOnMainSync(() -> {
                    try {
                        a.getSharedPreferences("experience", 0).edit().clear().commit();
                        java.lang.reflect.Method show = MainActivity.class.getDeclaredMethod("showGuide"); show.setAccessible(true); show.invoke(a);
                        java.lang.reflect.Field field = MainActivity.class.getDeclaredField("guide"); field.setAccessible(true);
                        android.app.Dialog dialog = (android.app.Dialog) field.get(a); require(dialog.isShowing()); require(labels(dialog.getWindow().getDecorView()).contains("说出你需要什么"));
                        java.lang.reflect.Method finish = MainActivity.class.getDeclaredMethod("finishGuide"); finish.setAccessible(true); finish.invoke(a);
                        require(a.getSharedPreferences("experience", 0).getBoolean("guide_seen_v1", false)); require(!dialog.isShowing());
                        show.invoke(a); dialog = (android.app.Dialog) field.get(a); require(dialog.isShowing()); finish.invoke(a);
                        java.lang.reflect.Field web = MainActivity.class.getDeclaredField("web"); web.setAccessible(true); require(web.get(a) == null);
                    } catch (Exception e) { throw new AssertionError(e); }
                });
            } finally { a.getSharedPreferences("experience", 0).edit().clear().commit(); runOnMainSync(a::finish); }
        });
        check("packagedLiteRtNativeLibraryLoads", () -> {
            com.google.ai.edge.litertlm.Engine.Companion.setNativeMinLogSeverity(com.google.ai.edge.litertlm.LogSeverity.ERROR);
        });
        check("offlineAssistantStartsWithoutAccountOrNetwork", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), LocalAssistantActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                runOnMainSync(() -> {
                    try {
                        String text = labels(a.getWindow().getDecorView());
                        require(text.contains("离线助手") && text.contains("Gemma 4 E4B") && text.contains("官方来源"));
                        require(!text.contains("账号") && !text.contains("密码") && countInputs(a.getWindow().getDecorView()) == 1);
                        java.lang.reflect.Field engine = LocalAssistantActivity.class.getDeclaredField("engine"); engine.setAccessible(true); require(engine.get(a) == null);
                        java.lang.reflect.Field send = LocalAssistantActivity.class.getDeclaredField("send"); send.setAccessible(true);
                        LocalModelFile model = new LocalModelFile(new java.io.File(a.getNoBackupFilesDir(), "local-models"));
                        if (!model.installed()) require(!((android.widget.Button)send.get(a)).isEnabled());
                    } catch (Exception e) { throw new AssertionError(e); }
                });
            } finally { runOnMainSync(a::finish); }
        });
        Bundle result = new Bundle(); result.putString("stream", failed == 0 ? "\nOK (7 tests)\n" : "\nFAILURES!!! Tests run: 7, Failures: " + failed + "\n");
        result.putInt("numtests", 7); finish(Activity.RESULT_OK, result);
    }
    private void check(String name, Check task) {
        Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putString("class", getClass().getName()); b.putString("test", name); b.putInt("numtests", 7); b.putInt("current", ++current);
        sendStatus(1, b);
        try { task.run(); sendStatus(0, b); }
        catch (Throwable e) { failed++; b.putString("stack", android.util.Log.getStackTraceString(e)); sendStatus(-2, b); }
    }
    private static String labels(android.view.View v) {
        String value = v instanceof android.widget.TextView ? ((android.widget.TextView) v).getText().toString() : "";
        if (v instanceof android.view.ViewGroup) for (int i=0; i<((android.view.ViewGroup)v).getChildCount(); i++) value += " " + labels(((android.view.ViewGroup)v).getChildAt(i));
        return value;
    }
    private static int countInputs(android.view.View v) {
        int n = v instanceof android.widget.EditText ? 1 : 0;
        if (v instanceof android.view.ViewGroup) for(int i=0;i<((android.view.ViewGroup)v).getChildCount();i++) n += countInputs(((android.view.ViewGroup)v).getChildAt(i)); return n;
    }
    private static void require(boolean condition) { if (!condition) throw new AssertionError("Native boundary check failed"); }
}
