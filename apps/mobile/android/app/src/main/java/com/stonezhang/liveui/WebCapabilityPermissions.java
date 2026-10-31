package com.stonezhang.liveui;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.provider.Settings;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import java.util.ArrayList;
import java.util.ArrayDeque;

/** Requests belong to the authenticated document. Android owns the actual permission prompt. */
final class WebCapabilityPermissions {
    static final int REQUEST = 1401;
    interface Trusted { boolean check(String origin); }
    private final Activity activity;
    private final Trusted trusted;
    private final java.util.function.BooleanSupplier externalBusy;
    private final ArrayDeque<Entry> queue = new ArrayDeque<>();
    private Entry current;
    private boolean systemPending, clearing;
    private AlertDialog denial;
    private static final class Entry {
        String origin; String[] permissions, resources; PermissionRequest media;
        GeolocationPermissions.Callback location; Runnable capture, cancel;
        void deny() { if(media!=null)media.deny(); if(location!=null)location.invoke(origin,false,false); if(cancel!=null)cancel.run(); }
    }
    WebCapabilityPermissions(Activity activity, Trusted trusted) { this(activity,trusted,()->false); }
    WebCapabilityPermissions(Activity activity, Trusted trusted, java.util.function.BooleanSupplier externalBusy) { this.activity = activity; this.trusted = trusted; this.externalBusy=externalBusy; }
    void resume() { pump(); }
    static String[] androidPermissions(String[] resources) {
        if (resources == null || resources.length == 0) return null;
        ArrayList<String> result = new ArrayList<>();
        for (String resource : resources) {
            String permission;
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) permission = Manifest.permission.CAMERA;
            else if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) permission = Manifest.permission.RECORD_AUDIO;
            else return null;
            if (!result.contains(permission)) result.add(permission);
        }
        return result.toArray(new String[0]);
    }
    boolean busy() { return systemPending || current != null || !queue.isEmpty(); }
    void media(PermissionRequest request) {
        String[] wanted = androidPermissions(request.getResources());
        if (wanted == null || !trusted.check(request.getOrigin().toString())) { request.deny(); return; }
        Entry entry = new Entry(); entry.media=request;entry.origin=request.getOrigin().toString();entry.permissions=wanted;entry.resources=request.getResources().clone();enqueue(entry);
    }
    void location(String value, GeolocationPermissions.Callback callback) {
        if (!trusted.check(value)) { callback.invoke(value, false, false); return; }
        Entry entry = new Entry();entry.location=callback;entry.origin=value;entry.permissions=new String[]{Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION};enqueue(entry);
    }
    void capture(String origin, Runnable run, Runnable cancel) {
        Entry entry=new Entry();entry.origin=origin;entry.capture=run;entry.cancel=cancel;enqueue(entry);
    }
    void finishCapture() { if(current!=null&&current.capture!=null){current=null;pump();} }
    private void enqueue(Entry entry) {
        if(clearing || queue.size()>=4 || !trusted.check(entry.origin)){entry.deny();return;}
        queue.add(entry);pump();
    }
    private void pump() {
        if(clearing || systemPending || current!=null || externalBusy.getAsBoolean() || activity.isFinishing() || activity.isDestroyed())return;
        while(!queue.isEmpty()){
            Entry entry=queue.remove();if(!trusted.check(entry.origin)){entry.deny();continue;}
            current=entry;
            if(entry.capture!=null){entry.capture.run();return;}
            if(allowed(entry)){complete();return;}
            ArrayList<String> missing=new ArrayList<>();
            for(String permission:entry.permissions)if(!granted(permission))missing.add(permission);
            systemPending=true;activity.requestPermissions(missing.toArray(new String[0]),REQUEST);return;
        }
    }
    private boolean allowed(Entry entry) {
        if(entry.location!=null)return granted(Manifest.permission.ACCESS_COARSE_LOCATION)||granted(Manifest.permission.ACCESS_FINE_LOCATION);
        for(String permission:entry.permissions)if(!granted(permission))return false;return true;
    }
    private boolean granted(String permission) { return activity.checkSelfPermission(permission)==PackageManager.PERMISSION_GRANTED; }
    void result(int request) {
        if(request!=REQUEST)return;systemPending=false;
        if(current==null){pump();return;}
        if(!trusted.check(current.origin)){Entry old=current;current=null;old.deny();pump();return;}
        if(allowed(current)){complete();return;}
        Entry failed=current;current=null;failed.deny();
        if(!activity.isFinishing()&&!activity.isDestroyed()){
            denial=new AlertDialog.Builder(activity).setTitle("Permission not enabled").setMessage("Try this feature again to allow access, or enable its permission in Android Settings.")
                .setNegativeButton("Close",null).setPositiveButton("Open Settings",(d,w)->settings()).create();denial.show();
        }
        pump();
    }
    private void complete() {
        Entry entry=current;current=null;
        if(entry.media!=null)entry.media.grant(entry.resources);
        if(entry.location!=null)entry.location.invoke(entry.origin,true,false);
        pump();
    }
    void canceled(PermissionRequest request) {
        queue.removeIf(entry->{if(entry.media==request){entry.deny();return true;}return false;});
        if(current!=null&&current.media==request){Entry old=current;current=null;old.deny();pump();}
    }
    void cancelLocation() {
        queue.removeIf(entry->{if(entry.location!=null){entry.deny();return true;}return false;});
        if(current!=null&&current.location!=null){Entry old=current;current=null;old.deny();pump();}
    }
    void cancel() {
        clearing=true;
        if(denial!=null){denial.dismiss();denial=null;}
        Entry old=current;current=null;if(old!=null)old.deny();
        while(!queue.isEmpty())queue.remove().deny();clearing=false;
        // A canceled Android dialog must deliver its result before a new permission request starts.
    }
    void settings() {
        try{activity.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+activity.getPackageName())));}
        catch(android.content.ActivityNotFoundException e){android.widget.Toast.makeText(activity,"Open Android Settings, then Apps > Ulemi > Permissions.",android.widget.Toast.LENGTH_LONG).show();}
    }
}
