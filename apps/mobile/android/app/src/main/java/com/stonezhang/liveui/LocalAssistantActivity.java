package com.stonezhang.liveui;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.google.ai.edge.litertlm.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Native, on-device conversation. No web bridge, credentials or cloud inference fallback. */
public final class LocalAssistantActivity extends Activity {
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
    private JSONArray history = new JSONArray();

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        model = new LocalModelFile(new File(getNoBackupFilesDir(), "local-models"));
        readHistory();
        ActivityManager.MemoryInfo hardware = new ActivityManager.MemoryInfo(); ((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(hardware);
        if (!Arrays.asList(Build.SUPPORTED_ABIS).contains("arm64-v8a")) unsupported = "此模型需要 64 位 ARM 安卓设备";
        else if (hardware.totalMem < 7L * 1024 * 1024 * 1024) unsupported = "此模型需要至少 8 GB 内存的安卓手机";
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.WHITE);
        root.setPadding(dp(20), dp(12), dp(20), dp(12));
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(12) + Math.max(bars.bottom, ime.bottom));
            } else v.setPadding(dp(20), dp(12) + insets.getSystemWindowInsetTop(), dp(20), dp(12) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root); root.requestApplyInsets();
        LinearLayout header = row(); Button back = button("返回"); back.setOnClickListener(v -> onBackPressed()); header.addView(back);
        TextView title = label("离线助手", 23); header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        clear = button("新对话"); clear.setOnClickListener(v -> new AlertDialog.Builder(this).setMessage("清空这台手机上的离线对话？").setNegativeButton("取消", null).setPositiveButton("清空", (d,w) -> { history = new JSONArray(); historyUnreadable = false; try { saveHistory(); renderHistory(""); state.setText("新对话已准备好"); updateControls(); } catch (Exception e) { state.setText("无法创建新对话，请检查手机存储空间"); } }).show()); header.addView(clear); root.addView(header);
        TextView modelLabel = label("Gemma 4 E4B · 设备本地运行", 16); modelLabel.setPadding(0, dp(12), 0, dp(4)); root.addView(modelLabel);
        TextView note = label("首次下载 3.66 GB，之后无需联网。对话仅留在此手机；云端应用仍在原工作区使用。", 14); note.setTextColor(0xff666666); root.addView(note);
        state = label(model.installed() ? "模型已下载，发送消息时自动加载" : model.downloaded() > 0 ? "下载已暂停，可以继续" : "下载后即可开始", 14); state.setPadding(0, dp(10), 0, dp(6)); state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(state);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); progress.setMax(1000); progress.setVisibility(View.GONE); root.addView(progress, new LinearLayout.LayoutParams(-1, dp(4)));
        LinearLayout actions = row(); prepare = button(model.downloaded() > 0 ? "继续下载" : "下载并配置"); prepare.setOnClickListener(v -> confirmDownload()); actions.addView(prepare, new LinearLayout.LayoutParams(0, dp(48), 1));
        stop = button("暂停"); stop.setVisibility(View.GONE); stop.setOnClickListener(v -> cancelWork()); actions.addView(stop, new LinearLayout.LayoutParams(0, dp(48), 1));
        Button source = button("官方来源"); source.setOnClickListener(v -> startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(LocalModelFile.SOURCE)))); actions.addView(source, new LinearLayout.LayoutParams(0, dp(48), 1));
        remove = button("删除模型"); remove.setOnClickListener(v -> confirmRemove()); actions.addView(remove, new LinearLayout.LayoutParams(0, dp(48), 1)); root.addView(actions);
        scroll = new ScrollView(this); scroll.setFillViewport(true); transcript = label("", 17); transcript.setTextIsSelectable(true); transcript.setPadding(0, dp(18), 0, dp(18)); transcript.setLineSpacing(dp(4), 1); scroll.addView(transcript); root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        input = new EditText(this); input.setTextSize(17); input.setHint("想聊什么？"); input.setContentDescription("离线消息"); input.setMaxLines(4); input.setMinLines(1); input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES); root.addView(input, new LinearLayout.LayoutParams(-1, -2));
        send = button("发送"); send.setOnClickListener(v -> send()); root.addView(send, new LinearLayout.LayoutParams(-1, dp(50)));
        renderHistory("");
        if (unsupported != null) state.setText(unsupported);
        else if (historyUnreadable) state.setText("旧对话无法读取，原文件已保留。点击新对话后继续。");
        updateControls();
    }
    private int dp(int x) { return Math.round(x * getResources().getDisplayMetrics().density); }
    private TextView label(String s, int size) { TextView t = new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(Color.BLACK); return t; }
    private Button button(String s) { Button b = new Button(this); b.setText(s); b.setTextSize(14); b.setAllCaps(false); b.setMinWidth(0); return b; }
    private LinearLayout row() { LinearLayout r = new LinearLayout(this); r.setGravity(Gravity.CENTER_VERTICAL); return r; }
    private void post(Runnable r) { ui.post(() -> { if (!closing && !isDestroyed()) r.run(); }); }
    private void updateControls() {
        prepare.setVisibility(!busy && !model.installed() ? View.VISIBLE : View.GONE);
        prepare.setText(model.downloaded() > 0 ? "继续下载" : "下载并配置");
        prepare.setEnabled(unsupported == null);
        stop.setVisibility(busy ? View.VISIBLE : View.GONE); stop.setEnabled(busy && !cancelled.get());
        remove.setEnabled(!busy && (model.installed() || model.downloaded() > 0)); clear.setEnabled(!busy);
        send.setEnabled(!busy && model.installed() && unsupported == null && !historyUnreadable);
        if (busy) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
    private void begin(String s, String stopLabel) { busy = true; cancelled.set(false); state.setText(s); stop.setText(stopLabel); updateControls(); }
    private void complete(String s) { post(() -> { busy = false; state.setText(s); progress.setVisibility(View.GONE); updateControls(); }); }
    private void confirmDownload() {
        new AlertDialog.Builder(this).setTitle("下载 Gemma 4 E4B")
            .setMessage("将从 Google AI Edge 官方文档指定的 Hugging Face 仓库下载 3.66 GB 模型并校验完整性。建议使用 Wi-Fi，并至少留出 4.2 GB 空间。离开此页会暂停，可随时继续。")
            .setNegativeButton("取消", null).setPositiveButton("开始下载", (d,w) -> download()).show();
    }
    private void download() {
        if (busy) return; begin("正在下载…", "暂停"); progress.setVisibility(View.VISIBLE);
        worker.execute(() -> {
            try {
                model.download(cancelled, (bytes, verifying) -> post(() -> { progress.setIndeterminate(verifying); progress.setProgress((int)(bytes * 1000 / LocalModelFile.SIZE)); state.setText(verifying ? "正在校验模型…" : String.format(Locale.getDefault(), "正在下载 %.2f / 3.66 GB", bytes / 1e9)); }));
                if (cancelled.get()) { complete("已暂停，稍后可以继续"); return; }
                post(() -> { progress.setIndeterminate(true); state.setText("模型已校验，正在配置…"); });
                loadModel(false); complete("已准备好 · " + backend);
            } catch (Exception | LinkageError e) { complete(cancelled.get() ? "已暂停，稍后可以继续" : readable(e)); }
        });
    }
    private void loadModel(boolean verify) throws Exception {
        if (engine != null) return;
        if (verify && !model.verify(cancelled)) { model.delete(); throw new IOException("模型校验失败，请重新下载"); }
        if (cancelled.get()) throw new InterruptedIOException("已停止");
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo(); ((ActivityManager)getSystemService(ACTIVITY_SERVICE)).getMemoryInfo(memory);
        if (memory.lowMemory) throw new IOException("手机可用内存不足，请先关闭其他应用再试");
        Engine candidate = null;
        try {
            candidate = new Engine(new EngineConfig(model.model().getAbsolutePath(), new Backend.GPU(), null, null, 4096, null, getCacheDir().getAbsolutePath()));
            candidate.initialize(); engine = candidate; backend = "GPU";
        } catch (Exception | LinkageError failure) {
            if (candidate != null) try { candidate.close(); } catch (Exception ignored) {}
            if (cancelled.get()) throw new InterruptedIOException("已停止");
            post(() -> state.setText("此设备改用 CPU，首次加载可能较慢…"));
            candidate = new Engine(new EngineConfig(model.model().getAbsolutePath(), new Backend.CPU(), null, null, 4096, null, getCacheDir().getAbsolutePath()));
            try { candidate.initialize(); engine = candidate; backend = "CPU"; }
            catch (Exception | LinkageError e) { try { candidate.close(); } catch (Exception ignored) {} throw e; }
        }
        if (cancelled.get()) { closeEngine(); throw new InterruptedIOException("已停止"); }
    }
    private void send() {
        String prompt = input.getText().toString().trim(); if (busy || prompt.isEmpty()) return;
        if (prompt.getBytes(StandardCharsets.UTF_8).length > 2000) { state.setText("这条消息太长，请拆成较短的消息再发"); return; }
        begin(engine == null ? "正在校验并加载模型…" : "正在思考…", "停止"); input.setText("");
        renderHistory("你\n" + prompt + "\n\nGemma\n");
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
                ConversationConfig config = new ConversationConfig(Contents.Companion.of("你是 Ulemi 的离线助手。根据用户的语言简洁回答。你只能处理本对话中的文字，不能联网或操作云端应用。"), previous, Collections.emptyList(), null, false, Collections.emptyList(), Collections.emptyMap(), null, false, 512);
                conversation = engine.createConversation(config);
                if (cancelled.get()) throw new InterruptedIOException("已停止");
                CountDownLatch done = new CountDownLatch(1); Throwable[] error = {null};
                conversation.sendMessageAsync(prompt, new MessageCallback() {
                    public void onMessage(Message message) {
                        for (Content c : message.getContents().getContents()) if (c instanceof Content.Text) answer.append(((Content.Text)c).getText());
                        String result = answer.toString(); post(() -> { state.setText("正在回答 · " + backend); renderHistory("你\n" + prompt + "\n\nGemma\n" + result); });
                    }
                    public void onDone() { done.countDown(); }
                    public void onError(Throwable e) { error[0] = e; done.countDown(); }
                });
                if (cancelled.get()) conversation.cancelProcess();
                // Wait for the actual native terminal callback, including after cancellation.
                if (!done.await(180, TimeUnit.SECONDS)) {
                    cancelled.set(true); conversation.cancelProcess();
                    post(() -> { state.setText("回答超时，正在停止…"); updateControls(); });
                    done.await();
                }
                if (cancelled.get()) throw new InterruptedIOException("已停止");
                if (error[0] != null) throw new IOException("模型未完成回答，请新建对话后再试", error[0]);
                if (answer.toString().trim().isEmpty()) throw new IOException("模型未返回文字，请换一种问法");
                history.put(new JSONObject().put("role", "user").put("text", prompt)); history.put(new JSONObject().put("role", "model").put("text", answer.toString()));
                while (history.length() > 40) history.remove(0);
                saveHistory(); post(() -> renderHistory("")); complete("已保存到此手机 · " + backend);
            } catch (Exception | LinkageError e) {
                complete(cancelled.get() ? "已停止，本次未完成的回答没有保存" : readable(e));
                post(() -> { if (input.length() == 0) input.setText(prompt); });
            } finally { Conversation c = conversation; conversation = null; if (c != null) try { c.close(); } catch (Exception ignored) {} }
        });
    }
    private String readable(Throwable e) {
        if ((e instanceof IOException || e instanceof IllegalStateException) && e.getMessage() != null && "对话未能保存到手机".equals(e.getMessage())) return e.getMessage();
        if (e instanceof IOException && e.getMessage() != null) return e.getMessage();
        return "此设备暂时无法运行模型。请关闭其他应用后重试；已下载模型会保留。";
    }
    private void cancelWork() {
        cancelled.set(true); model.cancel(); Conversation c = conversation; if (c != null) c.cancelProcess();
        state.setText("正在停止…"); updateControls();
    }
    private void closeEngine() { if (engine != null) { try { engine.close(); } catch (Exception ignored) {} engine = null; } }
    private void confirmRemove() {
        new AlertDialog.Builder(this).setMessage("删除已下载模型和下载进度，释放空间？对话记录会保留。").setNegativeButton("取消", null).setPositiveButton("删除", (d,w) -> {
            if (busy) return; begin("正在释放模型…", "停止"); worker.execute(() -> { try { closeEngine(); model.delete(); complete("模型已删除"); } catch (Exception e) { complete(readable(e)); } });
        }).show();
    }
    private File historyFile() { return new File(getNoBackupFilesDir(), "local-chat.json"); }
    private void readHistory() {
        try {
            if (!historyFile().isFile()) return;
            if (historyFile().length() > 2 * 1024 * 1024) throw new IOException("记录太大");
            history = new JSONArray(new String(java.nio.file.Files.readAllBytes(historyFile().toPath()), StandardCharsets.UTF_8));
            if (history.length() > 40 || history.length() % 2 != 0) throw new IOException("记录不完整");
            for (int i = 0; i < history.length(); i++) {
                JSONObject h = history.getJSONObject(i);
                if (!(i % 2 == 0 ? "user" : "model").equals(h.getString("role")) || !(h.get("text") instanceof String)) throw new IOException("记录不完整");
            }
        } catch (Exception ignored) { historyUnreadable = true; history = new JSONArray(); }
    }
    private void saveHistory() {
        try { android.util.AtomicFile f = new android.util.AtomicFile(historyFile()); FileOutputStream out = f.startWrite(); try { out.write(history.toString().getBytes(StandardCharsets.UTF_8)); f.finishWrite(out); } catch (Exception e) { f.failWrite(out); throw e; } }
        catch (Exception e) { throw new IllegalStateException("对话未能保存到手机", e); }
    }
    private void renderHistory(String suffix) {
        StringBuilder s = new StringBuilder(); for (int i = 0; i < history.length(); i++) { JSONObject h = history.optJSONObject(i); if (h != null) s.append("user".equals(h.optString("role")) ? "你\n" : "Gemma\n").append(h.optString("text")).append("\n\n"); }
        transcript.setText(s.append(suffix).toString()); scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }
    @Override protected void onStop() { super.onStop(); if (busy) cancelWork(); }
    @Override public void onBackPressed() { if (busy) { cancelWork(); new AlertDialog.Builder(this).setMessage("正在停止，完成后可以返回。下载进度会保留。").setPositiveButton("知道了", null).show(); } else super.onBackPressed(); }
    @Override protected void onDestroy() { closing = true; cancelled.set(true); model.cancel(); Conversation c = conversation; if (c != null) c.cancelProcess(); worker.execute(this::closeEngine); super.onDestroy(); }
}
