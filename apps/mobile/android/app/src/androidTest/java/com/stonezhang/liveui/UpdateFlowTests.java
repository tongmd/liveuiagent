package com.stonezhang.liveui;

import android.app.Instrumentation;
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
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context c = getTargetContext(); String phase = arguments.getString("phase", "validate");
            File apk = fixture("update-test-next.apk");
            if ("validate".equals(phase)) {
                require(AppUpdater.installedVersion(c) == 1001, "Expected lower test version");
                AppUpdater.verifyApk(c, apk, release(apk, 1002));
                rejected(fixture("update-test-wrong-signer.apk"), release(fixture("update-test-wrong-signer.apk"), 1002), "Wrong signing certificate accepted");
                rejected(fixture("update-test-old.apk"), release(fixture("update-test-old.apk"), 1001), "Same version accepted");
                rejected(fixture("update-test-other-package.apk"), release(fixture("update-test-other-package.apk"), 1002), "Other package accepted");
                JSONObject wrongHash = release(apk, 1002).json().put("sha256", "0".repeat(64));
                rejected(apk, new UpdateRelease(wrongHash), "Wrong hash accepted");
                JSONObject wrongLength = release(apk, 1002).json().put("size", apk.length() + 1);
                rejected(apk, new UpdateRelease(wrongLength), "Wrong size accepted");
                report("validate", new JSONObject().put("passed", true).put("checks", 6));
            } else if ("blocked".equals(phase)) {
                require(!c.getPackageManager().canRequestPackageInstalls(), "Unknown sources unexpectedly allowed");
                int before = c.getPackageManager().getPackageInstaller().getMySessions().size(); boolean denied = false;
                try { AppUpdater.installVerified(c, apk, release(apk, 1002)); } catch (SecurityException expected) { denied = true; }
                require(denied, "Installer ignored disabled permission");
                require(c.getPackageManager().getPackageInstaller().getMySessions().size() == before, "Denied install created session");
                report("blocked", new JSONObject().put("passed", true).put("createdSession", false));
            } else if ("install".equals(phase)) {
                require(c.getPackageManager().canRequestPackageInstalls(), "Unknown sources permission not enabled");
                require(c.getSharedPreferences("update-test", 0).edit().putString("marker", "keep-this-state-1283").commit(), "Could not save fixture state");
                c.getSharedPreferences("experience", 0).edit().putBoolean("guide_seen_v1", true).commit();
                new CredentialStore(c, ".update-test").save(ConnectionPolicy.DEFAULT_URL, "fixture-user", "fixture-password-not-a-real-account");
                File model = new File(c.getNoBackupFilesDir(), "local-models/update-test-model-marker.bin"); model.getParentFile().mkdirs();
                Files.write(model.toPath(), "model-file-preserved".getBytes(StandardCharsets.UTF_8));
                Files.write(fixture("update-test-chat.json").toPath(), "[{\"content\":\"keep my offline history\"}]".getBytes(StandardCharsets.UTF_8));
                report("requested", new JSONObject().put("from", 1001).put("to", 1002).put("path", "production AppUpdater.installVerified"));
                AppUpdater.installVerified(c, apk, release(apk, 1002));
                // The OS may terminate this process before finish: the external driver checks the installed package.
                report("committed", new JSONObject().put("sessionId", AppUpdater.prefs(c).getInt("session_id", -1)));
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
            result.putString("stream", "\nUPDATE_TEST_FAILED " + failure + "\n"); finish(0, result);
        }
    }
}
