package com.stonezhang.liveui;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.MediaStore;
import android.webkit.ValueCallback;
import java.io.File;

final class ImageCapture {
    static final int PERMISSION = 1402, CAPTURE = 1451;
    private final Activity activity;
    private ValueCallback<Uri> callback;
    private Runnable fallback;
    private Uri uri;
    private File file;
    private boolean awaitingPermission, cameraActive;
    private AlertDialog dialog;
    ImageCapture(Activity activity) { this.activity = activity; }
    static boolean imageOnly(String[] types) {
        if (types == null || types.length == 0) return false;
        for (String type : types) if (type == null || !type.startsWith("image/")) return false;
        return true;
    }
    boolean busy() { return callback != null || awaitingPermission || cameraActive; }
    void start(ValueCallback<Uri> result, Runnable picker) {
        if (busy()) { result.onReceiveValue(null); return; }
        callback = result; fallback = picker;
        if (activity.getPackageManager().resolveActivity(new Intent(MediaStore.ACTION_IMAGE_CAPTURE), PackageManager.MATCH_DEFAULT_ONLY) == null) { fallback(); return; }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            awaitingPermission = true; activity.requestPermissions(new String[]{Manifest.permission.CAMERA}, PERMISSION);
        } else launch();
    }
    void permissions(int code) {
        if (code != PERMISSION) return;
        awaitingPermission = false;
        if (callback == null) return;
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launch();
        else {
            dialog = new AlertDialog.Builder(activity).setTitle("Camera permission not enabled").setMessage("You can select an existing image, or enable Camera in Settings and try again.")
                .setNegativeButton("Cancel", (d,w) -> complete(null)).setOnCancelListener(d -> complete(null)).setNeutralButton("Settings", (d,w) -> { complete(null); new WebCapabilityPermissions(activity, origin -> false).settings(); })
                .setPositiveButton("Choose image", (d,w) -> fallback()).show();
        }
    }
    private void launch() {
        try {
            file = new File(activity.getCacheDir(), "ulemi-capture-" + java.util.UUID.randomUUID() + ".jpg");
            if (!file.createNewFile()) throw new java.io.IOException();
            uri = Uri.parse("content://" + activity.getPackageName() + ".captures/" + file.getName());
            Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("Camera image", uri));
            cameraActive = true; activity.startActivityForResult(intent, CAPTURE);
        } catch (Exception e) { cameraActive = false; fallback(); }
    }
    void result(int request, int result) {
        if (request != CAPTURE) return;
        cameraActive = false;
        Uri ready = result == Activity.RESULT_OK && file != null && file.length() > 0 && file.length() <= ImageViewerActivity.MAX_BYTES ? uri : null;
        complete(ready);
    }
    private void fallback() { Runnable next = fallback; callback = null; complete(null); if (next != null) next.run(); }
    private void complete(Uri result) {
        if (dialog != null) { dialog.setOnCancelListener(null); dialog.dismiss(); dialog = null; }
        if (uri != null) activity.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (result == null && file != null) file.delete();
        ValueCallback<Uri> done = callback; callback = null; fallback = null; uri = null; file = null;
        if (done != null) done.onReceiveValue(result);
    }
    void cancel() { complete(null); }
}
