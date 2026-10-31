package com.stonezhang.liveui;
import java.util.*;
public final class DeviceAccessPolicyTest {
    private static int count;
    private static void check(boolean value) { count++; if (!value) throw new AssertionError("Device access check " + count); }
    public static void main(String[] args) {
        check(Arrays.equals(DeviceAccessPolicy.bluetoothPermissions(26), new String[]{"android.permission.ACCESS_FINE_LOCATION"}));
        check(Arrays.equals(DeviceAccessPolicy.bluetoothPermissions(30), new String[]{"android.permission.ACCESS_FINE_LOCATION"}));
        check(Arrays.equals(DeviceAccessPolicy.bluetoothPermissions(31), new String[]{"android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"}));
        check(Arrays.equals(DeviceAccessPolicy.bluetoothPermissions(33), DeviceAccessPolicy.bluetoothPermissions(31)));
        check(Arrays.equals(DeviceAccessPolicy.bluetoothPermissions(35), DeviceAccessPolicy.bluetoothPermissions(31)));
        check(Arrays.equals(DeviceAccessPolicy.locationPermissions(), new String[]{"android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"}));
        for (int t : new int[]{1,2,4,5,6,8,9,10,11,12,13,14,15,16}) check(DeviceAccessPolicy.canReadSensor(t));
        for (int t : new int[]{-1,17,18,19,20,21,34,65536}) check(!DeviceAccessPolicy.canReadSensor(t));
        DeviceAccessPolicy.Session session = new DeviceAccessPolicy.Session();
        check(!session.active()); long first = session.start(); check(session.active() && session.accepts(first));
        session.stop(); check(!session.active() && !session.accepts(first)); long second = session.start(); check(second != first && !session.accepts(first) && session.accepts(second));
        session.stop(); session.stop(); check(!session.accepts(second));
        check("m/s²".equals(DeviceAccessPolicy.unit(1))); check("components".equals(DeviceAccessPolicy.unit(11)));
        check(DeviceAccessPolicy.freshLocation(40_000_000_000L, 35_000_000_000L, true, 100));
        check(!DeviceAccessPolicy.freshLocation(40_000_000_000L, 1, true, 5));
        check(!DeviceAccessPolicy.freshLocation(40_000_000_000L, 41_000_000_000L, true, 5));
        check(!DeviceAccessPolicy.freshLocation(40, 30, false, 5));
        check(!DeviceAccessPolicy.freshLocation(40, 30, true, Float.NaN));
        System.out.println("Device access policy: " + count + " checks passed");
    }
}
