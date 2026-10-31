package com.stonezhang.liveui;

import android.Manifest;
import android.app.*;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.*;
import android.hardware.usb.*;
import android.location.*;
import android.net.Uri;
import android.net.nsd.*;
import android.net.wifi.WifiManager;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.widget.*;
import java.util.*;

/** User-operated, native discovery and readings. Never exposed to WebView JavaScript. */
@android.annotation.SuppressLint("MissingPermission") // Explicit runtime checks precede each user action; revocation is caught.
public final class DeviceAccessActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final DeviceAccessPolicy.Session session = new DeviceAccessPolicy.Session();
    private boolean foreground;
    private Runnable pendingPermission;
    private String permissionPurpose;
    private TextView status, results;
    private LinearLayout cards;
    private BluetoothLeScanner scanner;
    private ScanCallback scanCallback;
    private NsdManager nsd;
    private NsdManager.DiscoveryListener discovery;
    private WifiManager.MulticastLock multicast;
    private SensorManager sensors;
    private SensorEventListener sensorListener;
    private LocationManager locations;
    private LocationListener locationListener;
    private final LinkedHashMap<String,String> found = new LinkedHashMap<>();
    private long lastSensorUpdate;
    private int permissionRequests;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        sensors = (SensorManager)getSystemService(SENSOR_SERVICE);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(22), dp(12), dp(22), dp(12)); root.setBackgroundColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, i) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets b = i.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(dp(22) + b.left, dp(12) + b.top, dp(22) + b.right, dp(12) + b.bottom);
            } else v.setPadding(dp(22), dp(12) + i.getSystemWindowInsetTop(), dp(22), dp(12) + i.getSystemWindowInsetBottom());
            return i;
        });
        LinearLayout header = new LinearLayout(this); header.setGravity(Gravity.CENTER_VERTICAL);
        Button back = button("Back", false); back.setOnClickListener(v -> finish()); header.addView(back, new LinearLayout.LayoutParams(dp(72), dp(48)));
        TextView brand = text("U", 26); brand.setTypeface(Typeface.DEFAULT_BOLD); brand.setGravity(Gravity.RIGHT); header.addView(brand, new LinearLayout.LayoutParams(0, -2, 1)); root.addView(header);
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); cards = new LinearLayout(this); cards.setOrientation(LinearLayout.VERTICAL); scroll.addView(cards); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView title = text("Devices & sensors", 29); title.setTypeface(Typeface.create("sans-serif-medium", 0)); title.setPadding(0, dp(20), 0, dp(8)); cards.addView(title);
        cards.addView(text("Explore nearby devices and live readings. Access stays on this screen and stops when you leave.", 15));
        addAction("Bluetooth", "Discover nearby Bluetooth LE devices for 15 seconds.", "Find devices", this::requestBluetooth);
        addAction("Local network", "Find advertised HTTP, MQTT or HomeKit services on your current network.", "Find services", this::chooseNetwork);
        addAction("USB", "See attached USB devices. No device is opened or controlled.", "View USB devices", this::showUsb);
        addAction("Sensors", "See available motion and environment sensors, then select one to read.", "Explore sensors", this::chooseSensor);
        addAction("Location", "Request a current location once. Approximate location is supported.", "Get location", this::requestLocation);
        TextView boundary = text("Discovery does not authorize movement. Robot control requires a device-specific driver, authenticated connection and emergency stop.", 13); boundary.setPadding(0, dp(16), 0, dp(12)); cards.addView(boundary);
        status = text("Nothing is active", 15); status.setTypeface(Typeface.DEFAULT_BOLD); status.setPadding(0, dp(12), 0, dp(8)); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); cards.addView(status);
        results = text("", 14); results.setTextIsSelectable(true); results.setPadding(0, 0, 0, dp(16)); cards.addView(results);
        LinearLayout footer = new LinearLayout(this); footer.setPadding(0, dp(8), 0, 0);
        Button stop = button("Stop all", true); stop.setOnClickListener(v -> { stopAll(); status.setText("Stopped"); }); footer.addView(stop, new LinearLayout.LayoutParams(0, dp(50), 1));
        Button settings = button("Permissions", false); settings.setOnClickListener(v -> { stopAll(); startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()))); });
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(0, dp(50), 1); sp.leftMargin = dp(10); footer.addView(settings, sp); root.addView(footer);
        setContentView(root); root.requestApplyInsets();
    }
    private void addAction(String title, String description, String action, Runnable r) {
        LinearLayout card = new LinearLayout(this); card.setOrientation(LinearLayout.VERTICAL); card.setPadding(dp(16), dp(16), dp(16), dp(16)); card.setBackground(rounded(0xfff6f6f6, 20));
        TextView t = text(title, 19); t.setTypeface(Typeface.DEFAULT_BOLD); card.addView(t);
        TextView d = text(description, 14); d.setPadding(0, dp(6), 0, dp(12)); card.addView(d);
        Button b = button(action, true); b.setOnClickListener(v -> r.run()); card.addView(b, new LinearLayout.LayoutParams(-1, dp(48)));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1, -2); p.topMargin = dp(14); cards.addView(card, p);
    }
    private int dp(int n) { return Math.round(getResources().getDisplayMetrics().density * n); }
    private TextView text(String s, int size) { TextView t = new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(0xff181818); t.setLineSpacing(dp(3),1); return t; }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private Button button(String s, boolean primary) {
        Button b = new Button(this); b.setText(s); b.setTextSize(15); b.setAllCaps(false); b.setMinWidth(0); b.setMinimumWidth(0); b.setPadding(dp(12),0,dp(12),0);
        b.setStateListAnimator(null); b.setElevation(0); b.setBackgroundTintList(null); b.setTextColor(primary ? Color.WHITE : Color.BLACK);
        b.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(primary ? 0xff555555 : 0xffdddddd), rounded(primary ? 0xff171717 : 0xffeeeeee, 14), null)); return b;
    }
    @Override protected void onResume() { super.onResume(); foreground = true; }
    @Override protected void onPause() { foreground = false; stopAll(); super.onPause(); }
    @Override protected void onDestroy() { pendingPermission = null; stopAll(); super.onDestroy(); }
    private long begin(String message) { stopAll(); found.clear(); results.setText(""); status.setText(message); status.requestRectangleOnScreen(new android.graphics.Rect(0,0,status.getWidth(),status.getHeight()), false); return session.start(); }
    private void stopAll() {
        session.stop(); main.removeCallbacksAndMessages(null);
        if (scanner != null && scanCallback != null) { try { scanner.stopScan(scanCallback); } catch (RuntimeException ignored) { } }
        scanner = null; scanCallback = null;
        if (nsd != null && discovery != null) { try { nsd.stopServiceDiscovery(discovery); } catch (RuntimeException ignored) { } }
        discovery = null;
        if (multicast != null && multicast.isHeld()) { try { multicast.release(); } catch (RuntimeException ignored) { } }
        multicast = null;
        if (sensors != null && sensorListener != null) sensors.unregisterListener(sensorListener);
        sensorListener = null;
        if (locations != null && locationListener != null) { try { locations.removeUpdates(locationListener); } catch (RuntimeException ignored) { } }
        locationListener = null;
        if (status != null && !foreground) status.setText("Paused — tap an action to start again");
    }
    private boolean granted(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }
    private void permission(String purpose, String[] permissions, Runnable action) {
        if (!foreground || pendingPermission != null) return;
        List<String> missing = new ArrayList<>(); for (String p : permissions) if (!granted(p)) missing.add(p);
        if (missing.isEmpty()) { action.run(); return; }
        stopAll(); permissionPurpose = purpose;
        new AlertDialog.Builder(this).setTitle(purpose).setMessage("Allow access in the next system prompt. You can stop at any time or change access in Permissions.")
            .setNegativeButton("Cancel", null).setPositiveButton("Continue", (d,w) -> { pendingPermission = action; permissionRequests++; requestPermissions(permissions, 1287); }).show();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants); if (requestCode != 1287) return;
        Runnable action = pendingPermission; pendingPermission = null;
        boolean allowed = grants.length > 0;
        for (int g : grants) allowed &= g == PackageManager.PERMISSION_GRANTED;
        if ("Location".equals(permissionPurpose)) allowed = granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION);
        if (allowed) { status.setText("Access granted — tap the action to start"); if (foreground && action != null) action.run(); }
        else { status.setText("Access not granted"); results.setText("Try the action again, or open Permissions to allow access in Android settings."); }
    }
    private void requestBluetooth() { permission("Nearby Bluetooth devices", DeviceAccessPolicy.bluetoothPermissions(Build.VERSION.SDK_INT), this::scanBluetooth); }
    private void scanBluetooth() {
        BluetoothManager manager = (BluetoothManager)getSystemService(BLUETOOTH_SERVICE); BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
        if (adapter == null) { status.setText("Bluetooth is not available on this device"); return; }
        try {
            if (!adapter.isEnabled()) { status.setText("Turn on Bluetooth to discover devices"); startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS)); return; }
            if (Build.VERSION.SDK_INT < 31) {
                LocationManager lm = (LocationManager)getSystemService(LOCATION_SERVICE);
                if (!lm.isProviderEnabled(LocationManager.GPS_PROVIDER) && !lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) { status.setText("Android requires Location to scan Bluetooth on this version"); startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); return; }
            }
            final long token = begin("Scanning Bluetooth · 15 seconds"); scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) { stopAll(); status.setText("Bluetooth scanning is unavailable"); return; }
            scanCallback = new ScanCallback() {
                @Override public void onScanResult(int type, ScanResult result) { main.post(() -> {
                    if (!session.accepts(token)) return;
                    try { String name = result.getDevice().getName(); String address = result.getDevice().getAddress(); if (found.size() >= 60 && !found.containsKey(address)) return;
                        found.put(address, (name == null ? "Unnamed device" : name) + "\n" + address + " · " + result.getRssi() + " dBm"); showFound();
                    } catch (SecurityException e) { stopAll(); status.setText("Bluetooth permission was revoked"); }
                }); }
                @Override public void onScanFailed(int code) { main.post(() -> { if (session.accepts(token)) { stopAll(); status.setText("Bluetooth scan could not start (" + code + ")"); } }); }
            };
            scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_POWER).build(), scanCallback);
            main.postDelayed(() -> { if (session.accepts(token)) { stopAll(); status.setText(found.isEmpty() ? "No Bluetooth LE devices found" : "Bluetooth scan complete"); } }, 15000);
        } catch (RuntimeException e) { stopAll(); status.setText("Bluetooth is unavailable or access was denied"); }
    }
    private void showFound() { results.setText(String.join("\n\n", found.values())); }
    private void chooseNetwork() {
        String[] names = {"HTTP devices", "MQTT devices", "HomeKit accessories"}; String[] types = {"_http._tcp.", "_mqtt._tcp.", "_hap._tcp."};
        new AlertDialog.Builder(this).setTitle("Find a service").setItems(names, (d,w) -> scanNetwork(types[w])).setNegativeButton("Cancel", null).show();
    }
    private void scanNetwork(String type) {
        long token = begin("Finding local services · 15 seconds"); nsd = (NsdManager)getSystemService(NSD_SERVICE);
        if (nsd == null) { stopAll(); status.setText("Local discovery is unavailable"); return; }
        discovery = new NsdManager.DiscoveryListener() {
            public void onDiscoveryStarted(String t) { }
            public void onDiscoveryStopped(String t) { }
            public void onStartDiscoveryFailed(String t, int code) { main.post(() -> { if (session.accepts(token)) { stopAll(); status.setText("Local discovery failed (" + code + ")"); } }); }
            public void onStopDiscoveryFailed(String t, int code) { }
            public void onServiceFound(NsdServiceInfo info) { main.post(() -> {
                if (!session.accepts(token) || found.size() >= 60) return;
                found.put(info.getServiceName(), info.getServiceName() + "\n" + info.getServiceType()); showFound();
            }); }
            public void onServiceLost(NsdServiceInfo info) { main.post(() -> { if (session.accepts(token)) { found.remove(info.getServiceName()); showFound(); } }); }
        };
        try {
            WifiManager wifi = (WifiManager)getApplicationContext().getSystemService(WIFI_SERVICE);
            if (wifi != null) { multicast = wifi.createMulticastLock("ulemi-device-discovery"); multicast.setReferenceCounted(false); multicast.acquire(); }
            nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, discovery);
        }
        catch (RuntimeException e) { stopAll(); status.setText("Local discovery is unavailable or access was denied"); return; }
        main.postDelayed(() -> { if (session.accepts(token)) { stopAll(); status.setText(found.isEmpty() ? "No advertised services found on this network" : "Local discovery complete"); } }, 15000);
    }
    private void showUsb() {
        begin("Attached USB devices"); UsbManager usb = (UsbManager)getSystemService(USB_SERVICE);
        if (usb == null) { stopAll(); status.setText("USB host is not available"); return; }
        for (UsbDevice d : usb.getDeviceList().values()) {
            found.put(d.getDeviceName(), "USB " + String.format(Locale.US,"%04X:%04X", d.getVendorId(), d.getProductId()) + "\n" + d.getInterfaceCount() + " interfaces · " + (usb.hasPermission(d) ? "Access previously granted" : "Not authorized"));
        }
        showFound(); stopAll(); if (found.isEmpty()) results.setText("No USB devices attached. This phone may require a USB host adapter.");
    }
    private void chooseSensor() {
        if (sensors == null) { status.setText("Sensors are not available"); return; }
        List<Sensor> available = sensors.getSensorList(Sensor.TYPE_ALL); List<String> names = new ArrayList<>();
        for (Sensor s : available) names.add(s.getName() + (DeviceAccessPolicy.canReadSensor(s.getType()) ? "" : " · inventory only"));
        if (available.isEmpty()) { status.setText("No sensors are available on this device"); return; }
        new AlertDialog.Builder(this).setTitle("Available sensors").setItems(names.toArray(new String[0]), (d,w) -> readSensor(available.get(w))).setNegativeButton("Cancel", null).show();
    }
    private void readSensor(Sensor sensor) {
        long token = begin(sensor.getName());
        if (!DeviceAccessPolicy.canReadSensor(sensor.getType())) { stopAll(); results.setText(sensor.getVendor() + "\n" + sensor.getStringType() + "\nThis sensor is listed only. No health, activity or private sensor access is requested."); return; }
        results.setText("Waiting for a sensor reading…"); lastSensorUpdate = 0;
        sensorListener = new SensorEventListener() {
            public void onAccuracyChanged(Sensor s, int accuracy) { }
            public void onSensorChanged(SensorEvent event) {
                if (!session.accepts(token) || SystemClock.elapsedRealtime() - lastSensorUpdate < 200) return; lastSensorUpdate = SystemClock.elapsedRealtime();
                StringBuilder values = new StringBuilder(); for (int i = 0; i < event.values.length; i++) values.append(i == 0 ? "" : "\n").append("Component ").append(i + 1).append(": ").append(String.format(Locale.US,"%.3f",event.values[i]));
                results.setText(values + "\n" + DeviceAccessPolicy.unit(sensor.getType()) + "\nAccuracy: " + event.accuracy + "\nUpdated " + new java.text.SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date()) + " · not saved or uploaded");
            }
        };
        try { if (!sensors.registerListener(sensorListener, sensor, SensorManager.SENSOR_DELAY_NORMAL)) { stopAll(); status.setText("This sensor cannot provide a live reading"); } }
        catch (RuntimeException e) { stopAll(); status.setText("Sensor access is unavailable"); }
    }
    private void requestLocation() { permission("Location", DeviceAccessPolicy.locationPermissions(), this::readLocation); }
    private void readLocation() {
        long token = begin("Waiting for current location · up to 30 seconds"); locations = (LocationManager)getSystemService(LOCATION_SERVICE);
        locationListener = new LocationListener() {
            public void onLocationChanged(Location l) { if (!session.accepts(token) || !DeviceAccessPolicy.freshLocation(SystemClock.elapsedRealtimeNanos(), l.getElapsedRealtimeNanos(), l.hasAccuracy(), l.getAccuracy())) return; stopAll(); status.setText("Current location"); results.setText(String.format(Locale.US,"%.5f, %.5f\nAccuracy ±%.0f m\n%s location · not saved or uploaded", l.getLatitude(), l.getLongitude(), l.getAccuracy(), granted(Manifest.permission.ACCESS_FINE_LOCATION) ? "Precise" : "Approximate")); }
            public void onStatusChanged(String p, int s, Bundle e) { }
            public void onProviderEnabled(String p) { }
            public void onProviderDisabled(String p) { }
        };
        try {
            String provider = locations.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER
                : granted(Manifest.permission.ACCESS_FINE_LOCATION) && locations.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER : null;
            if (provider == null) { stopAll(); status.setText("Turn on Location, then try again"); startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); return; }
            locations.requestLocationUpdates(provider, 1000, 0, locationListener, Looper.getMainLooper());
            main.postDelayed(() -> { if (session.accepts(token)) { stopAll(); status.setText("No current location received. Try again outdoors or check Location settings."); } }, 30000);
        } catch (RuntimeException e) { stopAll(); status.setText("Location is unavailable or access was denied"); }
    }
}
