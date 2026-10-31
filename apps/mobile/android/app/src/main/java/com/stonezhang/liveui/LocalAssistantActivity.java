package com.stonezhang.liveui;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.google.ai.edge.litertlm.*;
import com.google.ai.edge.litertlm.Message;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native, on-device conversation. No web bridge, credentials or cloud inference fallback. */
public final class LocalAssistantActivity extends Activity {
    private static java.lang.ref.WeakReference<LocalAssistantActivity> activeInstance = new java.lang.ref.WeakReference<>(null);
    static boolean isUpdateBlocked() { LocalAssistantActivity a = activeInstance.get(); return a != null && a.busy; }
    private AppUpdater updater;
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor();
    private final ExecutorService worker = WORKER;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private LocalModelFile model;
    private Engine engine;
    private volatile Conversation conversation;
    private volatile boolean busy;
    private boolean closing;
    private boolean historyUnreadable;
    private String unsupported;
    private String backend = "";
    private TextView state, transcript;
    private ProgressBar progress;
    private EditText input;
    private Button prepare, send, stop, clear, remove;
    private ScrollView scroll;
    private static final String DRAFT_STATE = "ulemi.local.draft";
    private JSONArray history = new JSONArray();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        activeInstance = new java.lang.ref.WeakReference<>(this); updater = new AppUpdater(this);
        model = new LocalModelFile(new File(getNoBackupFilesDir(), "local-models"));
        readHistory();
        ActivityManager.MemoryInfo hardware = new ActivityManager.MemoryInfo(); ((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(hardware);
        if (!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a")) unsupported = "This model needs a 64-bit ARM Android device.";
        else if (hardware.totalMem < 7L * 1024 * 1024 * 1024) unsupported = "This model needs an Android phone with at least 8 GB of memory.";
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(NativeStyle.PAPER);
        root.setPadding(dp(20), dp(12), dp(20), dp(12));
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(12) + Math.max(bars.bottom, ime.bottom));
            } else v.setPadding(dp(20), dp(12) + insets.getSystemWindowInsetTop(), dp(20), dp(12) + insets.getSystemWindowInsetBottom());
            if (input != null) {
                int available = v.getHeight() - v.getPaddingTop() - v.getPaddingBottom();
                input.setMaxLines(available > 0 && available < dp(260) ? 1 : 4);
            }
            return insets;
        });
        setContentView(root); root.requestApplyInsets();
        LinearLayout header = row(); header.setPadding(0, 0, 0, dp(12)); Button back = button("Back"); back.setOnClickListener(v -> onBackPressed()); header.addView(back, new LinearLayout.LayoutParams(dp(56), dp(48)));
        TextView title = label("Offline assistant", 17); title.setGravity(Gravity.CENTER); title.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)); header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        clear = button("New chat"); clear.setOnClickListener(v -> new AlertDialog.Builder(this).setMessage("Clear the offline conversation on this phone?").setNegativeButton("Cancel", null).setPositiveButton("Clear", (d,w) -> { history = new JSONArray(); historyUnreadable = false; try { saveHistory(); renderHistory(""); state.setText("Ready for a new conversation."); updateControls(); } catch (Exception e) { state.setText("Could not start a new conversation. Check your storage."); } }).show()); header.addView(clear, new LinearLayout.LayoutParams(dp(80), dp(48))); root.addView(header);
        scroll = new ScrollView(this); scroll.setFillViewport(true);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(content, new ScrollView.LayoutParams(-1, -2));
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        TextView modelLabel = label("Gemma 4 E4B", 16); modelLabel.setTypeface(android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)); modelLabel.setPadding(0, dp(12), 0, dp(10)); content.addView(modelLabel);
        TextView note = label("A private conversation, right on your phone. Download once (3.66 GB), then chat offline. Your cloud apps stay in your workspace.", 14); note.setTextColor(0xff6b6b6b); note.setLineSpacing(dp(3), 1); content.addView(note);
        state = label(model.installed() ? "Ready to chat. The model loads when you send a message." : model.downloaded() > 0 ? "Download paused. Ready to resume." : "Download the model to get started.", 14); state.setTextColor(0xff555555); state.setLineSpacing(dp(3), 1); state.setPadding(0, dp(14), 0, dp(14)); state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); content.addView(state);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(1000); progress.setVisibility(View.GONE); content.addView(progress, new LinearLayout.LayoutParams(-1, dp(4)));
        LinearLayout actions = row(); prepare = button(model.downloaded() > 0 ? "Resume" : "Download", true); prepare.setOnClickListener(v -> confirmDownload()); actions.addView(prepare, new LinearLayout.LayoutParams(0, dp(48), 1));
        stop = button("Pause"); stop.setVisibility(View.GONE); stop.setOnClickListener(v -> cancelWork());
        Button source = button("Model source"); source.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(LocalModelFile.SOURCE)))); LinearLayout.LayoutParams sourceLayout = new LinearLayout.LayoutParams(0, dp(48), 1); sourceLayout.leftMargin = dp(8); actions.addView(source, sourceLayout);
        remove = button("Remove"); remove.setOnClickListener(v -> confirmRemove()); LinearLayout.LayoutParams removeLayout = new LinearLayout.LayoutParams(0, dp(48), 1); removeLayout.leftMargin = dp(8); actions.addView(remove, removeLayout); content.addView(actions);
        transcript = label("", 17); transcript.setTextIsSelectable(true); transcript.setPadding(0, dp(18), 0, dp(18)); transcript.setLineSpacing(dp(4), 1); content.addView(transcript);
        LinearLayout composer = row(); composer.setPadding(0, dp(10), 0, 0); root.addView(composer, new LinearLayout.LayoutParams(-1, -2));
        input = new EditText(this); input.setTextSize(17); input.setHint("Message Gemma"); input.setContentDescription("Offline message"); input.setMaxLines(4); input.setMinLines(1); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES); input.setImeOptions(android.view.inputmethod.EditorInfo.IME_FLAG_NO_EXTRACT_UI); input.setTextColor(0xff181818); input.setHintTextColor(0xff777777); input.setPadding(dp(14), dp(12), dp(14), dp(12)); input.setBackground(rounded(0xffffffff, 18)); composer.addView(input, new LinearLayout.LayoutParams(0, -2, 1));
        if (saved != null) input.setText(saved.getString(DRAFT_STATE, ""));
        send = button("Send", true); send.setOnClickListener(v -> send()); LinearLayout.LayoutParams sendLayout = new LinearLayout.LayoutParams(dp(64), dp(50)); sendLayout.leftMargin = dp(8); composer.addView(send, sendLayout); LinearLayout.LayoutParams stopLayout = new LinearLayout.LayoutParams(dp(64), dp(50)); stopLayout.leftMargin = dp(8); composer.addView(stop, stopLayout);
        renderHistory("");
        if (unsupported != null) state.setText(unsupported);
        else if (historyUnreadable) state.setText("The previous conversation could not be read. Its file is preserved. Start a new chat to continue.");
        updateControls();
    }
    private int dp(int x) { return Math.round(x * getResources().getDisplayMetrics().density); }
    private TextView label(String s, int size) { TextView t = new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(Color.BLACK); return t; }
    private android.graphics.drawable.GradientDrawable rounded(int color, int radius) {
        android.graphics.drawable.GradientDrawable drawable = new android.graphics.drawable.GradientDrawable();
        drawable.setColor(color); drawable.setCornerRadius(dp(radius)); return drawable;
    }
    private Button button(String s) { return button(s, false); }
    private Button button(String s, boolean primary) {
        Button b = NativeStyle.button(this, s, primary); b.setTextSize(13); b.setPadding(dp(8), 0, dp(8), 0); return b;
    }
    private LinearLayout row() { LinearLayout r = new LinearLayout(this); r.setGravity(Gravity.CENTER_VERTICAL); return r; }
    private void post(Runnable r) { ui.post(() -> { if (!closing && !isDestroyed()) r.run(); }); }
    private void updateControls() {
        prepare.setVisibility(!busy && !model.installed() ? View.VISIBLE : View.GONE);
        prepare.setText(model.downloaded() > 0 ? "Resume" : "Download");
        prepare.setEnabled(unsupported == null);
        stop.setVisibility(busy ? View.VISIBLE : View.GONE); stop.setEnabled(busy && !cancelled.get());
        remove.setEnabled(!busy && (model.installed() || model.downloaded() > 0)); clear.setEnabled(!busy);
        send.setVisibility(busy ? View.GONE : View.VISIBLE);
        send.setEnabled(!busy && model.installed() && unsupported == null && !historyUnreadable);
        if (busy) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private void begin(String s, String stopLabel) { busy = true; cancelled.set(false); state.setText(s); stop.setText(stopLabel); updateControls(); }
    private void complete(String s) { post(() -> { busy = false; state.setText(s); progress.setVisibility(View.GONE); updateControls(); }); }
    private void confirmDownload() {
        new AlertDialog.Builder(this).setTitle("Download Gemma 4 E4B")
            .setMessage("Download and verify the 3.66 GB model from the repository linked by Google AI Edge. Use Wi-Fi and keep at least 4.2 GB free. Leaving this screen pauses the download; you can resume anytime.")
            .setNegativeButton("Cancel", null).setPositiveButton("Download", (d,w) -> download()).show();
    }
    private void download() {
        if (busy) return; begin("Downloading…", "Pause"); progress.setVisibility(View.VISIBLE);
        worker.execute(() -> {
            try {
                model.download(cancelled, (bytes, verifying) -> post(() -> { progress.setIndeterminate(verifying); progress.setProgress((int)(bytes * 1000 / LocalModelFile.SIZE)); state.setText(verifying ? "Verifying the model…" : String.format(Locale.getDefault(), "Downloading %.2f / 3.66 GB", bytes / 1e9)); }));
                if (cancelled.get()) { complete("Paused. You can resume anytime."); return; }
                post(() -> { progress.setIndeterminate(true); state.setText("Verified. Setting up the model…"); });
                loadModel(false); complete("Ready · " + backend);
            } catch (Exception | LinkageError e) { complete(cancelled.get() ? "Paused. You can resume anytime." : readable(e)); }
        });
    }
    private void loadModel(boolean verify) throws Exception {
        if (engine != null) return;
        if (verify && !model.verify(cancelled)) { model.delete(); throw new IOException("Model verification failed. Please download again."); }
        if (cancelled.get()) throw new InterruptedIOException("Stopped.");
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); ((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(memory);
        if (memory.lowMemory) throw new IOException("Memory is low. Close other apps and try again.");
        Engine candidate = null;
        try {
            candidate = new Engine(new EngineConfig(model.model().getAbsolutePath(), new Backend.GPU(), null, null, 4096, null, getCacheDir().getAbsolutePath()));
            candidate.initialize(); engine = candidate; backend = "GPU";
        } catch (Exception | LinkageError failure) {
            if (candidate != null) try { candidate.close(); } catch (Exception ignored) {}
            if (cancelled.get()) throw new InterruptedIOException("Stopped.");
            post(() -> state.setText("Loading on CPU. This may take a moment…"));
            candidate = new Engine(new EngineConfig(model.model().getAbsolutePath(), new Backend.CPU(), null, null, 4096, null, getCacheDir().getAbsolutePath()));
            try { candidate.initialize(); engine = candidate; backend = "CPU"; }
            catch (Exception | LinkageError e) { try { candidate.close(); } catch (Exception ignored) {} throw e; }
        }
        if (cancelled.get()) { closeEngine(); throw new InterruptedIOException("Stopped."); }
    }
    private void send() {
        String prompt = input.getText().toString().trim(); if (busy || prompt.isEmpty()) return;
        if (prompt.getBytes(StandardCharsets.UTF_8).length > 2000) { state.setText("This message is too long. Please split it into shorter messages."); return; }
        begin(engine == null ? "Loading the model…" : "Thinking…", "Stop"); input.setText("");
        renderHistory("You\n" + prompt + "\n\nGemma\n");
        worker.execute(() -> {
            StringBuilder answer = new StringBuilder();
            try {
                loadModel(true); if (cancelled.get()) throw new InterruptedIOException();
                List<Message> previous = new ArrayList<>(); int first = history.length(), contextBytes = 0;
                // Include complete recent turns only; conservative UTF-8 byte budget stays below token capacity.
                for (int i = history.length() - 2; i >= Math.max(0, history.length() - 6); i -= 2) {
                    int bytes = history.getJSONObject(i).getString("text").getBytes(StandardCharsets.UTF_8).length + history.getJSONObject(i+1).getString("text").getBytes(StandardCharsets.UTF_8).length;
                    if (contextBytes + bytes > 1000) break; contextBytes += bytes; first = i;
                }
                for (int i = first; i < history.length(); i++) { JSONObject h = history.getJSONObject(i); previous.add("user".equals(h.getString("role")) ? Message.Companion.user(h.getString("text")) : Message.Companion.model(h.getString("text"))); }
                ConversationConfig config = new ConversationConfig(Contents.Companion.of("You are Ulemi's offline assistant. Reply concisely in the user's language. You can only work with text in this conversation. You cannot access the internet or operate cloud apps."), previous, Collections.emptyList(), null, false, Collections.emptyList(), Collections.emptyMap(), null, false, 512);
                conversation = engine.createConversation(config);
                if (cancelled.get()) throw new InterruptedIOException("Stopped.");
                CountDownLatch done = new CountDownLatch(1); Throwable[] error = {null};
                conversation.sendMessageAsync(prompt, new MessageCallback() {
                    public void onMessage(Message message) {
                        for (Content c : message.getContents().getContents()) if (c instanceof Content.Text) answer.append(((Content.Text)c).getText());
                        String result = answer.toString(); post(() -> { state.setText("Replying · " + backend); renderHistory("You\n" + prompt + "\n\nGemma\n" + result); });
                    }
                    public void onDone() { done.countDown(); }
                    public void onError(Throwable e) { error[0] = e; done.countDown(); }
                });
                if (cancelled.get()) conversation.cancelProcess();
                // Wait for the actual native terminal callback, including after cancellation.
                if (!done.await(180, TimeUnit.SECONDS)) {
                    cancelled.set(true); conversation.cancelProcess();
                    post(() -> { state.setText("The reply timed out. Stopping…"); updateControls(); });
                    done.await();
                }
                if (cancelled.get()) throw new InterruptedIOException("Stopped.");
                if (error[0] != null) throw new IOException("The model did not finish. Start a new chat and try again.", error[0]);
                if (answer.toString().trim().isEmpty()) throw new IOException("No reply was returned. Try rephrasing your message.");
                history.put(new JSONObject().put("role", "user").put("text", prompt)); history.put(new JSONObject().put("role", "model").put("text", answer.toString()));
                while (history.length() > 40) history.remove(0);
                saveHistory(); post(() -> renderHistory("")); complete("Saved on this phone · " + backend);
            } catch (Exception | LinkageError e) {
                complete(cancelled.get() ? "Stopped. The unfinished reply was not saved." : readable(e));
                post(() -> { if (input.length() == 0) input.setText(prompt); });
            } finally { Conversation c = conversation; conversation = null; if (c != null) try { c.close(); } catch (Exception ignored) {} }
        });
    }
    private String readable(Throwable e) {
        if ((e instanceof IOException || e instanceof IllegalStateException) && e.getMessage() != null && "The conversation could not be saved on this phone.".equals(e.getMessage())) return e.getMessage();
        if (e instanceof IOException && e.getMessage() != null && (LocalModelFile.isUserMessage(e.getMessage()) || java.util.Arrays.asList("Memory is low. Close other apps and try again.", "The model did not finish. Start a new chat and try again.", "No reply was returned. Try rephrasing your message.").contains(e.getMessage()))) return e.getMessage();
        if (e instanceof IOException) return "Connection interrupted. Download progress is saved. Check your connection to resume.";
        return "The model could not run on this device. Close other apps and try again. Your download is preserved.";
    }
    private void cancelWork() {
        cancelled.set(true); model.cancel(); Conversation c = conversation; if (c != null) c.cancelProcess();
        state.setText("Stopping…"); updateControls();
    }
    private void closeEngine() { if (engine != null) { try { engine.close(); } catch (Exception ignored) {} engine = null; } }
    private void confirmRemove() {
        new AlertDialog.Builder(this).setMessage("Remove the model and partial download to free up space? Your conversations stay saved.").setNegativeButton("Cancel", null).setPositiveButton("Remove", (d,w) -> {
            if (busy) return; begin("Releasing the model…", "Stop"); worker.execute(() -> { try { closeEngine(); model.delete(); complete("Model removed."); } catch (Exception e) { complete(readable(e)); } });
        }).show();
    }
    private File historyFile() { return new File(getNoBackupFilesDir(), "local-chat.json"); }
    private void readHistory() {
        try {
            if (!historyFile().isFile()) return;
            if (historyFile().length() > 2 * 1024 * 1024) throw new IOException("History is too large.");
            history = new JSONArray(new String(java.nio.file.Files.readAllBytes(historyFile().toPath()), StandardCharsets.UTF_8));
            if (history.length() > 40 || history.length() % 2 != 0) throw new IOException("History is incomplete.");
            for (int i = 0; i < history.length(); i++) {
                JSONObject h = history.getJSONObject(i);
                if (!(i % 2 == 0 ? "user" : "model").equals(h.getString("role")) || !(h.get("text") instanceof String)) throw new IOException("History is incomplete.");
            }
        } catch (Exception ignored) { historyUnreadable = true; history = new JSONArray(); }
    }
    private void saveHistory() {
        try { android.util.AtomicFile f = new android.util.AtomicFile(historyFile()); FileOutputStream out = f.startWrite(); try { out.write(history.toString().getBytes(StandardCharsets.UTF_8)); f.finishWrite(out); } catch (Exception e) { f.failWrite(out); throw e; } }
        catch (Exception e) { throw new IllegalStateException("The conversation could not be saved on this phone.", e); }
    }
    private void renderHistory(String suffix) {
        StringBuilder s = new StringBuilder(); for (int i = 0; i < history.length(); i++) { JSONObject h = history.optJSONObject(i); if (h != null) s.append("user".equals(h.optString("role")) ? "You\n" : "Gemma\n").append(h.optString("text")).append("\n\n"); }
        transcript.setText(s.append(suffix).toString()); scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }
    @Override protected void onSaveInstanceState(Bundle out) {
        if (input != null) out.putString(DRAFT_STATE, input.getText().toString());
        super.onSaveInstanceState(out);
    }
    @Override protected void onStop() { super.onStop(); if (busy) cancelWork(); }
    @Override public void onBackPressed() { if (busy) { cancelWork(); new AlertDialog.Builder(this).setMessage("Stopping. You can go back when this finishes. Download progress is saved.").setPositiveButton("OK", null).show(); } else super.onBackPressed(); }
    @Override protected void onResume() { super.onResume(); if (updater != null) updater.resume(); }
    @Override protected void onPause() { if (updater != null) updater.pause(); super.onPause(); }
    @Override protected void onDestroy() { closing = true; cancelled.set(true); model.cancel(); Conversation c = conversation; if (c != null) c.cancelProcess(); worker.execute(this::closeEngine); super.onDestroy(); }
}
