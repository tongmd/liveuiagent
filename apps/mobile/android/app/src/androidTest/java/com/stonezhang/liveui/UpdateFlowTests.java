package com.stonezhang.liveui;

import android.app.Instrumentation;
import android.app.job.JobScheduler;
import android.content.pm.PackageInstaller;
import org.json.JSONArray;
import android.content.Context;
import android.os.Bundle;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/** Exercises the production verifier and installer on an emulator, without a test bypass. */
public final class UpdateFlowTests extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle args) { super.onCreate(args); arguments = args; start(); }
    private static void require(boolean value, String reason) { if (!value) throw new AssertionError(reason); }
    private File fixture(String name) { return new File(getTargetContext().getFilesDir(), name); }
    private UpdateRelease release(File file, long version) throws Exception {
        return new UpdateRelease(new JSONObject().put("schemaVersion", 1)
            .put("packageName", "com.stonezhang.liveui").put("versionCode", version)
            .put("versionName", "update-test-new").put("minSdk", 26).put("size", file.length())
            .put("sha256", UpdatePolicy.sha256(file)).put("url", "https://" + UpdatePolicy.HOST + "/android/releases/update-test.apk"));
    }
    private void rejected(File file, UpdateRelease release, String message) throws Exception {
        boolean denied = false;
        try { AppUpdater.verifyApk(getTargetContext(), file, release); } catch (Exception expected) { denied = true; }
        require(denied, message);
    }
    private void report(String label, JSONObject details) throws Exception {
        Files.write(fixture("update-test-" + label + ".json").toPath(), details.toString(2).getBytes(StandardCharsets.UTF_8));
        Bundle status = new Bundle(); status.putString("stream", "\nUPDATE_TEST_" + label.toUpperCase() + "\n"); sendStatus(0, status);
    }
    private JSONObject diagnostics(Context c) throws Exception {
        JSONArray sessions = new JSONArray();
        for (PackageInstaller.SessionInfo session : c.getPackageManager().getPackageInstaller().getMySessions())
            sessions.put(new JSONObject().put("id", session.getSessionId()).put("package", session.getAppPackageName())
                .put("sealed", session.isSealed()).put("active", session.isActive()));
        JSONObject confirmation = new JSONObject();
        String saved = AppUpdater.prefs(c).getString("confirmation_intent", "");
        if (!saved.isEmpty()) {
            android.content.Intent parsed = android.content.Intent.parseUri(saved, android.content.Intent.URI_INTENT_SCHEME);
            confirmation.put("action", parsed.getAction()).put("package", parsed.getPackage())
                .put("component", parsed.getComponent() == null ? JSONObject.NULL : parsed.getComponent().flattenToString())
                .put("flags", parsed.getFlags()).put("extraKeys", new JSONArray(parsed.getExtras() == null ? java.util.Collections.emptyList() : parsed.getExtras().keySet()));
        }
        return new JSONObject().put("confirmation", confirmation).put("installedVersion", AppUpdater.installedVersion(c)).put("sessions", sessions)
            .put("installStatus", AppUpdater.prefs(c).getString("install_status", ""))
            .put("sessionId", AppUpdater.prefs(c).getInt("session_id", -1));
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context c = getTargetContext(); String phase = arguments.getString("phase", "validate");
            File apk = fixture("update-test-next.apk");
            if ("public-manifest".equals(phase)) {
                UpdateRelease published = AppUpdater.fetchRelease();
                require(c.getPackageName().equals(published.packageName), "Wrong public manifest package");
                report("public-manifest", new JSONObject().put("passed", true).put("manifest", published.json())
                    .put("path", "production AppUpdater.fetchRelease HTTPS; no download or install"));
            } else if ("validate".equals(phase)) {
                require(AppUpdater.installedVersion(c) == 1001, "Expected lower test version");
                AppUpdater.verifyApk(c, apk, release(apk, 1002));
                rejected(fixture("update-test-wrong-signer.apk"), release(fixture("update-test-wrong-signer.apk"), 1002), "Wrong signing certificate accepted");
                rejected(fixture("update-test-old.apk"), release(fixture("update-test-old.apk"), 1001), "Same version accepted");
                rejected(fixture("update-test-other-package.apk"), release(fixture("update-test-other-package.apk"), 1002), "Other package accepted");
                JSONObject wrongHash = release(apk, 1002).json().put("sha256", new String(new char[64]).replace('\0', '0'));
                rejected(apk, new UpdateRelease(wrongHash), "Wrong hash accepted");
                JSONObject wrongLength = release(apk, 1002).json().put("size", apk.length() + 1);
                rejected(apk, new UpdateRelease(wrongLength), "Wrong size accepted");
                UpdateRelease next = release(apk, 1002);
                File cached = AppUpdater.apk(c, next);
                Files.write(cached.toPath(), "incomplete cached download".getBytes(StandardCharsets.UTF_8));
                AppUpdater.prefs(c).edit().putString("ready", next.json().toString()).putLong("last_check", 1234).commit();
                rejected(cached, next, "Damaged cache accepted");
                require(AppUpdater.invalidateCached(c, next), "Damaged cached update not invalidated");
                require(!cached.exists() && AppUpdater.stored(c) == null && !AppUpdater.prefs(c).contains("last_check"), "Damaged cache prevents retry");
                AppUpdater.verifyApk(c, apk, next);
                report("validate", new JSONObject().put("passed", true).put("checks", 7).put("damagedCacheCanRetry", true));
            } else if ("blocked".equals(phase)) {
                require(!c.getPackageManager().canRequestPackageInstalls(), "Unknown sources unexpectedly allowed");
                int before = c.getPackageManager().getPackageInstaller().getMySessions().size(); boolean denied = false;
                try { AppUpdater.installVerified(c, apk, release(apk, 1002)); } catch (SecurityException expected) { denied = true; }
                require(denied, "Installer ignored disabled permission");
                require(c.getPackageManager().getPackageInstaller().getMySessions().size() == before, "Denied install created session");
                report("blocked", new JSONObject().put("passed", true).put("createdSession", false));
            } else if ("install".equals(phase) || "prepare-background".equals(phase)) {
                require(c.getPackageManager().canRequestPackageInstalls(), "Unknown sources permission not enabled");
                require(c.getSharedPreferences("update-test", 0).edit().putString("marker", "keep-this-state-1283").commit(), "Could not save fixture state");
                c.getSharedPreferences("experience", 0).edit().putBoolean("guide_seen_v1", true).commit();
                new CredentialStore(c, ".update-test").save(ConnectionPolicy.DEFAULT_URL, "fixture-user", "fixture-password-not-a-real-account");
                File model = new File(c.getNoBackupFilesDir(), "local-models/update-test-model-marker.bin"); model.getParentFile().mkdirs();
                Files.write(model.toPath(), "model-file-preserved".getBytes(StandardCharsets.UTF_8));
                Files.write(fixture("update-test-chat.json").toPath(), "[{\"content\":\"keep my offline history\"}]".getBytes(StandardCharsets.UTF_8));
                // Exercise scheduling independently. A fresh periodic job may run immediately;
                // production's real v4 channel must not erase this artificial v1002 fixture.
                require(AppUpdater.prefs(c).edit().putLong("last_check", System.currentTimeMillis()).commit(), "Could not isolate periodic check");
                AppUpdater.schedule(c);
                JobScheduler scheduler = c.getSystemService(JobScheduler.class);
                require(scheduler.getPendingJob(AppUpdater.JOB) != null, "Periodic update job not registered");
                scheduler.cancel(AppUpdater.JOB);
                require(scheduler.getPendingJob(AppUpdater.JOB) == null, "Fixture periodic job not cancelled");
                report("scheduler", new JSONObject().put("registered", true).put("cancelledForFixture", true));
                UpdateRelease next = release(apk, 1002);
                Files.copy(apk.toPath(), AppUpdater.apk(c, next).toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                require(AppUpdater.prefs(c).edit().putString("ready", next.json().toString()).commit(), "Could not save ready update");
                report("requested", diagnostics(c).put("from", 1001).put("to", 1002).put("cachedSha256", UpdatePolicy.sha256(AppUpdater.apk(c, next))).put("path", "production AppUpdater.installVerified"));
                if ("prepare-background".equals(phase)) {
                    AppUpdater.scheduleReady(c);
                    android.app.job.JobInfo readyJob = scheduler.getPendingJob(1284);
                    require(readyJob != null, "Ready installation job not scheduled");
                    require(readyJob.getRequiredNetwork() == null, "Cached installation requires a network");
                    require(AppUpdater.prefs(c).getLong("last_check", 0) > System.currentTimeMillis() - 60000, "Recent metadata throttle missing");
                    require(c.getPackageManager().getPackageInstaller().getMySessions().isEmpty(), "Install ran before background trigger");
                    report("background-ready", diagnostics(c).put("jobId", 1284).put("noNetworkRequirement", true).put("recentMetadataCheck", true));
                } else {
                    AppUpdater.installVerified(c, AppUpdater.apk(c, next), next);
                    // The OS may terminate this process before finish: the external driver checks the installed package.
                    report("committed", diagnostics(c));
                    if (android.os.Build.VERSION.SDK_INT < 31) {
                        long deadline = android.os.SystemClock.elapsedRealtime() + 30000;
                        while (!"confirmation_required".equals(AppUpdater.prefs(c).getString("install_status", "")) && android.os.SystemClock.elapsedRealtime() < deadline)
                            android.os.SystemClock.sleep(50);
                        require("confirmation_required".equals(AppUpdater.prefs(c).getString("install_status", "")), "OS pending confirmation callback not received");
                        // Drain the actual receiver's main-thread transaction before ending
                        // instrumentation, which can tear down the target process.
                        runOnMainSync(() -> { });
                        report("pending-callback", diagnostics(c));
                    }
                }
            } else if ("verify".equals(phase)) {
                require(AppUpdater.installedVersion(c) == 1002, "New APK was not installed");
                require("keep-this-state-1283".equals(c.getSharedPreferences("update-test", 0).getString("marker", "")), "Preferences lost");
                require(c.getSharedPreferences("experience", 0).getBoolean("guide_seen_v1", false), "Onboarding state lost");
                JSONObject credentials = new CredentialStore(c, ".update-test").load();
                require(credentials != null && "fixture-user".equals(credentials.getString("user")) && "fixture-password-not-a-real-account".equals(credentials.getString("password")), "Keystore credential no longer decrypts");
                require("model-file-preserved".equals(new String(Files.readAllBytes(new File(c.getNoBackupFilesDir(), "local-models/update-test-model-marker.bin").toPath()), StandardCharsets.UTF_8)), "Model marker changed");
                require("[{\"content\":\"keep my offline history\"}]".equals(new String(Files.readAllBytes(fixture("update-test-chat.json").toPath()), StandardCharsets.UTF_8)), "Chat marker changed");
                report("verify", new JSONObject().put("passed", true).put("installedVersion", 1002)
                    .put("preferencesPreserved", true).put("onboardingPreserved", true).put("credentialDecrypts", true)
                    .put("modelMarkerPreserved", true).put("chatMarkerPreserved", true)
                    .put("installerStatus", AppUpdater.prefs(c).getString("install_status", "")));
            } else throw new IllegalArgumentException("Unknown phase");
            result.putString("stream", "\nUPDATE_TEST_OK " + phase + "\n"); finish(-1, result);
        } catch (Throwable failure) {
            try { report("failure", diagnostics(getTargetContext()).put("phase", arguments.getString("phase", "validate"))
                .put("failure", android.util.Log.getStackTraceString(failure))); } catch (Exception ignored) { }
            result.putString("stream", "\nUPDATE_TEST_FAILED " + failure + "\n"); finish(0, result);
        }
    }
}
