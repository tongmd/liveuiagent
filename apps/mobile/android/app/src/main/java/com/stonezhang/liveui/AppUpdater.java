package com.stonezhang.liveui;

import android.app.*;
import android.app.job.*;
import android.content.*;
import android.content.pm.*;
import android.net.*;
import android.os.*;
import android.provider.Settings;
import android.widget.Toast;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.lang.ref.WeakReference;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Automatic release checks and verified, OS-managed updates. Never touches user or model data. */
final class AppUpdater {
    static final String PREFS = "ulemi_updates", CHANNEL = "ulemi_updates", ACTION = "com.stonezhang.liveui.UPDATE_RESULT";
    static final int JOB = 1283, NOTICE = 1283;
    private static final long INTERVAL = 12L * 60 * 60 * 1000, REMIND = 24L * 60 * 60 * 1000;
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();
    private static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    private static volatile WeakReference<AppUpdater> foreground = new WeakReference<>(null);
    static final class CheckControl {
        volatile boolean stopped; volatile HttpsURLConnection connection;
        void cancel() { stopped = true; HttpsURLConnection c = connection; if (c != null) c.disconnect(); }
        void verify() throws IOException { if (stopped) throw new IOException("Update check stopped"); }
    }
    private final Activity activity;
    private volatile boolean resumed;
    private boolean waitingPermission, showing;
    private AlertDialog dialog;
    AppUpdater(Activity activity) { this.activity = activity; }
    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
    static File directory(Context c) { File d = new File(c.getCacheDir(), "app-updates"); if (!d.isDirectory() && !d.mkdirs()) throw new IllegalStateException("Cannot prepare update storage"); return d; }
    static File apk(Context c, UpdateRelease r) { return new File(directory(c), "ulemi-" + r.versionCode + ".apk"); }
    static long installedVersion(Context c) throws Exception { PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0); return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode; }
    static void schedule(Context c) {
        JobScheduler jobs = (JobScheduler)c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (jobs != null && jobs.getPendingJob(JOB) == null) jobs.schedule(new JobInfo.Builder(JOB, new ComponentName(c, UpdateJobService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED).setRequiresStorageNotLow(true).setPersisted(true).setPeriodic(INTERVAL).build());
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.createNotificationChannel(new NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT));
    }
    void resume() {
        resumed = true; foreground = new WeakReference<>(this); schedule(activity);
        if (waitingPermission) {
            waitingPermission = false;
            if (activity.getPackageManager().canRequestPackageInstalls()) { ready(true, true); return; }
            message("Installation permission is off. Your update stays ready.");
        }
        boolean fromNotice = activity.getIntent().getBooleanExtra("ulemi_update_open", false);
        activity.getIntent().removeExtra("ulemi_update_open");
        if (fromNotice) { ready(true, false); return; }
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (!resumed) return;
            if (!ready(false, false)) check(false, false, null);
        }, 1800);
    }
    void pause() { resumed = false; if (foreground.get() == this) foreground.clear(); if (dialog != null) { dialog.dismiss(); dialog = null; showing = false; } }
    void manualCheck() { if (!ready(true, false)) { message("Checking for updates…"); check(true, false, null); } }
    private boolean available() { return resumed && !activity.isFinishing() && !activity.isDestroyed(); }
    private void message(String s) { if (available()) Toast.makeText(activity, s, Toast.LENGTH_LONG).show(); }
    private static AppUpdater active() { AppUpdater u = foreground.get(); return u != null && u.available() ? u : null; }
    private static void onUi(Runnable r) { new Handler(Looper.getMainLooper()).post(r); }
    private void check(boolean manual, boolean cellular, Runnable finished) { check(activity.getApplicationContext(), manual, cellular, finished); }
    static void check(Context context, boolean manual, boolean cellular, Runnable finished) { check(context, manual, cellular, finished, new CheckControl()); }
    static void check(Context context, boolean manual, boolean cellular, Runnable finished, CheckControl control) {
        Context c = context.getApplicationContext();
        if (!RUNNING.compareAndSet(false, true)) { onUi(() -> { AppUpdater u = active(); if (manual && u != null) u.message("An update check is already running."); if (finished != null) finished.run(); }); return; }
        IO.execute(() -> {
            try {
                control.verify();
                long now = System.currentTimeMillis(), last = prefs(c).getLong("last_check", 0);
                if (!manual && now >= last && now - last < INTERVAL) return;
                UpdateRelease r = fetchRelease(control);
                prefs(c).edit().putLong("last_check", now).apply();
                if (r.versionCode <= installedVersion(c)) {
                    clearOld(c);
                    onUi(() -> { AppUpdater u = active(); if (manual && u != null) u.message("Ulemi is up to date."); }); return;
                }
                if (r.minSdk > Build.VERSION.SDK_INT) { onUi(() -> { AppUpdater u = active(); if (manual && u != null) u.message("This update needs a newer Android version."); }); return; }
                ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
                if (!cellular && (cm == null || cm.isActiveNetworkMetered())) {
                    prefs(c).edit().putString("available", r.json().toString()).apply();
                    onUi(() -> { AppUpdater u = active(); if (u != null) u.offerDownload(r, manual); }); return;
                }
                control.verify(); download(c, r, cellular, control); control.verify();
                prefs(c).edit().putString("ready", r.json().toString()).putString("available", "").putString("error", "").apply();
                onUi(() -> { AppUpdater u = active(); if (u != null) u.ready(manual, false); else tryAutomatic(c, r); });
            } catch (Exception e) {
                if (control.stopped) return;
                prefs(c).edit().putString("error", "Could not check or download the update. Try again later.").apply();
                onUi(() -> { AppUpdater u = active(); if (manual && u != null) u.message("Could not check or download the update. Try again later."); });
            } finally { RUNNING.set(false); if (finished != null) onUi(finished); }
        });
    }
    private void offerDownload(UpdateRelease r, boolean manual) {
        if (!available() || showing) return;
        if (!manual && recentlyPrompted(r)) return;
        markPrompted(r); showing = true;
        dialog = new AlertDialog.Builder(activity).setTitle("Ulemi " + r.versionName + " is available")
            .setMessage("It will download automatically on Wi-Fi. Download now using this connection? (" + ((r.size + 1048575) / 1048576) + " MB)")
            .setNegativeButton("Wait for Wi-Fi", null).setPositiveButton("Download now", (d, w) -> { message("Downloading update…"); check(true, true, null); }).create();
        dialog.setOnDismissListener(d -> { showing = false; dialog = null; }); dialog.show();
    }
    static UpdateRelease stored(Context c) { try { String s = prefs(c).getString("ready", ""); return s.isEmpty() ? null : new UpdateRelease(new JSONObject(s)); } catch (Exception e) { return null; } }
    private boolean ready(boolean manual, boolean startInstall) {
        UpdateRelease r = stored(activity); if (r == null) return false;
        try { if (r.versionCode <= installedVersion(activity)) { clearOld(activity); return false; } if (!apk(activity, r).isFile()) { prefs(activity).edit().remove("ready").apply(); return false; } }
        catch (Exception e) { return false; }
        if (!available() || showing) return true;
        if (startInstall) { beginInstall(r); return true; }
        if (!manual && recentlyPrompted(r)) return true;
        markPrompted(r); showing = true;
        dialog = new AlertDialog.Builder(activity).setTitle("Update ready")
            .setMessage("Ulemi " + r.versionName + " is ready. Your account, apps and downloaded models stay on this device. Android may ask you to confirm installation.")
            .setNegativeButton("Later", null).setPositiveButton("Update now", (d, w) -> beginInstall(r)).create();
        dialog.setOnDismissListener(d -> { showing = false; dialog = null; }); dialog.show(); return true;
    }
    private boolean recentlyPrompted(UpdateRelease r) { long time = prefs(activity).getLong("prompt_at", 0); return prefs(activity).getLong("prompt_version", 0) == r.versionCode && System.currentTimeMillis() >= time && System.currentTimeMillis() - time < REMIND; }
    private void markPrompted(UpdateRelease r) { prefs(activity).edit().putLong("prompt_version", r.versionCode).putLong("prompt_at", System.currentTimeMillis()).apply(); }
    private void beginInstall(UpdateRelease r) {
        if ("confirmation_required".equals(prefs(activity).getString("install_status", ""))) {
            int id = prefs(activity).getInt("session_id", -1);
            if (activity.getPackageManager().getPackageInstaller().getSessionInfo(id) != null) {
                try { activity.startActivity(Intent.parseUri(prefs(activity).getString("confirmation_intent", ""), Intent.URI_INTENT_SCHEME)); }
                catch (Exception e) { message("Android is waiting to finish this update. Open the installation notification or try again later."); }
                return;
            }
        }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingPermission = true;
            try { activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName()))); }
            catch (Exception e) { waitingPermission = false; message("Open Android Settings and allow Ulemi to install app updates."); }
            return;
        }
        message("Preparing update…");
        IO.execute(() -> { try { installVerified(activity.getApplicationContext(), apk(activity, r), r); } catch (Exception e) { onUi(() -> message("The update could not be installed. Check available storage and try again.")); } });
    }
    private static void tryAutomatic(Context c, UpdateRelease r) {
        String state = prefs(c).getString("install_status", "");
        if ("committed".equals(state) || "confirmation_required".equals(state)) { notifyReady(c); return; }
        if (Build.VERSION.SDK_INT >= 31 && c.getPackageManager().canRequestPackageInstalls() && !LocalAssistantActivity.isUpdateBlocked()) {
            IO.execute(() -> {
                if (active() != null || LocalAssistantActivity.isUpdateBlocked()) { notifyReady(c); return; }
                try { installVerified(c, apk(c, r), r); } catch (Exception e) { notifyReady(c); }
            });
        } else notifyReady(c);
    }
    static void notifyReady(Context c) {
        try {
            NotificationManager nm = c.getSystemService(NotificationManager.class); if (nm == null || !nm.areNotificationsEnabled()) return;
            PendingIntent pi = PendingIntent.getActivity(c, NOTICE, new Intent(c, MainActivity.class).putExtra("ulemi_update_open", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            nm.notify(NOTICE, new Notification.Builder(c, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_download_done).setContentTitle("Ulemi update ready")
                .setContentText("Open Ulemi to finish updating.").setContentIntent(pi).setAutoCancel(true).build());
        } catch (SecurityException ignored) { /* Notifications may be disabled; the foreground prompt remains available. */ }
    }
    private static HttpsURLConnection connect(String value, boolean apk, CheckControl control) throws Exception {
        URI u = UpdatePolicy.trustedUrl(value, apk);
        for (int attempt = 0; attempt <= 3; attempt++) {
            control.verify();
            HttpsURLConnection c = (HttpsURLConnection)u.toURL().openConnection(); control.connection = c; c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000);
            c.setRequestProperty("Accept-Encoding", "identity"); c.setRequestProperty("Cache-Control", "no-cache");
            int status = c.getResponseCode();
            if (status >= 300 && status <= 399) { String location = c.getHeaderField("Location"); c.disconnect(); if (location == null) throw new IOException("Missing redirect"); u = UpdatePolicy.trustedUrl(u.resolve(location).toString(), apk); continue; }
            if (status != 200) { c.disconnect(); throw new IOException("Update service unavailable"); }
            return c;
        }
        throw new IOException("Too many update redirects");
    }
    static UpdateRelease fetchRelease() throws Exception { return fetchRelease(new CheckControl()); }
    static UpdateRelease fetchRelease(CheckControl control) throws Exception {
        HttpsURLConnection c = connect(UpdatePolicy.MANIFEST, false, control);
        try (InputStream in = c.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] b = new byte[4096]; int n; while ((n = in.read(b)) != -1) { control.verify(); if (out.size() + n > 16384) throw new IOException("Update metadata too large"); out.write(b, 0, n); }
            return new UpdateRelease(new JSONObject(out.toString(StandardCharsets.UTF_8.name())));
        } finally { c.disconnect(); }
    }
    private static void download(Context c, UpdateRelease r, boolean cellular, CheckControl control) throws Exception {
        File dest = apk(c, r); if (dest.isFile()) { try { verifyApk(c, dest, r); return; } catch (Exception invalid) { dest.delete(); } }
        if (directory(c).getUsableSpace() < r.size + 64L * 1024 * 1024) throw new IOException("Not enough update storage");
        File partial = new File(directory(c), "download.part"); partial.delete();
        HttpsURLConnection conn = connect(r.url, true, control);
        try {
            long advertised = conn.getContentLengthLong(); if (advertised >= 0 && advertised != r.size) throw new IOException("Update size changed");
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(partial)) {
                byte[] b = new byte[65536]; int n; long total = 0, deadline = SystemClock.elapsedRealtime() + 10L * 60 * 1000;
                while ((n = in.read(b)) != -1) { control.verify();
                    ConnectivityManager cm = c.getSystemService(ConnectivityManager.class);
                    if (!cellular && (cm == null || cm.isActiveNetworkMetered())) throw new IOException("Waiting for Wi-Fi");
                    total += n; if (Thread.currentThread().isInterrupted() || total > r.size || SystemClock.elapsedRealtime() > deadline) throw new IOException("Update download interrupted"); out.write(b, 0, n); }
                out.getFD().sync(); if (total != r.size) throw new IOException("Incomplete update");
            }
            verifyApk(c, partial, r); if (!partial.renameTo(dest)) throw new IOException("Cannot save verified update");
        } finally { conn.disconnect(); partial.delete(); }
    }
    @SuppressWarnings("deprecation")
    static void verifyApk(Context c, File file, UpdateRelease r) throws Exception {
        UpdatePolicy.verifyFile(file, r.size, r.sha256);
        PackageManager pm = c.getPackageManager(); int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo current = pm.getPackageInfo(c.getPackageName(), flags), next = pm.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        if (next == null || !c.getPackageName().equals(r.packageName) || !r.packageName.equals(next.packageName)
                || (Build.VERSION.SDK_INT >= 28 ? next.getLongVersionCode() : next.versionCode) != r.versionCode
                || r.versionCode <= installedVersion(c) || next.applicationInfo == null || next.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new SecurityException("Update package or version mismatch");
        Signature[] a = Build.VERSION.SDK_INT >= 28 ? current.signingInfo.getApkContentsSigners() : current.signatures;
        Signature[] b = Build.VERSION.SDK_INT >= 28 ? next.signingInfo.getApkContentsSigners() : next.signatures;
        byte[][] aa = new byte[a.length][], bb = new byte[b.length][]; for (int i = 0; i < a.length; i++) aa[i] = a[i].toByteArray(); for (int i = 0; i < b.length; i++) bb[i] = b[i].toByteArray();
        if (!UpdatePolicy.sameSigners(aa, bb)) throw new SecurityException("Update signing certificate mismatch");
    }
    static synchronized void installVerified(Context c, File file, UpdateRelease r) throws Exception {
        verifyApk(c, file, r);
        if (!c.getPackageManager().canRequestPackageInstalls()) throw new SecurityException("Installation permission required");
        PackageInstaller installer = c.getPackageManager().getPackageInstaller();
        // A committed OS transaction is never replayed. Uncommitted staging from a killed
        // process has no installation effect and can be safely replaced on this explicit attempt.
        for (PackageInstaller.SessionInfo existing : installer.getMySessions()) {
            if (!c.getPackageName().equals(existing.getAppPackageName())) continue;
            if (existing.isSealed()) return;
            installer.abandonSession(existing.getSessionId());
        }
        prefs(c).edit().remove("confirmation_intent").apply();
        PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
        params.setAppPackageName(c.getPackageName()); params.setSize(r.size);
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
        int id = installer.createSession(params); String token = UUID.randomUUID().toString(); boolean committed = false;
        prefs(c).edit().putInt("session_id", id).putString("session_token", token).putLong("expected_version", r.versionCode).putString("install_status", "preparing").commit();
        try (PackageInstaller.Session session = installer.openSession(id)) {
            try (InputStream in = new FileInputStream(file); OutputStream out = session.openWrite("base.apk", 0, r.size)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) != -1) out.write(b, 0, n); session.fsync(out); }
            prefs(c).edit().putInt("session_id", id).putString("session_token", token).putLong("expected_version", r.versionCode).putString("install_status", "committed").commit();
            Intent result = new Intent(c, UpdateInstallReceiver.class).setAction(ACTION).putExtra("ulemi_session_token", token);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT; if (Build.VERSION.SDK_INT >= 31) flags |= PendingIntent.FLAG_MUTABLE;
            PendingIntent status = PendingIntent.getBroadcast(c, id, result, flags);
            session.commit(status.getIntentSender()); committed = true;
        } finally { if (!committed) { try { installer.abandonSession(id); } catch (Exception ignored) { } prefs(c).edit().putString("install_status", "failed").apply(); } }
    }
    static void installResult(Context c, Intent intent) {
        SharedPreferences p = prefs(c); int id = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
        if (!ACTION.equals(intent.getAction()) || id != p.getInt("session_id", -2) || !p.getString("session_token", "").equals(intent.getStringExtra("ulemi_session_token"))) return;
        int result = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (result == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = intent.getParcelableExtra(Intent.EXTRA_INTENT);
            p.edit().putString("install_status", "confirmation_required")
                .putString("confirmation_intent", confirmation == null ? "" : confirmation.toUri(Intent.URI_INTENT_SCHEME)).commit();
            AppUpdater u = active();
            if (u != null && confirmation != null) { try { u.activity.startActivity(confirmation); } catch (Exception e) { notifyReady(c); } }
            else notifyReady(c);
        } else if (result == PackageInstaller.STATUS_SUCCESS) {
            p.edit().putString("install_status", "installed").remove("session_id").remove("session_token").remove("confirmation_intent").apply();
            NotificationManager nm = c.getSystemService(NotificationManager.class); if (nm != null) nm.cancel(NOTICE);
        } else {
            p.edit().putString("install_status", "failed").remove("session_id").remove("session_token").remove("confirmation_intent").apply();
            onUi(() -> { AppUpdater u = active(); if (u != null) u.message("Update not installed. Your current version and data are unchanged."); });
        }
    }
    private static void clearOld(Context c) {
        File[] files = directory(c).listFiles(); if (files != null) for (File f : files) if (f.isFile()) f.delete();
        SharedPreferences.Editor edit = prefs(c).edit().remove("ready").remove("available").remove("prompt_version").remove("prompt_at");
        try { if (installedVersion(c) >= prefs(c).getLong("expected_version", Long.MAX_VALUE))
            edit.putString("install_status", "installed").remove("session_id").remove("session_token").remove("confirmation_intent"); } catch (Exception ignored) { }
        edit.apply();
        NotificationManager nm = c.getSystemService(NotificationManager.class); if (nm != null) nm.cancel(NOTICE);
    }
}
