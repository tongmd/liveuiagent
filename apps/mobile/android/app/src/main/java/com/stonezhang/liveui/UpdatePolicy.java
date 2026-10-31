package com.stonezhang.liveui;

import java.io.*;
import java.net.URI;
import java.security.MessageDigest;
import java.util.*;

/** Trust and resource limits shared by metadata, download and installation. */
final class UpdatePolicy {
    static final String HOST = "ulemi-updates.pages.dev";
    static final String MANIFEST = "https://" + HOST + "/android/latest.json";
    static final String PACKAGE = "com.stonezhang.liveui";
    static final long MAX_APK = 128L * 1024 * 1024;
    static URI trustedUrl(String value, boolean apk) {
        URI u;
        try { u = URI.create(value); } catch (Exception e) { throw new IllegalArgumentException("Invalid update URL"); }
        String path = u.getRawPath();
        if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost()) || u.getUserInfo() != null
                || (u.getPort() != -1 && u.getPort() != 443) || u.getRawQuery() != null || u.getRawFragment() != null
                || path == null || path.contains("%") || path.contains("..")
                || (apk ? !path.matches("/android/releases/[A-Za-z0-9._-]+\\.apk") : !"/android/latest.json".equals(path)))
            throw new IllegalArgumentException("Untrusted update URL");
        return u;
    }
    static void metadata(String pkg, long version, String name, int sdk, long size, String hash) {
        if (!PACKAGE.equals(pkg) || version <= 0 || version > Integer.MAX_VALUE || name == null
                || !name.matches("[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}") || sdk < 26 || sdk > 100
                || size < 1024 || size > MAX_APK || hash == null || !hash.matches("[a-f0-9]{64}"))
            throw new IllegalArgumentException("Invalid update metadata");
    }
    static String sha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] b = new byte[65536]; int n; while ((n = in.read(b)) != -1) md.update(b, 0, n); }
        StringBuilder out = new StringBuilder(); for (byte b : md.digest()) out.append(String.format(Locale.ROOT, "%02x", b & 255)); return out.toString();
    }
    static void verifyFile(File file, long size, String hash) throws Exception {
        if (!file.isFile() || file.length() != size || !hash.equals(sha256(file))) throw new IOException("Update file verification failed");
    }
    static boolean sameSigners(byte[][] installed, byte[][] candidate) {
        if (installed == null || candidate == null || installed.length == 0 || installed.length != candidate.length) return false;
        Set<String> a = new HashSet<>(), b = new HashSet<>();
        for (byte[] item : installed) a.add(Base64.getEncoder().encodeToString(item));
        for (byte[] item : candidate) b.add(Base64.getEncoder().encodeToString(item));
        return a.size() == installed.length && b.size() == candidate.length && a.equals(b);
    }
}
