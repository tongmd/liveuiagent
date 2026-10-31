package com.stonezhang.liveui;

/** Foreground discovery only. No generated web content can invoke these capabilities. */
public final class DeviceAccessPolicy {
    private DeviceAccessPolicy() { }
    public static String[] bluetoothPermissions(int sdk) {
        return sdk >= 31 ? new String[]{"android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"}
                : new String[]{"android.permission.ACCESS_FINE_LOCATION"};
    }
    public static String[] locationPermissions() {
        return new String[]{"android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"};
    }
    public static boolean canReadSensor(int type) {
        // Android public sensor IDs: no body, health, step/activity or vendor-private sensors.
        return type == 1 || type == 2 || type == 4 || type == 5 || type == 6 || type == 8 || type == 9
                || type == 10 || type == 11 || type == 12 || type == 13 || type == 14 || type == 15 || type == 16;
    }
    public static String unit(int type) {
        switch (type) {
            case 1: case 9: case 10: return "m/s²";
            case 2: case 14: return "µT";
            case 4: case 16: return "rad/s";
            case 5: return "lx";
            case 6: return "hPa";
            case 8: return "cm";
            case 12: return "% RH";
            case 13: return "°C";
            default: return "components";
        }
    }
    public static boolean freshLocation(long nowNanos, long fixNanos, boolean hasAccuracy, float accuracy) {
        return fixNanos > 0 && nowNanos >= fixNanos && nowNanos - fixNanos <= 30_000_000_000L
                && hasAccuracy && Float.isFinite(accuracy) && accuracy >= 0;
    }
    public static final class Session {
        private long generation;
        private boolean active;
        public long start() { active = true; return ++generation; }
        public void stop() { active = false; generation++; }
        public boolean accepts(long token) { return active && token == generation; }
        public boolean active() { return active; }
    }
}
