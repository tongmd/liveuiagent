package com.stonezhang.liveui;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.text.InputType;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;
import javax.net.ssl.HttpsURLConnection;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 40, SAVE_FILE = 41, DEVICE_ACCESS = 12870;
    private String pendingDeviceObservation, deviceObservationAccount;
    private WebView deviceObservationWeb;
    private static final long MAX_DOWNLOAD = 32L * 1024 * 1024;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private CredentialStore store;
    private static Session currentSession;
    private static final class Session {
        final URI endpoint; final String username, password; final AuthBootstrap authBootstrap;
        Session(URI endpoint, String username, String password) { this.endpoint = endpoint; this.username = username; this.password = password; this.authBootstrap = new AuthBootstrap(endpoint); }
    }
    private LinearLayout root;
    private WebView web;
    private EditText userInput, passwordInput;
    private View loginHeader, loginWaitlist;
    private FrameLayout workspace;
    private LinearLayout handoff;
    private TextView handoffText;
    private Button retryLoad;
    private Dialog guide;
    private boolean loadFailed, restoring, launchHandled;
    private int workspaceAttempt;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView status;
    private View nativeBar;
    private ProgressBar handoffSpinner;
    private Button connect;
    private URI endpoint;
    private String username = "", password = "";
    private boolean authenticated = false;
    private AuthBootstrap authBootstrap;
    private volatile int connectionGeneration = 0;
    private final Object credentialLock = new Object();
    private ValueCallback<Uri[]> upload;
    private File pendingDownload;
    private boolean downloadBusy = false;
    private String blobNonce;
    private String blobFilename;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        store = new CredentialStore(this);
        File[] oldExports = getCacheDir().listFiles((dir, name) -> name.startsWith("liveui-export-") || name.startsWith("liveui-download-"));
        if (oldExports != null) for (File old : oldExports) old.delete();
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        showLaunch();
    }
    private boolean animate() { return android.animation.ValueAnimator.areAnimatorsEnabled(); }
    private void reveal(View view) {
        if (!animate()) return;
        view.setAlpha(0); view.setTranslationY(dp(10));
        view.animate().alpha(1).translationY(0).setDuration(260).start();
    }
    private void showLaunch() {
        root = makeRoot();
        LinearLayout center = new LinearLayout(this); center.setOrientation(LinearLayout.VERTICAL); center.setGravity(Gravity.CENTER);
        root.addView(center, new LinearLayout.LayoutParams(-1, -1));
        ImageView mark = icon(88); center.addView(mark, new LinearLayout.LayoutParams(dp(88), dp(88)));
        TextView word = text("Ulemi", 27, Color.BLACK); word.setPadding(0, dp(18), 0, 0); center.addView(word);
        reveal(center); center.setOnClickListener(v -> restoreAccount());
        ui.postDelayed(this::restoreAccount, animate() ? 420 : 0);
    }
    private void restoreAccount() {
        if (isFinishing() || isDestroyed() || launchHandled) return;
        launchHandled = true;
        // Chromium retains process-local auth through Activity recreation. Never switch accounts here.
        if (currentSession != null && !ConnectionPolicy.DEFAULT_URL.equals(currentSession.endpoint.toString())) { logout(); return; }
        if (currentSession != null) {
            endpoint = currentSession.endpoint; username = currentSession.username; password = currentSession.password;
            authenticated = true; enterAccount(); return;
        }
        try {
            JSONObject saved = store.load();
            if (saved != null && ConnectionPolicy.DEFAULT_URL.equals(saved.optString("url"))) {
                username = saved.getString("user"); password = saved.getString("password");
                showLogin(null); userInput.setText(username); passwordInput.setText(password);
                restoring = true; showRestoring(); connect(); return;
            }
            // A legacy custom endpoint cannot silently receive credentials in this fixed-origin app.
            if (saved != null) store.clear();
            showLogin(null);
        } catch (Exception ignored) { store.clear(); showLogin("请重新登录，继续使用你的应用"); }
    }
    private void showRestoring() {
        root = makeRoot();
        LinearLayout center = new LinearLayout(this); center.setOrientation(LinearLayout.VERTICAL); center.setGravity(Gravity.CENTER);
        root.addView(center, new LinearLayout.LayoutParams(-1, -1)); center.addView(icon(64), new LinearLayout.LayoutParams(dp(64), dp(64)));
        TextView t = text("正在打开你的空间…", 17, 0xff555555); t.setPadding(0, dp(24), 0, 0); center.addView(t);
        ProgressBar progress = new ProgressBar(this); LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(dp(24), dp(24)); pp.topMargin = dp(20); center.addView(progress, pp);
    }
    private ImageView icon(int size) {
        ImageView icon = new ImageView(this); icon.setImageResource(R.drawable.liveui_icon); icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
        icon.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); return icon;
    }
    private TextView text(String value, int size, int color) {
        TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); t.setIncludeFontPadding(false); return t;
    }
    private android.graphics.drawable.GradientDrawable rounded(int color, int radius) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d;
    }
    private Button button(String value, boolean primary) {
        Button b = new Button(this); b.setText(value); b.setAllCaps(false); b.setTextSize(16); b.setTextColor(primary ? Color.WHITE : Color.BLACK);
        b.setBackground(rounded(primary ? 0xff181818 : 0xfff3f3f3, 16)); b.setMinHeight(dp(48)); return b;
    }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private LinearLayout makeRoot() {
        LinearLayout r = new LinearLayout(this); r.setOrientation(LinearLayout.VERTICAL); r.setBackgroundColor(Color.WHITE);
        r.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            boolean keyboardOpen = Build.VERSION.SDK_INT >= 30 ? insets.isVisible(WindowInsets.Type.ime()) : insets.getSystemWindowInsetBottom() > dp(120);
            if (view == root && web == null) {
                if (loginHeader != null) loginHeader.setVisibility(keyboardOpen ? View.GONE : View.VISIBLE);
                if (loginWaitlist != null) loginWaitlist.setVisibility(keyboardOpen ? View.GONE : View.VISIBLE);
            }
            // The native root owns system and IME insets; descendants must not apply them again.
            return Build.VERSION.SDK_INT >= 30 ? WindowInsets.CONSUMED : insets.consumeSystemWindowInsets();
        });
        setContentView(r); r.requestApplyInsets(); return r;
    }
    private EditText input(LinearLayout box, String hint, int type) {
        EditText e = new EditText(this); e.setSingleLine(true); e.setTextSize(17); e.setHint(hint); e.setContentDescription(hint); e.setInputType(type);
        e.setTextColor(Color.BLACK); e.setHintTextColor(0xff777777); e.setPadding(dp(16), 0, dp(16), 0); e.setBackground(rounded(0xfff3f3f3, 14));
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, dp(56)); lp.bottomMargin = dp(10); box.addView(e, lp); return e;
    }
    private void showLogin(String message) {
        restoring = false; root = makeRoot();
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout outer = new LinearLayout(this); outer.setGravity(Gravity.CENTER); outer.setOrientation(LinearLayout.VERTICAL); outer.setPadding(dp(24), dp(20), dp(24), dp(20)); scroll.addView(outer);
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL);
        outer.addView(box, new LinearLayout.LayoutParams(Math.min(getResources().getDisplayMetrics().widthPixels - dp(48), dp(420)), -2));
        LinearLayout header = new LinearLayout(this); header.setOrientation(LinearLayout.VERTICAL); loginHeader = header; box.addView(header);
        header.addView(icon(56), new LinearLayout.LayoutParams(dp(56), dp(56)));
        TextView brand = text("Ulemi", 30, Color.BLACK); brand.setPadding(0, dp(10), 0, dp(8)); header.addView(brand);
        TextView welcome = text("登录，开始创造你的应用", 19, 0xff222222); welcome.setPadding(0, 0, 0, dp(20)); header.addView(welcome);
        userInput = input(box, "账号", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL); userInput.setText(username);
        userInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        passwordInput = input(box, "密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        passwordInput.setOnEditorActionListener((v, action, event) -> { if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE && connect.isEnabled()) { connect(); return true; } return false; });
        CheckBox visible = new CheckBox(this); visible.setText("显示密码"); visible.setTextColor(0xff555555); visible.setTextSize(14);
        visible.setOnCheckedChangeListener((v, checked) -> { passwordInput.setTransformationMethod(checked ? null : android.text.method.PasswordTransformationMethod.getInstance()); passwordInput.setSelection(passwordInput.length()); });
        box.addView(visible, new LinearLayout.LayoutParams(-1, dp(48)));
        connect = button("登录", true); connect.setOnClickListener(v -> connect()); LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(-1, dp(54)); bp.topMargin = dp(8); box.addView(connect, bp);
        status = text(message == null ? "" : message, 14, 0xffad3333); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); status.setPadding(0, dp(14), 0, 0); box.addView(status); status.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
        Button waitlist = button("还没有账号？加入候补名单", false); loginWaitlist = waitlist; waitlist.setTextSize(14); waitlist.setOnClickListener(v -> external("https://docs.google.com/forms/d/e/1FAIpQLSckrULbwm5t1j0UiV7KwVIUwq2-qsMnI4pkikL7Ii1J6K55QA/viewform")); LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(-1, dp(50)); wp.topMargin = dp(12); box.addView(waitlist, wp);
        Button local = button("离线助手 · Gemma 4", false); local.setOnClickListener(v -> startActivity(new Intent(this, LocalAssistantActivity.class)));
        LinearLayout.LayoutParams lpLocal = new LinearLayout.LayoutParams(-1, dp(50)); lpLocal.topMargin = dp(12); box.addView(local, lpLocal);
        Button devices = button("Devices & sensors", false); devices.setOnClickListener(v -> startActivity(new Intent(this, DeviceAccessActivity.class)));
        LinearLayout.LayoutParams lpDevices = new LinearLayout.LayoutParams(-1, dp(50)); lpDevices.topMargin = dp(10); box.addView(devices, lpDevices);
        reveal(box);
    }
    private void enterAccount() {
        if (getSharedPreferences("experience", MODE_PRIVATE).getBoolean("guide_seen_v1", false)) openWorkspace();
        else showGuide();
    }
    private void showGuide() {
        if (guide != null && guide.isShowing()) return;
        guide = new Dialog(this, android.R.style.Theme_Material_Light_NoActionBar);
        guide.setCancelable(true); guide.setOnCancelListener(d -> finishGuide());
        renderGuide(0); guide.show();
        if (guide.getWindow() != null) { guide.getWindow().setStatusBarColor(Color.WHITE); guide.getWindow().setNavigationBarColor(Color.WHITE); guide.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR); }
    }
    private void renderGuide(int step) {
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(Color.WHITE);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(26), dp(18), dp(26), dp(24)); scroll.addView(page);
        LinearLayout top = new LinearLayout(this); top.setGravity(Gravity.CENTER_VERTICAL); top.addView(icon(36), new LinearLayout.LayoutParams(dp(36), dp(36)));
        Space space = new Space(this); top.addView(space, new LinearLayout.LayoutParams(0, 1, 1));
        Button skip = button("跳过", false); skip.setContentDescription("跳过引导"); skip.setOnClickListener(v -> finishGuide()); top.addView(skip, new LinearLayout.LayoutParams(dp(80), dp(48))); page.addView(top);
        Space upper = new Space(this); page.addView(upper, new LinearLayout.LayoutParams(1, dp(24), 1));
        String[] titles = {"说出你需要什么", "边使用，边完善", "回来，接着使用"};
        String[] copy = {"在底部输入需求，Ulemi 会为你创建应用。", "继续告诉它想改什么。功能和界面可以随你的需求调整。", "创建好的应用都在你的空间里。点开它，就能继续使用。"};
        TextView title = text(titles[step], 28, Color.BLACK); title.setTypeface(null, android.graphics.Typeface.BOLD); page.addView(title);
        TextView body = text(copy[step], 17, 0xff555555); body.setLineSpacing(dp(5), 1); body.setPadding(0, dp(16), 0, dp(28)); page.addView(body);
        LinearLayout illustration = new LinearLayout(this); illustration.setOrientation(LinearLayout.VERTICAL); illustration.setPadding(dp(20), dp(22), dp(20), dp(22)); illustration.setBackground(rounded(0xfff5f5f5, 22));
        String[][] examples = {{"我想做一个阅读清单", "说清用途，就可以开始"}, {"把读完的书放在一起", "在原应用里继续修改"}, {"我的应用", "点开应用，接着上次的内容"}};
        for (int i = 0; i < 2; i++) { TextView line = text(examples[step][i], i == 0 ? 19 : 15, i == 0 ? Color.BLACK : 0xff777777); line.setPadding(0, i == 0 ? 0 : dp(14), 0, 0); illustration.addView(line); }
        illustration.setContentDescription("使用方法示意"); page.addView(illustration, new LinearLayout.LayoutParams(-1, -2));
        Space lower = new Space(this); page.addView(lower, new LinearLayout.LayoutParams(1, dp(30), 1));
        LinearLayout dots = new LinearLayout(this); dots.setGravity(Gravity.CENTER); dots.setContentDescription("第 " + (step + 1) + " 步，共 3 步");
        for (int i = 0; i < 3; i++) { View dot = new View(this); dot.setBackground(rounded(i == step ? Color.BLACK : 0xffdddddd, 4)); LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(dp(i == step ? 22 : 7), dp(7)); dl.setMargins(dp(4), 0, dp(4), dp(22)); dots.addView(dot, dl); } page.addView(dots);
        Button next = button(step == 2 ? "开始使用" : "继续", true); next.setOnClickListener(v -> { if (step == 2) finishGuide(); else renderGuide(step + 1); }); page.addView(next, new LinearLayout.LayoutParams(-1, dp(54)));
        guide.setContentView(scroll); reveal(page);
    }
    private void finishGuide() {
        getSharedPreferences("experience", MODE_PRIVATE).edit().putBoolean("guide_seen_v1", true).apply();
        if (guide != null) { guide.dismiss(); guide = null; }
        if (web == null && authenticated) openWorkspace();
    }
    private void connect() {
        final URI candidate;
        final String u = userInput.getText().toString().trim(), p = passwordInput.getText().toString();
        try {
            candidate = ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL);
            if (u.isEmpty() || p.isEmpty() || u.contains(":") || u.contains("\n") || u.contains("\r")) throw new IllegalArgumentException("请输入有效的用户名和密码");
        } catch (Exception e) { status.setText(e.getMessage()); status.setVisibility(View.VISIBLE); return; }
        final int generation; synchronized (credentialLock) { generation = ++connectionGeneration; }
        connect.setEnabled(false); connect.setText("正在登录…"); status.setText(""); status.setVisibility(View.GONE);
        android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE); keyboard.hideSoftInputFromWindow(passwordInput.getWindowToken(), 0);
        network.execute(() -> {
            String error = null;
            try {
                HttpsURLConnection probe = connection(candidate.toString());
                int code = probe.getResponseCode(); String challenge = probe.getHeaderField("WWW-Authenticate"); probe.disconnect();
                if (code != 401 || !ConnectionPolicy.validBasicChallenge(challenge)) throw new IOException("暂时无法登录，请稍后重试");
                HttpsURLConnection check = connection(candidate.toString()); check.setRequestProperty("Authorization", authorization(u, p));
                code = check.getResponseCode(); check.disconnect();
                if (code == 401 || code == 403) throw new IOException("账号或密码不正确，请重新输入");
                if (code != 200) throw new IOException("暂时无法登录，请稍后重试");
                synchronized (credentialLock) {
                    if (generation != connectionGeneration) return;
                    store.save(candidate.toString(), u, p);
                }
            } catch (javax.net.ssl.SSLException e) { error = "暂时无法安全登录，请稍后重试"; }
            catch (Exception e) { error = e instanceof IOException && ("账号或密码不正确，请重新输入".equals(e.getMessage()) || "暂时无法登录，请稍后重试".equals(e.getMessage())) ? e.getMessage() : "网络暂时不可用，请检查网络后重试"; }
            String finalError = error;
            runOnUiThread(() -> {
                if (isFinishing() || generation != connectionGeneration) return;
                connect.setEnabled(true); connect.setText("登录");
                if (finalError != null) { if (restoring) showLogin(finalError); else { status.setText(finalError); status.setVisibility(View.VISIBLE); } return; }
                endpoint = candidate; username = u; password = p; currentSession = new Session(candidate, u, p); authenticated = true; restoring = false; enterAccount();
            });
        });
    }
    private HttpsURLConnection connection(String url) throws IOException {
        HttpsURLConnection c = (HttpsURLConnection) URI.create(url).toURL().openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false); c.setUseCaches(false); return c;
    }
    private String authorization(String u, String p) { return "Basic " + android.util.Base64.encodeToString((u + ":" + p).getBytes(StandardCharsets.UTF_8), android.util.Base64.NO_WRAP); }
    private void openWorkspace() {
        root = makeRoot();
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(12), 0, dp(4), 0);
        TextView title = new TextView(this); title.setText(R.string.app_name); title.setTextSize(18); title.setTextColor(Color.BLACK); bar.addView(title, new LinearLayout.LayoutParams(0, -1, 1));
        Button menu = new Button(this); menu.setText("⋮"); menu.setTextSize(22); menu.setContentDescription("菜单"); menu.setOnClickListener(this::showMenu); bar.addView(menu, new LinearLayout.LayoutParams(dp(52), -1));
        nativeBar = bar;
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(48)));
        workspace = new FrameLayout(this); root.addView(workspace, new LinearLayout.LayoutParams(-1, 0, 1));
        web = new WebView(this); web.setBackgroundColor(Color.WHITE); workspace.addView(web, new FrameLayout.LayoutParams(-1, -1));
        handoff = new LinearLayout(this); handoff.setOrientation(LinearLayout.VERTICAL); handoff.setGravity(Gravity.CENTER); handoff.setPadding(dp(28), dp(28), dp(28), dp(28)); handoff.setBackgroundColor(Color.WHITE);
        handoff.addView(icon(56), new LinearLayout.LayoutParams(dp(56), dp(56)));
        handoffText = text("正在打开你的空间…", 17, 0xff555555); handoffText.setGravity(Gravity.CENTER); handoffText.setPadding(0, dp(22), 0, dp(24)); handoff.addView(handoffText);
        retryLoad = button("重试", true); retryLoad.setVisibility(View.GONE); retryLoad.setOnClickListener(v -> reloadWorkspace()); handoff.addView(retryLoad, new LinearLayout.LayoutParams(dp(180), dp(52)));
        handoffSpinner = new ProgressBar(this); handoffSpinner.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(0xff222222));
        handoff.addView(handoffSpinner, 2, new LinearLayout.LayoutParams(dp(24), dp(24)));
        handoff.setClickable(true); handoff.setFocusable(true);
        workspace.addView(handoff, new FrameLayout.LayoutParams(-1, -1)); loadFailed = false;
        WebSettings settings = web.getSettings(); settings.setUserAgentString(settings.getUserAgentString() + " UlemiMobile/1"); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setSafeBrowsingEnabled(true); settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setBuiltInZoomControls(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        authBootstrap = currentSession.authBootstrap;
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (ConnectionPolicy.sameOrigin(endpoint, url)) return false;
                if (!request.isForMainFrame()) return !url.equals("about:blank");
                external(url); return true;
            }
            @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
                // Only bootstrap the first protected document. Chromium then scopes its auth cache
                // to that exact origin. Subsequent/iframe challenges can never obtain credentials.
                if (authenticated && authBootstrap != null && authBootstrap.take(view.getUrl(), host, realm)) {
                    handler.proceed(username, password);
                } else { handler.cancel(); }
            }
            @Override public void onPageCommitVisible(WebView view, String url) { if (authBootstrap != null) authBootstrap.close(); if (!loadFailed) awaitWorkspace(workspaceAttempt, 0); }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); workspaceError("暂时无法安全打开，请稍后重试", false); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) workspaceError("暂时无法打开，请检查网络后重试", false); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) { boolean expired = response.getStatusCode() == 401 || response.getStatusCode() == 403; workspaceError(expired ? "登录已过期，请重新登录" : "暂时无法打开，请稍后重试", expired); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null); upload = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = params.getAcceptTypes(); if (types != null && types.length > 0 && !types[0].isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, PICK_FILE); } catch (ActivityNotFoundException e) { upload.onReceiveValue(null); upload = null; notice("没有可用的文件选择器"); }
                return true;
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String value, JsPromptResult result) {
                if ("__ulemi_menu_v1__".equals(message)) {
                    result.cancel();
                    if (authenticated && ConnectionPolicy.sameOrigin(endpoint, url) && ConnectionPolicy.sameOrigin(endpoint, view.getUrl())) showAccountMenu();
                    return true;
                }
                if (!"liveui.export.v1".equals(message)) return false;
                result.cancel();
                if (blobNonce == null || !ConnectionPolicy.sameOrigin(endpoint, url)) return true;
                try {
                    if (value == null || value.length() > 12 * 1024 * 1024) throw new IOException();
                    JSONObject payload = new JSONObject(value);
                    if (!blobNonce.equals(payload.optString("nonce"))) return true;
                    blobNonce = null;
                    if (payload.has("error")) throw new IOException();
                    byte[] bytes = android.util.Base64.decode(payload.getString("data"), android.util.Base64.NO_WRAP);
                    if (bytes.length > 8 * 1024 * 1024) throw new IOException();
                    File ready = File.createTempFile("liveui-export-", ".tmp", getCacheDir());
                    try (FileOutputStream output = new FileOutputStream(ready)) { output.write(bytes); }
                    pendingDownload = ready;
                    chooseDownloadDestination(blobFilename, payload.optString("mime", "application/octet-stream"));
                } catch (Exception e) { blobNonce = null; downloadBusy = false; notice("此临时文件无法在 App 内导出，请在系统浏览器中导出"); }
                return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) { external(request.getUrl().toString()); popup.destroy(); return true; }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> download(url, disposition, mime));
        web.loadUrl(endpoint.toString());
    }
    private void awaitWorkspace(int attempt, int count) {
        if (web == null || loadFailed || attempt != workspaceAttempt || isFinishing()) return;
        web.evaluateJavascript("(() => { document.documentElement.dataset.ulemiShell='true'; return {ready: [...document.querySelectorAll('textarea')].some(e=>e.getClientRects().length), menu: [...document.querySelectorAll('[data-ulemi-native-menu=\"true\"]')].some(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).pointerEvents!=='none')}; })()", ready -> {
            if (web == null || loadFailed || attempt != workspaceAttempt || isFinishing()) return;
            boolean shown = false;
            try { JSONObject state = new JSONObject(ready); shown = state.optBoolean("ready"); if (shown) nativeBar.setVisibility(state.optBoolean("menu") ? View.GONE : View.VISIBLE); } catch (Exception ignored) { }
            if (shown) revealWorkspace();
            else if (count >= 60) workspaceError("打开时间有点长，请重试", false);
            else ui.postDelayed(() -> awaitWorkspace(attempt, count + 1), 250);
        });
    }
    private void revealWorkspace() {
        if (handoff.getVisibility() != View.VISIBLE) return;
        if (!animate()) { handoff.setVisibility(View.GONE); return; }
        handoff.animate().alpha(0).setDuration(220).withEndAction(() -> handoff.setVisibility(View.GONE)).start();
    }
    private void workspaceError(String message, boolean expired) {
        loadFailed = true; nativeBar.setVisibility(View.VISIBLE); handoffSpinner.setVisibility(View.GONE); handoff.animate().cancel(); handoff.setAlpha(1); handoff.setVisibility(View.VISIBLE);
        handoffText.setText(message); retryLoad.setVisibility(View.VISIBLE); retryLoad.setText(expired ? "重新登录" : "重试");
        retryLoad.setOnClickListener(v -> { if (expired) logout(); else reloadWorkspace(); });
    }
    private void reloadWorkspace() {
        loadFailed = false; workspaceAttempt++; handoffSpinner.setVisibility(View.VISIBLE); handoff.animate().cancel(); handoff.setAlpha(1); handoff.setVisibility(View.VISIBLE); handoffText.setText("正在打开你的空间…"); retryLoad.setVisibility(View.GONE);
        web.loadUrl(endpoint.toString());
    }
    private void showMenu(View anchor) { showAccountMenu(); }
    private void showAccountMenu() {
        if (isFinishing() || isDestroyed()) return;
        String[] items = {"离线助手 · Gemma 4", "使用引导", "重新载入", "在浏览器打开", "分享 Ulemi", "退出登录", "Devices & sensors"};
        new AlertDialog.Builder(this).setTitle("Ulemi").setItems(items, (dialog, item) -> {
            switch (item) {
                case 0: startActivity(new Intent(this, LocalAssistantActivity.class)); break;
                case 1: showGuide(); break;
                case 2: reloadWorkspace(); break;
                case 3: external(endpoint.toString()); break;
                case 4: startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, endpoint.toString()), "分享 Ulemi")); break;
                case 6: openDeviceAccess(); break;
                case 5: new AlertDialog.Builder(this).setMessage("退出后会关闭 Ulemi。你的应用和内容会保留，重新打开即可登录。").setNegativeButton("取消", null).setPositiveButton("退出", (d, w) -> logout()).show(); break;
            }
        }).setNegativeButton("取消", null).show();
    }
    private void openDeviceAccess() {
        if (pendingDeviceObservation != null) {
            new AlertDialog.Builder(this).setTitle("Device reading is ready").setMessage("Your reading has not been added to the workspace yet.")
                .setPositiveButton("Add to draft", (d,w) -> deliverDeviceObservation())
                .setNegativeButton("Take new reading", (d,w) -> { pendingDeviceObservation = null; openDeviceAccess(); }).show(); return;
        }
        boolean ready = authenticated && web != null && endpoint != null && ConnectionPolicy.sameOrigin(endpoint, web.getUrl());
        deviceObservationAccount = username; deviceObservationWeb = web;
        startActivityForResult(new Intent(this, DeviceAccessActivity.class).putExtra("workspaceAvailable", ready), DEVICE_ACCESS);
    }
    private void deliverDeviceObservation() {
        if (pendingDeviceObservation == null) return;
        if (!authenticated || web == null || web != deviceObservationWeb || !java.util.Objects.equals(username, deviceObservationAccount)
                || endpoint == null || !ConnectionPolicy.sameOrigin(endpoint, web.getUrl())) {
            deviceDeliveryError("Return to the signed-in workspace that requested this reading."); return;
        }
        final String capture = pendingDeviceObservation;
        try {
            String origin = endpoint.getScheme() + "://" + endpoint.getHost() + (endpoint.getPort() >= 0 && endpoint.getPort() != 443 ? ":" + endpoint.getPort() : "");
            web.evaluateJavascript(DeviceObservation.composerScript(capture, origin), reply -> {
                if (!capture.equals(pendingDeviceObservation)) return;
                if ("\"already_added\"".equals(reply)) { pendingDeviceObservation = null; notice("Device reading is already in your draft."); }
                else if ("\"staged\"".equals(reply)) ui.postDelayed(() -> acknowledgeDeviceObservation(capture, origin), 200);
                else deviceDeliveryError("\"draft_too_long\"".equals(reply) ? "Your draft and reading exceed this message field's limit. Shorten the draft, then retry." : "The message composer is not ready. Your reading is kept for retry.");
            });
        } catch (Exception e) { deviceDeliveryError("This reading could not be added. It has been kept for retry."); }
    }
    private void acknowledgeDeviceObservation(String capture, String origin) {
        if (!capture.equals(pendingDeviceObservation)) return;
        if (!authenticated || web != deviceObservationWeb || !java.util.Objects.equals(username, deviceObservationAccount) || !ConnectionPolicy.sameOrigin(endpoint, web.getUrl())) {
            deviceDeliveryError("Return to the signed-in workspace that requested this reading."); return;
        }
        try { web.evaluateJavascript(DeviceObservation.acknowledgementScript(capture, origin), reply -> {
            if (!capture.equals(pendingDeviceObservation)) return;
            if ("\"added\"".equals(reply)) { pendingDeviceObservation = null; notice("Device reading added to your draft. Send when ready."); }
            else deviceDeliveryError("The draft did not keep the reading. Your capture is available for retry.");
        }); } catch (Exception e) { deviceDeliveryError("Could not confirm the draft. Your reading is kept for retry."); }
    }
    private void deviceDeliveryError(String message) {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this).setTitle("Reading not added").setMessage(message)
            .setPositiveButton("Retry", (d,w) -> deliverDeviceObservation()).setNegativeButton("Keep for later", null).show();
    }
    private void external(String value) {
        try {
            Uri uri = Uri.parse(value); String scheme = uri.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) { notice("不支持打开此链接"); return; }
            if (uri.getUserInfo() != null) { notice("链接包含登录信息，未打开"); return; }
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) { notice("没有可用的应用打开此链接"); }
    }
    private void notice(String text) { if (!isFinishing()) Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void invalidateConnection(boolean clear) {
        synchronized (credentialLock) { ++connectionGeneration; if (clear) store.clear(); }
    }
    private void logout() {
        pendingDeviceObservation = null; deviceObservationWeb = null; deviceObservationAccount = null;
        invalidateConnection(true); currentSession = null; authenticated = false; if (authBootstrap != null) authBootstrap.close(); password = "";
        if (upload != null) { upload.onReceiveValue(null); upload = null; }
        if (web != null) { web.stopLoading(); web.loadUrl("about:blank"); web.clearHistory(); web.clearCache(true); web.clearFormData(); if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web); web.destroy(); web = null; }
        WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword(); WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(value -> {
            CookieManager.getInstance().flush();
            WebStorage.getInstance().getOrigins(origins -> {
                // WebView's process-local HTTP auth cache has no public clearing API.
                // End this process after persistent storage is cleared, never reuse it for another account.
                finishAndRemoveTask();
                android.os.Process.killProcess(android.os.Process.myPid());
            });
        });
    }
    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        // Match only the host's actual application-window close button, never remove/delete controls.
        web.evaluateJavascript("(()=>{const bs=[...document.querySelectorAll('button.sheet-close')].filter(b=>b.getClientRects().length);const b=bs[bs.length-1];if(b){b.click();return true}return false})()", result -> {
            if (!"true".equals(result)) { if (web != null && web.canGoBack()) web.goBack(); else moveTaskToBack(true); }
        });
    }
    private void chooseDownloadDestination(String filename, String mime) {
        try {
            Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime == null || !mime.matches("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+") ? "application/octet-stream" : mime)
                    .putExtra(Intent.EXTRA_TITLE, ConnectionPolicy.safeFilename(filename));
            startActivityForResult(save, SAVE_FILE);
        } catch (ActivityNotFoundException e) {
            if (pendingDownload != null) pendingDownload.delete(); pendingDownload = null; downloadBusy = false; notice("没有可用的文件保存应用");
        }
    }
    private void exportBlob(String url, String disposition, String mime) {
        // Only top-origin blobs can be fetched. Sandboxed opaque iframe blobs stay inaccessible.
        if (!url.startsWith("blob:") || !ConnectionPolicy.sameOrigin(endpoint, url.substring(5)) || !ConnectionPolicy.sameOrigin(endpoint, web.getUrl())) {
            notice("此应用的临时文件需在系统浏览器中导出"); return;
        }
        downloadBusy = true; blobNonce = java.util.UUID.randomUUID().toString();
        blobFilename = ConnectionPolicy.safeFilename(URLUtil.guessFileName(url, disposition, mime));
        String nonce = JSONObject.quote(blobNonce), target = JSONObject.quote(url);
        String script = "(async()=>{const nonce=" + nonce + ";try{const response=await fetch(" + target + ");const blob=await response.blob();if(blob.size>8388608)throw Error('size');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob)});prompt('liveui.export.v1',JSON.stringify({nonce,data,mime:blob.type}))}catch(e){prompt('liveui.export.v1',JSON.stringify({nonce,error:true}))}})()";
        web.evaluateJavascript(script, null);
        String expected = blobNonce;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (expected.equals(blobNonce)) { blobNonce = null; downloadBusy = false; notice("导出未完成，请在系统浏览器中重试"); }
        }, 15000);
    }
    private void download(String url, String disposition, String mime) {
        if (downloadBusy || pendingDownload != null) { notice("请先完成当前文件保存"); return; }
        if (url.startsWith("blob:")) { exportBlob(url, disposition, mime); return; }
        if (!ConnectionPolicy.sameOrigin(endpoint, url)) { external(url); return; }
        downloadBusy = true;
        String filename = ConnectionPolicy.safeFilename(URLUtil.guessFileName(url, disposition, mime));
        int generation = connectionGeneration;
        notice("正在准备文件…");
        network.execute(() -> {
            File temp = null;
            try {
                temp = File.createTempFile("liveui-download-", ".tmp", getCacheDir());
                String current = url;
                HttpsURLConnection c = null;
                for (int attempt = 0; attempt < 4; attempt++) {
                    if (!ConnectionPolicy.sameOrigin(endpoint, current)) throw new IOException("下载跳转到了其他服务，已停止");
                    c = connection(current); c.setRequestProperty("Authorization", authorization(username, password));
                    String cookies = CookieManager.getInstance().getCookie(current); if (cookies != null) c.setRequestProperty("Cookie", cookies);
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) { String next = c.getHeaderField("Location"); c.disconnect(); if (next == null) throw new IOException("下载地址无效"); current = URI.create(current).resolve(next).toString(); continue; }
                    if (code != 200) throw new IOException("下载失败，HTTP " + code);
                    break;
                }
                if (c == null || c.getResponseCode() != 200) throw new IOException("下载跳转过多");
                if (c.getContentLengthLong() > MAX_DOWNLOAD) throw new IOException("文件超过 32 MB，请在浏览器下载");
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[32768]; long total = 0; int n;
                    while ((n = in.read(buffer)) != -1) { total += n; if (total > MAX_DOWNLOAD || generation != connectionGeneration) throw new IOException("下载已停止"); out.write(buffer, 0, n); }
                } finally { c.disconnect(); }
                File ready = temp;
                runOnUiThread(() -> {
                    if (generation != connectionGeneration || isFinishing()) { ready.delete(); return; }
                    pendingDownload = ready;
                    chooseDownloadDestination(filename, mime);
                });
            } catch (Exception e) {
                if (temp != null) temp.delete();
                runOnUiThread(() -> { downloadBusy = false; notice("文件下载未完成，请重试或在浏览器中下载"); });
            }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == DEVICE_ACCESS && result == RESULT_OK && data != null) {
            pendingDeviceObservation = data.getStringExtra("deviceObservation");
            if (pendingDeviceObservation != null) deliverDeviceObservation();
            else notice("No device reading was returned. Open Devices to try again.");
            return;
        }
        if (request == PICK_FILE && upload != null) {
            Uri[] values = null;
            if (result == RESULT_OK && data != null) {
                boolean valid = true;
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    if (n > 0 && n <= 32) {
                        values = new Uri[n];
                        for (int i = 0; i < n; i++) {
                            values[i] = data.getClipData().getItemAt(i).getUri();
                            if (values[i] == null || !ConnectionPolicy.isContentUpload(values[i].toString())) valid = false;
                        }
                    } else valid = false;
                } else if (data.getData() != null) {
                    if (ConnectionPolicy.isContentUpload(data.getData().toString())) values = new Uri[]{data.getData()};
                    else valid = false;
                }
                if (!valid) { values = null; notice("请选择文件应用提供的文件，一次最多 32 个"); }
            }
            upload.onReceiveValue(values); upload = null;
        }
        if (request == SAVE_FILE && pendingDownload != null) {
            File file = pendingDownload; pendingDownload = null; downloadBusy = false;
            if (result == RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData(); network.execute(() -> {
                    try (InputStream in = new FileInputStream(file); OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IOException(); byte[] b = new byte[32768]; int n; while ((n = in.read(b)) != -1) out.write(b, 0, n);
                        runOnUiThread(() -> notice("文件已保存"));
                    } catch (Exception e) { runOnUiThread(() -> notice("文件未保存，请重新下载")); }
                    finally { file.delete(); }
                });
            } else file.delete();
        }
    }
    @Override protected void onDestroy() {
        invalidateConnection(false); ui.removeCallbacksAndMessages(null);
        if (guide != null) { guide.setOnCancelListener(null); guide.dismiss(); guide = null; }
        if (upload != null) { upload.onReceiveValue(null); upload = null; }
        if (web != null) { web.stopLoading(); if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web); web.destroy(); web = null; }
        if (pendingDownload != null) pendingDownload.delete(); network.shutdownNow(); super.onDestroy();
    }
}
