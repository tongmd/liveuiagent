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
    private static final int PICK_FILE = 40, SAVE_FILE = 41;
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
    private BrandMotionView handoffMotion;
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
        BrandMotionView mark = new BrandMotionView(this); center.addView(mark, new LinearLayout.LayoutParams(dp(160), dp(160)));
        TextView word = text("Ulemi", 28, NativeStyle.INK); word.setPadding(0, dp(18), 0, 0); center.addView(word);
        reveal(center); center.setOnClickListener(v -> restoreAccount());
        ui.postDelayed(this::restoreAccount, animate() ? 280 : 0);
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
        } catch (Exception ignored) { store.clear(); showLogin("Sign in again to continue."); }
    }
    private void showRestoring() {
        root = makeRoot();
        LinearLayout center = new LinearLayout(this); center.setOrientation(LinearLayout.VERTICAL); center.setGravity(Gravity.CENTER);
        root.addView(center, new LinearLayout.LayoutParams(-1, -1));
        center.addView(new BrandMotionView(this), new LinearLayout.LayoutParams(dp(160), dp(160)));
        TextView name = text("Ulemi", 27, NativeStyle.INK); name.setPadding(0, dp(18), 0, dp(10)); center.addView(name);
        TextView t = text("Opening your space", 15, 0xff767671); center.addView(t);

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
        return NativeStyle.button(this, value, primary);
    }
    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }
    private LinearLayout makeRoot() {
        LinearLayout r = new LinearLayout(this); r.setOrientation(LinearLayout.VERTICAL); r.setBackgroundColor(NativeStyle.PAPER);
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
        e.setTextColor(Color.BLACK); e.setHintTextColor(0xff777777); e.setPadding(dp(16), 0, dp(16), 0); e.setBackground(rounded(0xffffffff, 18));
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
        header.addView(icon(58), new LinearLayout.LayoutParams(dp(58), dp(58)));
        TextView brand = text("Ulemi", 36, NativeStyle.INK); brand.setPadding(0, dp(10), 0, dp(8)); header.addView(brand);
        TextView welcome = text("Your ideas, made yours.", 18, 0xff777771); welcome.setPadding(0, 0, 0, dp(20)); header.addView(welcome);
        userInput = input(box, "Username", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL); userInput.setText(username);
        userInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        passwordInput = input(box, "Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        passwordInput.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        passwordInput.setOnEditorActionListener((v, action, event) -> { if (action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE && connect.isEnabled()) { connect(); return true; } return false; });
        CheckBox visible = new CheckBox(this); visible.setText("Show password"); visible.setTextColor(0xff555555); visible.setTextSize(14);
        visible.setOnCheckedChangeListener((v, checked) -> { passwordInput.setTransformationMethod(checked ? null : android.text.method.PasswordTransformationMethod.getInstance()); passwordInput.setSelection(passwordInput.length()); });
        box.addView(visible, new LinearLayout.LayoutParams(-1, dp(48)));
        connect = button("Sign in", true); connect.setOnClickListener(v -> connect()); LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(-1, dp(54)); bp.topMargin = dp(8); box.addView(connect, bp);
        status = text(message == null ? "" : message, 14, 0xffad3333); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); status.setPadding(0, dp(14), 0, 0); box.addView(status); status.setVisibility(message == null || message.isEmpty() ? View.GONE : View.VISIBLE);
        Button waitlist = button("Join the waitlist", false); loginWaitlist = waitlist; waitlist.setTextSize(14); waitlist.setOnClickListener(v -> external("https://docs.google.com/forms/d/e/1FAIpQLSckrULbwm5t1j0UiV7KwVIUwq2-qsMnI4pkikL7Ii1J6K55QA/viewform")); LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(-1, dp(50)); wp.topMargin = dp(12); box.addView(waitlist, wp);
        Button local = button("Offline assistant", false); local.setOnClickListener(v -> startActivity(new Intent(this, LocalAssistantActivity.class)));
        LinearLayout.LayoutParams lpLocal = new LinearLayout.LayoutParams(-1, dp(50)); lpLocal.topMargin = dp(12); box.addView(local, lpLocal);
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
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); scroll.setBackgroundColor(NativeStyle.PAPER);
        LinearLayout page = new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setPadding(dp(26), dp(18), dp(26), dp(24)); scroll.addView(page);
        LinearLayout top = new LinearLayout(this); top.setGravity(Gravity.CENTER_VERTICAL); top.addView(icon(36), new LinearLayout.LayoutParams(dp(36), dp(36)));
        Space space = new Space(this); top.addView(space, new LinearLayout.LayoutParams(0, 1, 1));
        Button skip = button("Skip", false); skip.setContentDescription("Skip introduction"); skip.setOnClickListener(v -> finishGuide()); top.addView(skip, new LinearLayout.LayoutParams(dp(80), dp(48))); page.addView(top);
        Space upper = new Space(this); page.addView(upper, new LinearLayout.LayoutParams(1, dp(24), 1));
        String[] titles = {"Start with an idea.", "Make it your own.", "Pick up where you left off."};
        String[] copy = {"Tell Ulemi what you need. It creates an app for you.", "Keep the conversation going. Shape the features and interface as you use them.", "Your apps stay in your space, ready whenever you are."};
        TextView title = text(titles[step], 28, Color.BLACK); title.setTypeface(null, android.graphics.Typeface.BOLD); page.addView(title);
        TextView body = text(copy[step], 17, 0xff555555); body.setLineSpacing(dp(5), 1); body.setPadding(0, dp(16), 0, dp(28)); page.addView(body);
        LinearLayout illustration = new LinearLayout(this); illustration.setOrientation(LinearLayout.VERTICAL); illustration.setPadding(dp(20), dp(22), dp(20), dp(22)); illustration.setBackground(rounded(0xfff5f5f5, 22));
        String[][] examples = {{"Make me a reading list", "An idea is all you need"}, {"Group the books I have finished", "Keep shaping the same app"}, {"Your apps", "Open an app and carry on"}};
        for (int i = 0; i < 2; i++) { TextView line = text(examples[step][i], i == 0 ? 19 : 15, i == 0 ? Color.BLACK : 0xff777777); line.setPadding(0, i == 0 ? 0 : dp(14), 0, 0); illustration.addView(line); }
        illustration.setContentDescription("Example of using Ulemi"); page.addView(illustration, new LinearLayout.LayoutParams(-1, -2));
        Space lower = new Space(this); page.addView(lower, new LinearLayout.LayoutParams(1, dp(30), 1));
        LinearLayout dots = new LinearLayout(this); dots.setGravity(Gravity.CENTER); dots.setContentDescription("Step " + (step + 1) + " of 3");
        for (int i = 0; i < 3; i++) { View dot = new View(this); dot.setBackground(rounded(i == step ? Color.BLACK : 0xffdddddd, 4)); LinearLayout.LayoutParams dl = new LinearLayout.LayoutParams(dp(i == step ? 22 : 7), dp(7)); dl.setMargins(dp(4), 0, dp(4), dp(22)); dots.addView(dot, dl); } page.addView(dots);
        Button next = button(step == 2 ? "Let's begin" : "Continue", true); next.setOnClickListener(v -> { if (step == 2) finishGuide(); else renderGuide(step + 1); }); page.addView(next, new LinearLayout.LayoutParams(-1, dp(54)));
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
            if (u.isEmpty() || p.isEmpty() || u.contains(":") || u.contains("\n") || u.contains("\r")) throw new IllegalArgumentException("Enter a valid username and password.");
        } catch (Exception e) { status.setText(e.getMessage()); status.setVisibility(View.VISIBLE); return; }
        final int generation; synchronized (credentialLock) { generation = ++connectionGeneration; }
        connect.setEnabled(false); connect.setText("Signing in…"); status.setText(""); status.setVisibility(View.GONE);
        android.view.inputmethod.InputMethodManager keyboard = (android.view.inputmethod.InputMethodManager) getSystemService(INPUT_METHOD_SERVICE); keyboard.hideSoftInputFromWindow(passwordInput.getWindowToken(), 0);
        network.execute(() -> {
            String error = null;
            try {
                HttpsURLConnection probe = connection(candidate.toString());
                int code = probe.getResponseCode(); String challenge = probe.getHeaderField("WWW-Authenticate"); probe.disconnect();
                if (code != 401 || !ConnectionPolicy.validBasicChallenge(challenge)) throw new IOException("Sign-in is unavailable. Please try again.");
                HttpsURLConnection check = connection(candidate.toString()); check.setRequestProperty("Authorization", authorization(u, p));
                code = check.getResponseCode(); check.disconnect();
                if (code == 401 || code == 403) throw new IOException("Incorrect username or password. Please try again.");
                if (code != 200) throw new IOException("Sign-in is unavailable. Please try again.");
                synchronized (credentialLock) {
                    if (generation != connectionGeneration) return;
                    store.save(candidate.toString(), u, p);
                }
            } catch (javax.net.ssl.SSLException e) { error = "A secure sign-in could not be established. Please try again."; }
            catch (Exception e) { error = e instanceof IOException && ("Incorrect username or password. Please try again.".equals(e.getMessage()) || "Sign-in is unavailable. Please try again.".equals(e.getMessage())) ? e.getMessage() : "Check your connection and try again."; }
            String finalError = error;
            runOnUiThread(() -> {
                if (isFinishing() || generation != connectionGeneration) return;
                connect.setEnabled(true); connect.setText("Sign in");
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
        LinearLayout bar = new LinearLayout(this); bar.setGravity(Gravity.CENTER_VERTICAL); bar.setPadding(dp(20), dp(4), dp(16), dp(4));
        TextView title = new TextView(this); title.setText(R.string.app_name); title.setTextSize(18); title.setTextColor(NativeStyle.INK); title.setGravity(Gravity.CENTER_VERTICAL); bar.addView(title, new LinearLayout.LayoutParams(0, -1, 1));
        Button menu = button("···", false); menu.setTextSize(22); menu.setContentDescription("Account menu"); menu.setOnClickListener(this::showMenu); bar.addView(menu, new LinearLayout.LayoutParams(dp(48), dp(48)));
        nativeBar = bar; nativeBar.setVisibility(View.GONE);
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(56)));
        workspace = new FrameLayout(this); root.addView(workspace, new LinearLayout.LayoutParams(-1, 0, 1));
        web = new WebView(this); web.setBackgroundColor(Color.WHITE); workspace.addView(web, new FrameLayout.LayoutParams(-1, -1));
        handoff = new LinearLayout(this); handoff.setOrientation(LinearLayout.VERTICAL); handoff.setGravity(Gravity.CENTER); handoff.setPadding(dp(28), dp(28), dp(28), dp(28)); handoff.setBackgroundColor(NativeStyle.PAPER);
        handoffMotion = new BrandMotionView(this); handoff.addView(handoffMotion, new LinearLayout.LayoutParams(dp(160), dp(160)));
        TextView brand = text("Ulemi", 27, NativeStyle.INK); brand.setGravity(Gravity.CENTER); brand.setPadding(0, dp(18), 0, dp(10)); handoff.addView(brand);
        handoffText = text("Opening your space", 15, 0xff767671); handoffText.setGravity(Gravity.CENTER); handoffText.setLineSpacing(dp(4), 1); handoffText.setPadding(0, 0, 0, dp(26)); handoffText.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); handoff.addView(handoffText);
        retryLoad = button("Try again", true); retryLoad.setVisibility(View.GONE); retryLoad.setOnClickListener(v -> reloadWorkspace()); handoff.addView(retryLoad, new LinearLayout.LayoutParams(dp(180), dp(52)));
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

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); workspaceError("A secure connection could not be established.", false); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) workspaceError("Check your connection and try again.", false); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) { boolean expired = response.getStatusCode() == 401 || response.getStatusCode() == 403; workspaceError(expired ? "Your session has expired. Please sign in again." : "Your space is unavailable. Please try again.", expired); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null); upload = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = params.getAcceptTypes(); if (types != null && types.length > 0 && !types[0].isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, PICK_FILE); } catch (ActivityNotFoundException e) { upload.onReceiveValue(null); upload = null; notice("No file picker is available."); }
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
                } catch (Exception e) { blobNonce = null; downloadBusy = false; notice("Export this temporary file in your browser."); }
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
            else if (count >= 60) workspaceError("This is taking longer than expected.", false);
            else ui.postDelayed(() -> awaitWorkspace(attempt, count + 1), 250);
        });
    }
    private void revealWorkspace() {
        if (handoff.getVisibility() != View.VISIBLE) return;
        handoffMotion.setActive(false);
        if (!animate()) { handoff.setVisibility(View.GONE); return; }
        handoff.animate().alpha(0).setDuration(220).withEndAction(() -> handoff.setVisibility(View.GONE)).start();
    }
    private void workspaceError(String message, boolean expired) {
        loadFailed = true; nativeBar.setVisibility(View.VISIBLE); handoffMotion.setActive(false); handoff.animate().cancel(); handoff.setAlpha(1); handoff.setVisibility(View.VISIBLE);
        handoffText.setText(message); retryLoad.setVisibility(View.VISIBLE); retryLoad.setText(expired ? "Sign in again" : "Try again");
        retryLoad.setOnClickListener(v -> { if (expired) logout(); else reloadWorkspace(); });
    }
    private void reloadWorkspace() {
        loadFailed = false; workspaceAttempt++; nativeBar.setVisibility(View.GONE); handoffMotion.setActive(true); handoff.animate().cancel(); handoff.setAlpha(1); handoff.setVisibility(View.VISIBLE); handoffText.setText("Opening your space"); retryLoad.setVisibility(View.GONE);
        web.loadUrl(endpoint.toString());
    }
    private void showMenu(View anchor) { showAccountMenu(); }
    private void showAccountMenu() {
        if (isFinishing() || isDestroyed()) return;
        String[] items = {"Offline assistant", "Quick tour", "Reload workspace", "Open in browser", "Share Ulemi", "Sign out"};
        new AlertDialog.Builder(this).setTitle("Ulemi").setItems(items, (dialog, item) -> {
            switch (item) {
                case 0: startActivity(new Intent(this, LocalAssistantActivity.class)); break;
                case 1: showGuide(); break;
                case 2: reloadWorkspace(); break;
                case 3: external(endpoint.toString()); break;
                case 4: startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, endpoint.toString()), "Share Ulemi")); break;
                case 5: new AlertDialog.Builder(this).setMessage("Signing out closes Ulemi. Your apps and content stay saved. Open Ulemi again to sign in.").setNegativeButton("Cancel", null).setPositiveButton("Sign out", (d, w) -> logout()).show(); break;
            }
        }).setNegativeButton("Cancel", null).show();
    }
    private void external(String value) {
        try {
            Uri uri = Uri.parse(value); String scheme = uri.getScheme();
            if (!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme) && !"mailto".equalsIgnoreCase(scheme)) { notice("This link is not supported."); return; }
            if (uri.getUserInfo() != null) { notice("This link contains account information and was not opened."); return; }
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) { notice("No app is available to open this link."); }
    }
    private void notice(String text) { if (!isFinishing()) Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void invalidateConnection(boolean clear) {
        synchronized (credentialLock) { ++connectionGeneration; if (clear) store.clear(); }
    }
    private void logout() {
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
            if (pendingDownload != null) pendingDownload.delete(); pendingDownload = null; downloadBusy = false; notice("No file-saving app is available.");
        }
    }
    private void exportBlob(String url, String disposition, String mime) {
        // Only top-origin blobs can be fetched. Sandboxed opaque iframe blobs stay inaccessible.
        if (!url.startsWith("blob:") || !ConnectionPolicy.sameOrigin(endpoint, url.substring(5)) || !ConnectionPolicy.sameOrigin(endpoint, web.getUrl())) {
            notice("Export this temporary file in your browser."); return;
        }
        downloadBusy = true; blobNonce = java.util.UUID.randomUUID().toString();
        blobFilename = ConnectionPolicy.safeFilename(URLUtil.guessFileName(url, disposition, mime));
        String nonce = JSONObject.quote(blobNonce), target = JSONObject.quote(url);
        String script = "(async()=>{const nonce=" + nonce + ";try{const response=await fetch(" + target + ");const blob=await response.blob();if(blob.size>8388608)throw Error('size');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(blob)});prompt('liveui.export.v1',JSON.stringify({nonce,data,mime:blob.type}))}catch(e){prompt('liveui.export.v1',JSON.stringify({nonce,error:true}))}})()";
        web.evaluateJavascript(script, null);
        String expected = blobNonce;
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (expected.equals(blobNonce)) { blobNonce = null; downloadBusy = false; notice("Export did not finish. Please try in your browser."); }
        }, 15000);
    }
    private void download(String url, String disposition, String mime) {
        if (downloadBusy || pendingDownload != null) { notice("Finish saving the current file first."); return; }
        if (url.startsWith("blob:")) { exportBlob(url, disposition, mime); return; }
        if (!ConnectionPolicy.sameOrigin(endpoint, url)) { external(url); return; }
        downloadBusy = true;
        String filename = ConnectionPolicy.safeFilename(URLUtil.guessFileName(url, disposition, mime));
        int generation = connectionGeneration;
        notice("Preparing your file…");
        network.execute(() -> {
            File temp = null;
            try {
                temp = File.createTempFile("liveui-download-", ".tmp", getCacheDir());
                String current = url;
                HttpsURLConnection c = null;
                for (int attempt = 0; attempt < 4; attempt++) {
                    if (!ConnectionPolicy.sameOrigin(endpoint, current)) throw new IOException("Download stopped after a redirect to another service.");
                    c = connection(current); c.setRequestProperty("Authorization", authorization(username, password));
                    String cookies = CookieManager.getInstance().getCookie(current); if (cookies != null) c.setRequestProperty("Cookie", cookies);
                    int code = c.getResponseCode();
                    if (code >= 300 && code < 400) { String next = c.getHeaderField("Location"); c.disconnect(); if (next == null) throw new IOException("The download address is invalid."); current = URI.create(current).resolve(next).toString(); continue; }
                    if (code != 200) throw new IOException("Download failed. HTTP " + code);
                    break;
                }
                if (c == null || c.getResponseCode() != 200) throw new IOException("Too many download redirects.");
                if (c.getContentLengthLong() > MAX_DOWNLOAD) throw new IOException("For files over 32 MB, download in your browser.");
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                    byte[] buffer = new byte[32768]; long total = 0; int n;
                    while ((n = in.read(buffer)) != -1) { total += n; if (total > MAX_DOWNLOAD || generation != connectionGeneration) throw new IOException("Download stopped."); out.write(buffer, 0, n); }
                } finally { c.disconnect(); }
                File ready = temp;
                runOnUiThread(() -> {
                    if (generation != connectionGeneration || isFinishing()) { ready.delete(); return; }
                    pendingDownload = ready;
                    chooseDownloadDestination(filename, mime);
                });
            } catch (Exception e) {
                if (temp != null) temp.delete();
                runOnUiThread(() -> { downloadBusy = false; notice("Download did not finish. Try again or use your browser."); });
            }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
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
                if (!valid) { values = null; notice("Choose up to 32 files from the file picker."); }
            }
            upload.onReceiveValue(values); upload = null;
        }
        if (request == SAVE_FILE && pendingDownload != null) {
            File file = pendingDownload; pendingDownload = null; downloadBusy = false;
            if (result == RESULT_OK && data != null && data.getData() != null) {
                Uri uri = data.getData(); network.execute(() -> {
                    try (InputStream in = new FileInputStream(file); OutputStream out = getContentResolver().openOutputStream(uri)) {
                        if (out == null) throw new IOException(); byte[] b = new byte[32768]; int n; while ((n = in.read(b)) != -1) out.write(b, 0, n);
                        runOnUiThread(() -> notice("File saved."));
                    } catch (Exception e) { runOnUiThread(() -> notice("The file was not saved. Please download again.")); }
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
