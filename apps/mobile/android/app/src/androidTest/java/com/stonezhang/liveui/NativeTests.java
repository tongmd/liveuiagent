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
                        java.lang.reflect.Field input = LocalAssistantActivity.class.getDeclaredField("input"); input.setAccessible(true);
                        android.widget.EditText draft = (android.widget.EditText)input.get(a); draft.setText("保留未发送的草稿\n下一行");
                        Bundle saved = new Bundle(); NativeTests.this.callActivityOnSaveInstanceState(a, saved);
                        require("保留未发送的草稿\n下一行".equals(saved.getString("ulemi.local.draft")));
                        java.lang.reflect.Field scroll = LocalAssistantActivity.class.getDeclaredField("scroll"); scroll.setAccessible(true);
                        android.view.ViewGroup viewport = (android.view.ViewGroup)scroll.get(a);
                        require(viewport.getChildCount() == 1);
                        require(labels(viewport).contains("Gemma 4 E4B") && labels(viewport).contains("官方来源"));
                        require(draft.getParent() == ((android.widget.Button)send.get(a)).getParent());

                    } catch (Exception e) { throw new AssertionError(e); }
                });
            } finally { runOnMainSync(a::finish); }
        });
        check("workspaceHasOneHeaderAndNoBrowserProgress", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            final android.webkit.WebView[] page = new android.webkit.WebView[1];
            try {
                runOnMainSync(() -> {
                    try {
                        java.net.URI endpoint = ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL);
                        Class<?> type = Class.forName("com.stonezhang.liveui.MainActivity$Session");
                        java.lang.reflect.Constructor<?> c = type.getDeclaredConstructors()[0]; c.setAccessible(true);
                        Object session = c.newInstance(endpoint, "fixture", "fixture");
                        set(a, "currentSession", session); set(a, "endpoint", endpoint); set(a, "authenticated", true);
                        invoke(a, "openWorkspace");
                        page[0] = (android.webkit.WebView) get(a, "web"); page[0].stopLoading();
                        page[0].setWebViewClient(new android.webkit.WebViewClient());
                        require(!hasHorizontalProgress(a.getWindow().getDecorView()));
                        require(page[0].getSettings().getUserAgentString().contains("UlemiMobile/1"));
                        page[0].loadDataWithBaseURL(ConnectionPolicy.DEFAULT_URL, "<meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0}textarea{position:fixed;bottom:0;width:90%}</style><button data-ulemi-native-menu='true'>Account</button><h1>Workspace fixture</h1><textarea>Keep draft</textarea>", "text/html", "utf-8", null);
                    } catch (Exception e) { throw new AssertionError(e); }
                });
                android.os.SystemClock.sleep(1200);
                runOnMainSync(() -> { try {
                    java.lang.reflect.Method await = MainActivity.class.getDeclaredMethod("awaitWorkspace", int.class, int.class); await.setAccessible(true); await.invoke(a, (int)get(a,"workspaceAttempt"), 0);
                } catch (Exception e) { throw new AssertionError(e); } });
                android.os.SystemClock.sleep(900);
                runOnMainSync(() -> { try {
                    require(((android.view.View)get(a,"nativeBar")).getVisibility() == android.view.View.GONE);
                    require(((android.view.View)get(a,"handoff")).getVisibility() == android.view.View.GONE);
                    require(page[0].getHeight() > a.getResources().getDisplayMetrics().heightPixels / 2);
                    java.lang.reflect.Method fail = MainActivity.class.getDeclaredMethod("workspaceError", String.class, boolean.class); fail.setAccessible(true); fail.invoke(a,"Network fixture",false);
                    require(((android.view.View)get(a,"nativeBar")).getVisibility() == android.view.View.VISIBLE);
                    require(((android.view.View)get(a,"handoffSpinner")).getVisibility() == android.view.View.GONE);
                    require(((android.view.View)get(a,"retryLoad")).getVisibility() == android.view.View.VISIBLE);
                    require(!hasHorizontalProgress(a.getWindow().getDecorView()));
                } catch (Exception e) { throw new AssertionError(e); } });
            } finally {
                runOnMainSync(() -> { try { set(a,"currentSession",null); } catch(Exception ignored) {} a.finish(); });
            }
        });
        Bundle result = new Bundle(); result.putString("stream", failed == 0 ? "\nOK (8 tests)\n" : "\nFAILURES!!! Tests run: 8, Failures: " + failed + "\n");
        result.putInt("numtests", 8); finish(Activity.RESULT_OK, result);
    }
    private void check(String name, Check task) {
        Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putString("class", getClass().getName()); b.putString("test", name); b.putInt("numtests", 8); b.putInt("current", ++current);
        sendStatus(1, b);
        try { task.run(); sendStatus(0, b); }
        catch (Throwable e) { failed++; b.putString("stack", android.util.Log.getStackTraceString(e)); sendStatus(-2, b); }
    }
    private static Object get(Activity a, String name) throws Exception { java.lang.reflect.Field f=MainActivity.class.getDeclaredField(name); f.setAccessible(true); return f.get(a); }
    private static void set(Activity a, String name, Object value) throws Exception { java.lang.reflect.Field f=MainActivity.class.getDeclaredField(name); f.setAccessible(true); f.set(a,value); }
    private static void invoke(Activity a, String name) throws Exception { java.lang.reflect.Method m=MainActivity.class.getDeclaredMethod(name); m.setAccessible(true); m.invoke(a); }
    private static boolean hasHorizontalProgress(android.view.View v) {
        if(v instanceof android.widget.ProgressBar && !((android.widget.ProgressBar)v).isIndeterminate()) return true;
        if(v instanceof android.view.ViewGroup) for(int i=0;i<((android.view.ViewGroup)v).getChildCount();i++) if(hasHorizontalProgress(((android.view.ViewGroup)v).getChildAt(i))) return true;
        return false;
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
