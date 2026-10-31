package com.stonezhang.liveui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Only the explicit PackageInstaller PendingIntent can deliver this non-exported receiver. */
public final class UpdateInstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) { AppUpdater.installResult(context, intent); }
}
