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
        check("actualImageBytesReachWebViewAndSandbox", () -> MediaChecks.webUploadPixels(this));
        check("imageDecodeBoundsAndRealGestures", () -> MediaChecks.decodingAndGestures(this));
        check("webPermissionOriginAndNavigationCancel", () -> MediaChecks.originsAndCancellation(this));
        check("realOsGrantsAndApproximateLocation", () -> MediaChecks.realPermissionGrantAndApproximateLocation(this));
        check("captureProviderAndActualImageViewer", () -> MediaChecks.captureProviderAndViewer(this));
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
                    assertCompactLoading(a.getWindow().getDecorView());
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
                    require(labels(a.getWindow().getDecorView()).contains("Opening workspace"));
                    require(!labels(a.getWindow().getDecorView()).matches(".*[\\u4e00-\\u9fff].*")); phases[0] = mark[0].motionPhase();
                } catch(Exception e) { throw new AssertionError(e); } });
                capture("android-motion-1.png");
                runOnMainSync(() -> assertCompactLoading(a.getWindow().getDecorView()));
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
        check("deviceAccessStartsIdleAndIsNotExported", () -> {
            android.content.pm.ActivityInfo info = getTargetContext().getPackageManager().getActivityInfo(new android.content.ComponentName(getTargetContext(), DeviceAccessActivity.class), 0);
            require(!info.exported);
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), DeviceAccessActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                runOnMainSync(() -> { try {
                    String content = labels(a.getWindow().getDecorView());
                    require(content.contains("Devices & sensors") && content.contains("Bluetooth") && content.contains("USB") && content.contains("Location"));
                    require(content.contains("Nothing is active"));
                    java.lang.reflect.Field f = DeviceAccessActivity.class.getDeclaredField("session"); f.setAccessible(true);
                    require(!((DeviceAccessPolicy.Session)f.get(a)).active());
                    java.lang.reflect.Field requests = DeviceAccessActivity.class.getDeclaredField("permissionRequests"); requests.setAccessible(true); require(requests.getInt(a) == 0);
                    for (String field : new String[]{"scanner", "discovery", "sensorListener", "locationListener", "multicast"}) {
                        f = DeviceAccessActivity.class.getDeclaredField(field); f.setAccessible(true); require(f.get(a) == null);
                    }
                } catch(Exception e) { throw new AssertionError(e); } });
                capture("android-devices.png");
            } finally { runOnMainSync(a::finish); }
        });
        check("deviceSensorSessionStopsWhenActivityPauses", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), DeviceAccessActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try {
                runOnMainSync(() -> { try {
                    android.hardware.SensorManager manager = (android.hardware.SensorManager)a.getSystemService(Context.SENSOR_SERVICE);
                    android.hardware.Sensor sensor = manager.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
                    if (sensor != null) {
                        java.lang.reflect.Method read = DeviceAccessActivity.class.getDeclaredMethod("readSensor", android.hardware.Sensor.class); read.setAccessible(true); read.invoke(a, sensor);
                    } else {
                        java.lang.reflect.Method begin = DeviceAccessActivity.class.getDeclaredMethod("begin", String.class); begin.setAccessible(true); begin.invoke(a, "Lifecycle fixture");
                    }
                    java.lang.reflect.Field f = DeviceAccessActivity.class.getDeclaredField("session"); f.setAccessible(true);
                    DeviceAccessPolicy.Session session = (DeviceAccessPolicy.Session)f.get(a); require(session.active());
                } catch(Exception e) { throw new AssertionError(e); } });
                android.os.SystemClock.sleep(400);
                capture("android-devices-sensor.png");
                runOnMainSync(() -> { try {
                    java.lang.reflect.Field f = DeviceAccessActivity.class.getDeclaredField("session"); f.setAccessible(true);
                    DeviceAccessPolicy.Session session = (DeviceAccessPolicy.Session)f.get(a);
                    NativeTests.this.callActivityOnPause(a); require(!session.active());
                    for (String field : new String[]{"scanner", "discovery", "sensorListener", "locationListener", "multicast"}) {
                        f = DeviceAccessActivity.class.getDeclaredField(field); f.setAccessible(true); require(f.get(a) == null);
                    }
                    NativeTests.this.callActivityOnResume(a); require(!session.active());
                } catch(Exception e) { throw new AssertionError(e); } });
            } finally { runOnMainSync(a::finish); }
        });
        check("devicePermissionGrantResumesOriginalOperationOnce", () -> {
            Activity a = startActivitySync(new android.content.Intent(getTargetContext(), DeviceAccessActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            try { runOnMainSync(() -> { try {
                final int[] calls = {0};
                java.lang.reflect.Field pending = DeviceAccessActivity.class.getDeclaredField("pendingPermission"); pending.setAccessible(true); pending.set(a, (Runnable)() -> calls[0]++);
                java.lang.reflect.Field purpose = DeviceAccessActivity.class.getDeclaredField("permissionPurpose"); purpose.setAccessible(true); purpose.set(a,"Nearby Bluetooth devices");
                NativeTests.this.callActivityOnPause(a);
                a.onRequestPermissionsResult(1287, new String[]{"android.permission.BLUETOOTH_SCAN"}, new int[]{android.content.pm.PackageManager.PERMISSION_GRANTED});
                require(calls[0] == 0);
                NativeTests.this.callActivityOnResume(a); require(calls[0] == 1);
                NativeTests.this.callActivityOnPause(a); NativeTests.this.callActivityOnResume(a); require(calls[0] == 1);
            } catch(Exception e) { throw new AssertionError(e); } }); }
            finally { runOnMainSync(a::finish); }
        });
        check("realSensorReadingReachesExistingWorkspaceDraftOnce", () -> {
            Activity host = startActivitySync(new android.content.Intent(getTargetContext(), MainActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            android.os.SystemClock.sleep(650);
            final android.webkit.WebView[] page = new android.webkit.WebView[1];
            final String[] snapshot = {null};
            final java.util.concurrent.CountDownLatch pageLoaded = new java.util.concurrent.CountDownLatch(1);
            ActivityMonitor monitor = addMonitor(DeviceAccessActivity.class.getName(), null, false);
            Activity devices = null;
            try {
                runOnMainSync(() -> { try {
                    set(host,"authenticated",true); set(host,"username","sensor-fixture"); set(host,"endpoint",ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL));
                    page[0] = new android.webkit.WebView(host); page[0].getSettings().setJavaScriptEnabled(true); set(host,"web",page[0]); host.setContentView(page[0]);
                    page[0].setWebViewClient(new android.webkit.WebViewClient() { @Override public void onPageFinished(android.webkit.WebView view, String url) { pageLoaded.countDown(); } });
                    page[0].loadDataWithBaseURL(ConnectionPolicy.DEFAULT_URL, "<meta name='viewport' content='width=device-width,initial-scale=1'><form class='frontend-prompt' style='display:none'><textarea>Do not change global draft</textarea></form><section class='app-sheet' data-app-id='sensor-context-fixture'><h1>Current app</h1><form class='ulemi-native-compose'><textarea>Keep my draft</textarea><button>Send</button></form></section><script>window.inputEvents=0;window.submits=0;document.querySelector('.ulemi-native-compose textarea').addEventListener('input',()=>window.inputEvents++);document.querySelector('.ulemi-native-compose').addEventListener('submit',e=>{e.preventDefault();window.submits++})</script>", "text/html", "utf-8", ConnectionPolicy.DEFAULT_URL);
                } catch(Exception e) { throw new AssertionError(e); } });
                require(pageLoaded.await(10, java.util.concurrent.TimeUnit.SECONDS));
                runOnMainSync(() -> { try {
                    if (!(boolean)get(host,"authenticated") || !ConnectionPolicy.sameOrigin(ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL),page[0].getUrl())) throw new AssertionError("Fixture must be authenticated at the real workspace origin; URL=" + page[0].getUrl());
                    invoke(host,"openDeviceAccess");
                } catch(Exception e) { throw new AssertionError(e); } });
                devices = waitForMonitorWithTimeout(monitor, 5000); require(devices != null); final Activity sensorActivity = devices;
                runOnMainSync(() -> { try {
                    require(sensorActivity.getIntent().getBooleanExtra("workspaceAvailable",false));
                    android.hardware.Sensor sensor = ((android.hardware.SensorManager)sensorActivity.getSystemService(Context.SENSOR_SERVICE)).getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER);
                    require(sensor != null);
                    java.lang.reflect.Method read = DeviceAccessActivity.class.getDeclaredMethod("readSensor", android.hardware.Sensor.class); read.setAccessible(true); read.invoke(sensorActivity,sensor);
                } catch(Exception e) { throw new AssertionError(e); } });
                for (int poll = 0; poll < 60 && snapshot[0] == null; poll++) {
                    runOnMainSync(() -> { try { java.lang.reflect.Field o=DeviceAccessActivity.class.getDeclaredField("observation");o.setAccessible(true); Object actual=o.get(sensorActivity); if(actual!=null){snapshot[0]=actual.toString();java.lang.reflect.Method stop=DeviceAccessActivity.class.getDeclaredMethod("stopAll");stop.setAccessible(true);stop.invoke(sensorActivity);} }catch(Exception e){throw new AssertionError(e);} });
                    if (snapshot[0] == null) android.os.SystemClock.sleep(100);
                }
                require(snapshot[0] != null);
                org.json.JSONObject actual = new org.json.JSONObject(snapshot[0]); require(actual.getString("kind").equals("sensor")); require(actual.getJSONObject("values").getJSONArray("values").length() >= 3); require(actual.getJSONObject("values").getLong("sampleElapsedNanos") > 0);
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getTargetContext().getFilesDir(),"android-device-observation.json"))){out.write(new org.json.JSONObject(snapshot[0]).put("readableText",DeviceObservation.readable(actual)).toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getTargetContext().getFilesDir(),"android-device-transfer.js"))){out.write(DeviceObservation.composerScript(snapshot[0],"https://liveui.stonezhang.com").getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getTargetContext().getFilesDir(),"android-device-ack.js"))){out.write(DeviceObservation.acknowledgementScript(snapshot[0],"https://liveui.stonezhang.com").getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                capture("android-devices-sensor.png");
                runOnMainSync(() -> { try { java.lang.reflect.Method use=DeviceAccessActivity.class.getDeclaredMethod("useObservation");use.setAccessible(true);use.invoke(sensorActivity); }catch(Exception e){throw new AssertionError(e);} });
                for (int poll=0;poll<50;poll++) {
                    final boolean[] delivered={false};runOnMainSync(()->{try{delivered[0]=get(host,"pendingDeviceObservation")==null;}catch(Exception e){throw new AssertionError(e);}});
                    android.os.SystemClock.sleep(100); if(delivered[0] && poll>2)break;
                }
                final java.util.concurrent.CountDownLatch checked = new java.util.concurrent.CountDownLatch(1);
                final String[] dom = {null};
                runOnMainSync(() -> page[0].evaluateJavascript("JSON.stringify({draft:document.querySelector('.ulemi-native-compose textarea').value,global:document.querySelector('.frontend-prompt textarea').value,inputs:window.inputEvents,submits:window.submits,appId:document.querySelector('.app-sheet').dataset.appId})", value -> {dom[0]=value;checked.countDown();}));
                require(checked.await(5,java.util.concurrent.TimeUnit.SECONDS));
                String decoded=(String)new org.json.JSONTokener(dom[0]).nextValue();org.json.JSONObject state=new org.json.JSONObject(decoded);
                try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getTargetContext().getFilesDir(),"android-device-dom.json"))){out.write(state.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));}
                if (!state.getString("draft").startsWith("Keep my draft\n\nDevice observation")) throw new AssertionError("Native observation was not added: " + state);
                 require(state.getString("draft").contains("m/s²")); require(state.getInt("inputs")==1 && state.getInt("submits")==0); require(state.getString("global").equals("Do not change global draft")); require(state.getString("appId").equals("sensor-context-fixture"));
                require(state.getString("draft").contains(DeviceObservation.readable(actual)));
                // Replay the same immutable envelope: one insertion only.
                final java.util.concurrent.CountDownLatch duplicate = new java.util.concurrent.CountDownLatch(1); final String[] duplicateResult={null};
                runOnMainSync(() -> { try {page[0].evaluateJavascript(DeviceObservation.composerScript(snapshot[0],"https://liveui.stonezhang.com"), value->{duplicateResult[0]=value;duplicate.countDown();});}catch(Exception e){throw new AssertionError(e);} });
                require(duplicate.await(5,java.util.concurrent.TimeUnit.SECONDS)); require("\"already_added\"".equals(duplicateResult[0]));
                capture("android-devices-workspace.png");
            } finally { removeMonitor(monitor); if(devices!=null){final Activity cleanup=devices;runOnMainSync(cleanup::finish);} runOnMainSync(() -> {try{set(host,"currentSession",null);}catch(Exception ignored){}host.finish();}); }
        });
        Bundle result = new Bundle(); result.putString("stream", failed == 0 ? "\nOK (19 tests)\n" : "\nFAILURES!!! Tests run: 19, Failures: " + failed + "\n");
        result.putInt("numtests", 19); finish(Activity.RESULT_OK, result);
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
            runOnMainSync(() -> assertCompactLoading(screen.getWindow().getDecorView()));
            capture("android-preview-loading.png");
            runOnMainSync(() -> { try { java.lang.reflect.Method m=MainActivity.class.getDeclaredMethod("showLogin",String.class);m.setAccessible(true);m.invoke(screen,new Object[]{null}); } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(3000); capture("android-preview-login.png");
            runOnMainSync(() -> { try { invoke(screen, "showGuide"); } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(3000); capture("android-preview-guide.png");
            runOnMainSync(() -> { try { android.app.Dialog d=(android.app.Dialog)get(screen,"guide");d.dismiss(); } catch(Exception e) { throw new AssertionError(e); } });
            local = startActivitySync(new android.content.Intent(getTargetContext(), LocalAssistantActivity.class).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            final Activity localScreen = local;
            runOnMainSync(() -> { try {
                java.lang.reflect.Field field=LocalAssistantActivity.class.getDeclaredField("input");field.setAccessible(true);
                ((android.widget.EditText)field.get(localScreen)).setText("");
            } catch(Exception e) { throw new AssertionError(e); } });
            android.os.SystemClock.sleep(3000); capture("android-preview-local.png");
            result.putString("stream", "MOTION PREVIEW OK\n");
        } catch(Throwable e) { result.putString("stream", "MOTION PREVIEW FAILED: " + android.util.Log.getStackTraceString(e)); }
        finally { if(local!=null) { final Activity a=local;runOnMainSync(a::finish); } if(main!=null) { final Activity a=main;runOnMainSync(a::finish); } }
        finish(Activity.RESULT_OK,result);
    }
    private void check(String name, Check task) {
        Bundle b = new Bundle(); b.putString("id", "InstrumentationTestRunner"); b.putString("class", getClass().getName()); b.putString("test", name); b.putInt("numtests", 19); b.putInt("current", ++current);
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
    private static void assertCompactLoading(android.view.View stage) {
        assertBrandCentered(stage, "Opening workspace");
        require(countVisibleLabels(stage, "Opening workspace") == 1);
        require(findLabel(stage, "Ulemi") == null);
        BrandMotionView mark = findMotion(stage);
        float density = stage.getResources().getDisplayMetrics().density;
        require(mark != null && mark.isShown());
        require(Math.abs(mark.getWidth() - 112f * density) <= density);
        require(Math.abs(mark.getHeight() - 112f * density) <= density);
    }
    private static int countVisibleLabels(android.view.View view, String title) {
        int count = view instanceof android.widget.TextView && view.isShown()
                && title.contentEquals(((android.widget.TextView)view).getText()) ? 1 : 0;
        if (view instanceof android.view.ViewGroup)
            for (int i = 0; i < ((android.view.ViewGroup)view).getChildCount(); i++)
                count += countVisibleLabels(((android.view.ViewGroup)view).getChildAt(i), title);
        return count;
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
