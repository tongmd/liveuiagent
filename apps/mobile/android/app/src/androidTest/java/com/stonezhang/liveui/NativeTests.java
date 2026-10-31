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
    private boolean motionPreview;
    @Override public void onCreate(Bundle args) { super.onCreate(args); motionPreview = args != null && "true".equals(args.getString("motionPreview")); start(); }
    @Override public void onStart() {
        if (motionPreview) { recordPreview(); return; }
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
                    require(labels.contains("Your ideas, made yours.")); require(labels.contains("Join the waitlist"));
                    require(!labels.contains("服务地址") && !labels.contains("连接设置") && !labels.contains("https://"));
                    require(countInputs(decor) == 2);
                } catch (Exception e) { throw new AssertionError(e); }
            });
            capture("android-login.png");
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
                        android.app.Dialog dialog = (android.app.Dialog) field.get(a); require(dialog.isShowing()); require(labels(dialog.getWindow().getDecorView()).contains("Start with an idea."));
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
                        require(text.contains("Offline assistant") && text.contains("Gemma 4 E4B") && text.contains("Model source"));
                        require(!text.contains("Username") && !text.contains("Password") && countInputs(a.getWindow().getDecorView()) == 1);
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
                        require(labels(viewport).contains("Gemma 4 E4B") && labels(viewport).contains("Model source"));
                        require(draft.getParent() == ((android.widget.Button)send.get(a)).getParent());

                    } catch (Exception e) { throw new AssertionError(e); }
                });
                capture("android-local-assistant.png");
                runOnMainSync(() -> { try {
                    java.lang.reflect.Field f = LocalAssistantActivity.class.getDeclaredField("input"); f.setAccessible(true);
                    android.widget.EditText input = (android.widget.EditText) f.get(a);
                    input.requestFocus();
                    ((android.view.inputmethod.InputMethodManager)a.getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(input, android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT);
                } catch(Exception e) { throw new AssertionError(e); } });
                final boolean[] visible = {false};
                final int[] bounds = {0, 0};
                for (int poll = 0; poll < 50; poll++) {
                    runOnMainSync(() -> { try {
                        java.lang.reflect.Field f = LocalAssistantActivity.class.getDeclaredField("input"); f.setAccessible(true);
                        android.view.View input = (android.view.View)f.get(a);
                        visible[0] = input.getRootWindowInsets().isVisible(android.view.WindowInsets.Type.ime());
                        android.graphics.Rect frame = new android.graphics.Rect(); input.getWindowVisibleDisplayFrame(frame);
                        int[] at = new int[2]; input.getLocationOnScreen(at);
                        bounds[0] = at[1] + input.getHeight(); bounds[1] = frame.bottom;
                    } catch(Exception e) { throw new AssertionError(e); } });
                    if (visible[0]) break;
                    android.os.SystemClock.sleep(100);
                }
                capture("android-local-keyboard.png");
                if (!visible[0]) throw new AssertionError("Actual IME did not become visible");
                if (bounds[0] > bounds[1]) throw new AssertionError("Composer bottom " + bounds[0] + " exceeds visible frame " + bounds[1]);
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
                    assertBrandCentered(a.getWindow().getDecorView(), "Ulemi");
                    assertBrandCentered(a.getWindow().getDecorView(), "Opening your space");
                    java.lang.reflect.Method await = MainActivity.class.getDeclaredMethod("awaitWorkspace", int.class, int.class); await.setAccessible(true); await.invoke(a, (int)get(a,"workspaceAttempt"), 0);
                } catch (Exception e) { throw new AssertionError(e); } });
                for (int poll = 0; poll < 100; poll++) {
                    final boolean[] ready = {false};
                    runOnMainSync(() -> { try { ready[0] = ((android.view.View)get(a,"handoff")).getVisibility() == android.view.View.GONE; } catch(Exception ignored) {} });
                    if (ready[0]) break;
                    android.os.SystemClock.sleep(150);
                }
                runOnMainSync(() -> { try {
                    require(((android.view.View)get(a,"nativeBar")).getVisibility() == android.view.View.GONE);
                    require(((android.view.View)get(a,"handoff")).getVisibility() == android.view.View.GONE);
                    require(page[0].getHeight() > a.getResources().getDisplayMetrics().heightPixels / 2);
                    java.lang.reflect.Method fail = MainActivity.class.getDeclaredMethod("workspaceError", String.class, boolean.class); fail.setAccessible(true); fail.invoke(a,"Network fixture",false);
                    require(((android.view.View)get(a,"nativeBar")).getVisibility() == android.view.View.VISIBLE);
                    require(!((BrandMotionView)get(a,"handoffMotion")).motionRunning());
                    require(((android.view.View)get(a,"retryLoad")).getVisibility() == android.view.View.VISIBLE);
                    require(!hasHorizontalProgress(a.getWindow().getDecorView()));
                } catch (Exception e) { throw new AssertionError(e); } });
            } finally {
                runOnMainSync(() -> { try { set(a,"currentSession",null); } catch(Exception ignored) {} a.finish(); });
            }
        });
        check("brandMotionHasRealPhasesAndStopsWhenHidden", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            final BrandMotionView[] mark = {null}; final float[] phases = new float[2];
            try {
                runOnMainSync(() -> { try { invoke(a, "showLaunch"); } catch(Exception e) { throw new AssertionError(e); } });
                android.os.SystemClock.sleep(400);
                runOnMainSync(() -> assertBrandCentered(a.getWindow().getDecorView(), "Ulemi"));
                runOnMainSync(() -> { try {
                    invoke(a,"showRestoring"); mark[0] = findMotion(a.getWindow().getDecorView()); require(mark[0] != null);
                    require(labels(a.getWindow().getDecorView()).contains("Opening your space"));
                    require(!labels(a.getWindow().getDecorView()).matches(".*[\\u4e00-\\u9fff].*")); phases[0] = mark[0].motionPhase();
                } catch(Exception e) { throw new AssertionError(e); } });
                capture("android-motion-1.png");
                runOnMainSync(() -> { assertBrandCentered(a.getWindow().getDecorView(), "Ulemi"); assertBrandCentered(a.getWindow().getDecorView(), "Opening your space"); });
                android.os.SystemClock.sleep(600);
                runOnMainSync(() -> { phases[1] = mark[0].motionPhase(); if(android.animation.ValueAnimator.areAnimatorsEnabled()) { require(mark[0].motionRunning()); require(phases[1] != phases[0]); } else require(!mark[0].motionRunning()); });
                capture("android-motion-2.png");
                runOnMainSync(() -> { mark[0].setVisibility(android.view.View.GONE); require(!mark[0].motionRunning()); mark[0].setVisibility(android.view.View.VISIBLE); mark[0].setActive(false); require(!mark[0].motionRunning()); });
            } finally { runOnMainSync(a::finish); }
        });
        check("englishErrorsPreserveMeaningAndRejectPrivateText", () -> {
            require(LocalModelFile.isUserMessage("Model verification failed. Please download again.")); require(LocalModelFile.isUserMessage("Free up additional storage: 4.2 GB")); require(!LocalModelFile.isUserMessage("provider: private-token-123"));
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), LocalAssistantActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try { runOnMainSync(() -> { try {
                java.lang.reflect.Method m = LocalAssistantActivity.class.getDeclaredMethod("readable",Throwable.class); m.setAccessible(true); String memory="Memory is low. Close other apps and try again.";
                require(memory.equals(m.invoke(a,new java.io.IOException(memory)))); require(!((String)m.invoke(a,new java.io.IOException("provider private-token-123"))).contains("private-token"));
                android.widget.Button flat=NativeStyle.button(a,"Menu",false); require(flat.getElevation()==0 && flat.getStateListAnimator()==null);
            } catch(Exception e) { throw new AssertionError(e); } }); } finally { runOnMainSync(a::finish); }
        });
        Bundle result = new Bundle(); result.putString("stream", failed == 0 ? "\nOK (10 tests)\n" : "\nFAILURES!!! Tests run: 10, Failures: " + failed + "\n");
        result.putInt("numtests", 10); finish(Activity.RESULT_OK, result);
    }
    /** Test-only screen recording sequence: real native views, no credentials, network or model requests. */
    private void recordPreview() {
        Activity main = null, local = null;
        Bundle result = new Bundle();
        try {
            main = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            final Activity screen = main;
            runOnMainSync(() -> { try { invoke(screen, "showRestoring"); } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(5000);
            runOnMainSync(() -> { assertBrandCentered(screen.getWindow().getDecorView(), "Ulemi"); assertBrandCentered(screen.getWindow().getDecorView(), "Opening your space"); });
            capture("android-preview-loading.png");
            runOnMainSync(() -> { try { java.lang.reflect.Method m=MainActivity.class.getDeclaredMethod("showLogin",String.class);m.setAccessible(true);m.invoke(screen,new Object[]{null}); } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(3000); capture("android-preview-login.png");
            runOnMainSync(() -> { try { invoke(screen, "showGuide"); } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(3000); capture("android-preview-guide.png");
            runOnMainSync(() -> { try { android.app.Dialog d=(android.app.Dialog)get(screen,"guide");d.dismiss(); } catch(Exception e) { throw new AssertionError(e); } });
            local = startActivitySync(new android.content.Intent(getTargetContext(), LocalAssistantActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(3000); capture("android-preview-local.png");
            result.putString("stream", "MOTION PREVIEW OK\n");
        } catch(Throwable e) { result.putString("stream", "MOTION PREVIEW FAILED: " + android.util.Log.getStackTraceString(e)); }
        finally { if(local!=null) { final Activity a=local;runOnMainSync(a::finish); } if(main!=null) { final Activity a=main;runOnMainSync(a::finish); } }
        finish(Activity.RESULT_OK,result);
    }
    private void check(String name, Check task) {
        Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putString("class", getClass().getName()); b.putString("test", name); b.putInt("numtests", 10); b.putInt("current", ++current);
        sendStatus(1, b);
        try { task.run(); sendStatus(0, b); }
        catch (Throwable e) { failed++; b.putString("stack", android.util.Log.getStackTraceString(e)); sendStatus(-2, b); }
    }
    private void capture(String name) throws Exception {
        waitForIdleSync();
        android.os.SystemClock.sleep(700);
        android.graphics.Bitmap bitmap = getUiAutomation().takeScreenshot();
        require(bitmap != null);
        try (java.io.FileOutputStream file = new java.io.FileOutputStream(new java.io.File(getTargetContext().getFilesDir(), name))) {
            require(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, file));
        } finally { bitmap.recycle(); }
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
    private static void assertBrandCentered(android.view.View stage, String title) {
        BrandMotionView mark = findMotion(stage); android.widget.TextView label = findLabel(stage, title);
        require(mark != null && label != null && label.getLayout() != null);
        int[] iconAt = new int[2], textAt = new int[2]; mark.getLocationOnScreen(iconAt); label.getLocationOnScreen(textAt);
        android.text.Layout layout = label.getLayout();
        float inkCenter = textAt[0] + label.getCompoundPaddingLeft() + (layout.getLineLeft(0) + layout.getLineRight(0)) / 2f;
        float markCenter = iconAt[0] + mark.getWidth() / 2f;
        if (Math.abs(inkCenter - markCenter) > 2f * stage.getResources().getDisplayMetrics().density)
            throw new AssertionError(title + " is not centered beneath the brand: " + inkCenter + " vs " + markCenter);
    }
    private static android.widget.TextView findLabel(android.view.View v, String title) {
        if (v instanceof android.widget.TextView && title.contentEquals(((android.widget.TextView)v).getText()) && v.isShown()) return (android.widget.TextView)v;
        if(v instanceof android.view.ViewGroup) for(int i=0;i<((android.view.ViewGroup)v).getChildCount();i++) { android.widget.TextView found=findLabel(((android.view.ViewGroup)v).getChildAt(i),title); if(found!=null) return found; } return null;
    }
    private static BrandMotionView findMotion(android.view.View v) {
        if(v instanceof BrandMotionView) return (BrandMotionView)v;
        if(v instanceof android.view.ViewGroup) for(int i=0;i<((android.view.ViewGroup)v).getChildCount();i++) { BrandMotionView found=findMotion(((android.view.ViewGroup)v).getChildAt(i)); if(found!=null) return found; } return null;
    }
    private static int countInputs(android.view.View v) {
        int n = v instanceof android.widget.EditText ? 1 : 0;
        if (v instanceof android.view.ViewGroup) for(int i=0;i<((android.view.ViewGroup)v).getChildCount();i++) n += countInputs(((android.view.ViewGroup)v).getChildAt(i)); return n;
    }
    private static void require(boolean condition) { if (!condition) throw new AssertionError("Native boundary check failed"); }
}
