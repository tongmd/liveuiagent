package com.stonezhang.liveui;

import java.io.*;
import java.net.*;
import java.nio.channels.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

/** Pinned official Google AI Edge distribution; a partial download is never a runnable model. */
public final class LocalModelFile {
    public static final String NAME = "Gemma 4 E4B";
    public static final long SIZE = 3659530240L;
    public static final String SHA256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0";
    public static final String URL = "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/e6a3892a8c22cf87ff99583996149cf3cb32452b/gemma-4-E4B-it.litertlm";
    public static final String SOURCE = "https://developers.google.com/edge/litert-lm/models/gemma-4";
    public static final long RESERVE = 512L * 1024 * 1024;
    interface Connector { HttpsURLConnection open(String url) throws IOException; }
    public interface Progress { void changed(long bytes, boolean verifying); }
    private final File directory;
    private final Connector connector;
    private final String source, hash;
    private final long size;
    private volatile HttpsURLConnection connection;
    public LocalModelFile(File directory) { this(directory, URL, SIZE, SHA256, u -> (HttpsURLConnection)new java.net.URL(u).openConnection()); }
    LocalModelFile(File directory, String source, long size, String hash, Connector connector) {
        this.directory = directory; this.source = source; this.size = size; this.hash = hash; this.connector = connector;
    }
    public File model() { return new File(directory, "gemma-4-e4b.litertlm"); }
    private File partial() { return new File(directory, "gemma-4-e4b.part"); }
    public long downloaded() { return partial().length(); }
    public boolean installed() { return model().isFile() && model().length() == size; }
    public void cancel() { HttpsURLConnection c = connection; if (c != null) c.disconnect(); }
    public void delete() throws IOException {
        if (model().exists() && !model().delete()) throw new IOException("无法删除模型");
        if (partial().exists() && !partial().delete()) throw new IOException("无法删除未完成的下载");
    }
    static boolean validRange(String value, long start, long total) {
        if (value == null) return false;
        return value.equals("bytes " + start + "-" + (total - 1) + "/" + total);
    }
    static long requiredSpace(long size, long existing) { return Math.max(0, size - existing) + RESERVE; }
    private static void checkCancelled(AtomicBoolean cancelled) throws InterruptedIOException {
        if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("已暂停下载，可继续");
    }
    public boolean verify(AtomicBoolean cancelled) throws Exception {
        if (!installed()) return false;
        return hash.equals(sha(model(), cancelled));
    }
    private static String sha(File file, AtomicBoolean cancelled) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
            byte[] b = new byte[1024 * 1024]; int n;
            while ((n = in.read(b)) >= 0) { checkCancelled(cancelled); digest.update(b, 0, n); }
        }
        StringBuilder s = new StringBuilder(); for (byte b : digest.digest()) s.append(String.format(Locale.ROOT, "%02x", b & 255)); return s.toString();
    }
    public void download(AtomicBoolean cancelled, Progress progress) throws Exception {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("无法准备模型存储空间");
        try (RandomAccessFile lockFile = new RandomAccessFile(new File(directory, "model.lock"), "rw");
             FileLock lock = lockFile.getChannel().tryLock()) {
            if (lock == null) throw new IOException("另一个下载正在进行");
            if (installed()) { progress.changed(size, true); if (verify(cancelled)) return; if (!model().delete()) throw new IOException("模型损坏，无法重新下载"); }
            long offset = partial().length();
            if (offset > size) { if (!partial().delete()) throw new IOException("无法重置下载"); offset = 0; }
            if (directory.getUsableSpace() < requiredSpace(size, offset)) throw new IOException("存储空间不足，请再腾出 " + String.format(Locale.ROOT, "%.1f GB", requiredSpace(size, offset) / 1e9));
            if (offset < size) {
                String address = source;
                for (int redirects = 0; ; redirects++) {
                    checkCancelled(cancelled);
                    if (redirects > 8 || !"https".equals(new URI(address).getScheme())) throw new IOException("模型下载地址不安全或跳转过多");
                    HttpsURLConnection c = connector.open(address); connection = c;
                    c.setConnectTimeout(20000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false);
                    c.setRequestProperty("Accept-Encoding", "identity");
                    if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
                    int code = c.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String location = c.getHeaderField("Location"); c.disconnect();
                        if (location == null) throw new IOException("模型下载跳转缺少地址");
                        address = new URI(address).resolve(location).toString(); continue;
                    }
                    if (code != 200 && code != 206) { c.disconnect(); throw new IOException("官方模型下载暂不可用（HTTP " + code + "），稍后继续"); }
                    if (code == 200) offset = 0;
                    if (code == 206 && !validRange(c.getHeaderField("Content-Range"), offset, size)) { c.disconnect(); throw new IOException("下载分段不匹配，未写入模型"); }
                    long length = c.getContentLengthLong();
                    if (length >= 0 && length != size - offset) { c.disconnect(); throw new IOException("模型下载大小不匹配"); }
                    try (InputStream in = c.getInputStream(); RandomAccessFile out = new RandomAccessFile(partial(), "rw")) {
                        if (offset == 0) out.setLength(0); out.seek(offset);
                        byte[] b = new byte[128 * 1024]; int n; long last = 0;
                        while ((n = in.read(b)) >= 0) {
                            checkCancelled(cancelled);
                            if (offset + n > size) throw new IOException("下载内容超出模型大小");
                            out.write(b, 0, n); offset += n;
                            long now = System.nanoTime(); if (now - last > 250000000L) { progress.changed(offset, false); last = now; }
                        }
                        out.getFD().sync();
                    } finally { c.disconnect(); connection = null; }
                    break;
                }
            }
            checkCancelled(cancelled);
            if (partial().length() != size) throw new IOException("网络中断，已保存下载进度，请继续");
            progress.changed(size, true);
            if (!hash.equals(sha(partial(), cancelled))) { partial().delete(); throw new IOException("模型校验失败，请重新下载"); }
            checkCancelled(cancelled);
            Files.move(partial().toPath(), model().toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { HttpsURLConnection c = connection; connection = null; if (c != null) c.disconnect(); }
    }
}
