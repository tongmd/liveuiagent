package com.stonezhang.liveui;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
/** Shared picker-result boundary used by the actual WebView file callback. */
final class UploadSelection {
    static Uri[] parse(int result, Intent data) {
        if (result != Activity.RESULT_OK || data == null) return null;
        if (data.getClipData() != null) {
            int n = data.getClipData().getItemCount(); if (n < 1 || n > 32) return null;
            Uri[] values = new Uri[n];
            for (int i=0;i<n;i++) { values[i] = data.getClipData().getItemAt(i).getUri(); if (!valid(values[i])) return null; }
            return values;
        }
        return valid(data.getData()) ? new Uri[]{data.getData()} : null;
    }
    private static boolean valid(Uri uri) { return uri != null && ConnectionPolicy.isContentUpload(uri.toString()); }
}
