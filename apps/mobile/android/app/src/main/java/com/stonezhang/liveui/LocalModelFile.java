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
    static boolean isUserMessage(String message) {
        if (message == null) return false;
        return java.util.Arrays.asList(
            "Could not remove the model.", "Could not remove the partial download.",
            "Download paused. You can resume anytime.", "Could not prepare model storage.",
            "Another download is already running.", "The model is damaged and could not be replaced.",
            "Could not restart the download.", "The model download could not be verified.",
            "The download address is unavailable.", "Download range mismatch. The model was not changed.",
            "The download size does not match.", "The download exceeds the expected size.",
            "Connection interrupted. Your download is saved and can resume.",
            "Model verification failed. Please download again.").contains(message)
            || message.matches("Free up additional storage: [0-9]+\\.[0-9] GB")
            || message.matches("The official download is unavailable \\(HTTP [0-9]{3}\\). Please resume later\\.");
    }
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
        if (model().exists() && !model().delete()) throw new IOException("Could not remove the model.");
        if (partial().exists() && !partial().delete()) throw new IOException("Could not remove the partial download.");
    }
    static boolean validRange(String value, long start, long total) {
        if (value == null) return false;
        return value.equals("bytes " + start + "-" + (total - 1) + "/" + total);
    }
    static long requiredSpace(long size, long existing) { return Math.max(0, size - existing) + RESERVE; }
    private static void checkCancelled(AtomicBoolean cancelled) throws InterruptedIOException {
        if (cancelled.get() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("Download paused. You can resume anytime.");
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
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Could not prepare model storage.");
        try (RandomAccessFile lockFile = new RandomAccessFile(new File(directory, "model.lock"), "rw");
             FileLock lock = lockFile.getChannel().tryLock()) {
            if (lock == null) throw new IOException("Another download is already running.");
            if (installed()) { progress.changed(size, true); if (verify(cancelled)) return; if (!model().delete()) throw new IOException("The model is damaged and could not be replaced."); }
            long offset = partial().length();
            if (offset > size) { if (!partial().delete()) throw new IOException("Could not restart the download."); offset = 0; }
            if (directory.getUsableSpace() < requiredSpace(size, offset)) throw new IOException("Free up additional storage: " + String.format(Locale.ROOT, "%.1f GB", requiredSpace(size, offset) / 1e9));
            if (offset < size) {
                String address = source;
                for (int redirects = 0; ; redirects++) {
                    checkCancelled(cancelled);
                    if (redirects > 8 || !"https".equals(new URI(address).getScheme())) throw new IOException("The model download could not be verified.");
                    HttpsURLConnection c = connector.open(address); connection = c;
                    c.setConnectTimeout(20000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false);
                    c.setRequestProperty("Accept-Encoding", "identity");
                    if (offset > 0) c.setRequestProperty("Range", "bytes=" + offset + "-");
                    int code = c.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String location = c.getHeaderField("Location"); c.disconnect();
                        if (location == null) throw new IOException("The download address is unavailable.");
                        address = new URI(address).resolve(location).toString(); continue;
                    }
                    if (code != 200 && code != 206) { c.disconnect(); throw new IOException("The official download is unavailable (HTTP " + code + "). Please resume later."); }
                    if (code == 200) offset = 0;
                    if (code == 206 && !validRange(c.getHeaderField("Content-Range"), offset, size)) { c.disconnect(); throw new IOException("Download range mismatch. The model was not changed."); }
                    long length = c.getContentLengthLong();
                    if (length >= 0 && length != size - offset) { c.disconnect(); throw new IOException("The download size does not match."); }
                    try (InputStream in = c.getInputStream(); RandomAccessFile out = new RandomAccessFile(partial(), "rw")) {
                        if (offset == 0) out.setLength(0); out.seek(offset);
                        byte[] b = new byte[128 * 1024]; int n; long last = 0;
                        while ((n = in.read(b)) >= 0) {
                            checkCancelled(cancelled);
                            if (offset + n > size) throw new IOException("The download exceeds the expected size.");
                            out.write(b, 0, n); offset += n;
                            long now = System.nanoTime(); if (now - last > 250000000L) { progress.changed(offset, false); last = now; }
                        }
                        out.getFD().sync();
                    } finally { c.disconnect(); connection = null; }
                    break;
                }
            }
            checkCancelled(cancelled);
            if (partial().length() != size) throw new IOException("Connection interrupted. Your download is saved and can resume.");
            progress.changed(size, true);
            if (!hash.equals(sha(partial(), cancelled))) { partial().delete(); throw new IOException("Model verification failed. Please download again."); }
            checkCancelled(cancelled);
            Files.move(partial().toPath(), model().toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally { HttpsURLConnection c = connection; connection = null; if (c != null) c.disconnect(); }
    }
}
