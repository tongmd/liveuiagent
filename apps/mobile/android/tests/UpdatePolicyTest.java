package com.stonezhang.liveui;
import java.io.*;
import java.nio.file.*;
public final class UpdatePolicyTest {
    interface Throwing { void run() throws Exception; }
    static int passed;
    static void ok(boolean value) { if (!value) throw new AssertionError(); passed++; }
    static void reject(Throwing action) throws Exception { boolean rejected = false; try { action.run(); } catch (Exception expected) { rejected = true; } ok(rejected); }
    public static void main(String[] args) throws Exception {
        ok(UpdatePolicy.trustedUrl(UpdatePolicy.MANIFEST, false).getHost().equals(UpdatePolicy.HOST));
        ok(UpdatePolicy.trustedUrl("https://ulemi-updates.pages.dev/android/releases/Ulemi-0.3.3-6.apk", true) != null);
        for (String url : new String[]{"http://ulemi-updates.pages.dev/android/latest.json", "https://ulemi-updates.pages.dev.evil.test/android/latest.json", "https://evil.test@ulemi-updates.pages.dev/android/latest.json", "https://ulemi-updates.pages.dev:8443/android/latest.json", "https://ulemi-updates.pages.dev/android/latest.json?key=x", "https://ulemi-updates.pages.dev/android/latest.json#x", "https://ulemi-updates.pages.dev/android/%2e/latest.json"}) reject(() -> UpdatePolicy.trustedUrl(url, false));
        for (String path : new String[]{"/android/releases/../bad.apk", "/android/releases/%2e%2e/bad.apk", "/android/latest.json", "/android/releases/x.apk/other", "/android/releases/x.apk?token=x"}) reject(() -> UpdatePolicy.trustedUrl("https://ulemi-updates.pages.dev"+path, true));
        String hash="0".repeat(64); UpdatePolicy.metadata(UpdatePolicy.PACKAGE,6,"0.3.3",26,2048,hash); passed++;
        reject(() -> UpdatePolicy.metadata("other",6,"0.3.3",26,2048,hash));
        reject(() -> UpdatePolicy.metadata(UpdatePolicy.PACKAGE,0,"0.3.3",26,2048,hash));
        reject(() -> UpdatePolicy.metadata(UpdatePolicy.PACKAGE,6,"0.3.3",26,UpdatePolicy.MAX_APK+1,hash));
        reject(() -> UpdatePolicy.metadata(UpdatePolicy.PACKAGE,6,"0.3.3",26,2048,"bad"));
        reject(() -> UpdatePolicy.metadata(UpdatePolicy.PACKAGE,6,"evil\nname",26,2048,hash));
        ok(UpdatePolicy.sameSigners(new byte[][]{{1},{2}},new byte[][]{{2},{1}}));
        ok(!UpdatePolicy.sameSigners(new byte[][]{{1}},new byte[][]{{2}}));
        ok(!UpdatePolicy.sameSigners(new byte[][]{{1},{1}},new byte[][]{{1},{1}}));
        ok(!UpdatePolicy.sameSigners(new byte[0][],new byte[0][]));
        File f=Files.createTempFile("ulemi-update", ".apk").toFile();
        try { Files.write(f.toPath(),new byte[]{1,2,3});String sha=UpdatePolicy.sha256(f);UpdatePolicy.verifyFile(f,3,sha);passed++;reject(() -> UpdatePolicy.verifyFile(f,4,sha));reject(() -> UpdatePolicy.verifyFile(f,3,hash));Files.write(f.toPath(),new byte[]{1,2,4});reject(() -> UpdatePolicy.verifyFile(f,3,sha)); }
        finally { f.delete(); }
        System.out.println(passed+" update security checks passed");
    }
}
