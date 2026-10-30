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
        final URI endpoint; final String username, password;
        Session(URI endpoint, String username, String password) { this.endpoint = endpoint; this.username = username; this.password = password; }
    }
    private LinearLayout root;
    private WebView web;
    private EditText addressInput, userInput, passwordInput;
    private TextView status;
    private ProgressBar loading;
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
        // An Activity recreation does not clear Chromium's in-memory auth cache.
        // Keep the same connection until explicit logout terminates this process.
        if (currentSession != null) {
            endpoint = currentSession.endpoint; username = currentSession.username; password = currentSession.password;
            authenticated = true; openWorkspace(); return;
        }
        showLogin(null);
        try {
            JSONObject saved = store.load();
            if (saved != null) {
                addressInput.setText(saved.getString("url")); userInput.setText(saved.getString("user")); passwordInput.setText(saved.getString("password"));
                connect();
            }
        } catch (Exception ignored) { store.clear(); status.setText("连接信息已失效，请重新登录"); }
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
            return insets;
        });
        setContentView(r); r.requestApplyInsets(); return r;
    }
    private EditText input(LinearLayout box, String hint, int type) {
        EditText e = new EditText(this); e.setSingleLine(true); e.setTextSize(16); e.setHint(hint); e.setContentDescription(hint); e.setInputType(type);
        e.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); box.addView(e, new LinearLayout.LayoutParams(-1, dp(56))); return e;
    }
    private void showLogin(String message) {
        root = makeRoot();
        ScrollView scroll = new ScrollView(this); scroll.setFillViewport(true); root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
        LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(28), dp(48), dp(28), dp(24)); scroll.addView(box);
        ImageView icon = new ImageView(this); icon.setImageResource(com.stonezhang.liveui.R.drawable.liveui_icon); icon.setScaleType(ImageView.ScaleType.FIT_CENTER); box.addView(icon, new LinearLayout.LayoutParams(dp(64), dp(64)));
        TextView title = new TextView(this); title.setText("liveUI"); title.setTextColor(Color.BLACK); title.setTextSize(30); title.setPadding(0, dp(12), 0, dp(28)); box.addView(title);
        addressInput = input(box, "服务地址", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI); addressInput.setText(endpoint == null ? ConnectionPolicy.DEFAULT_URL : endpoint.toString());
        userInput = input(box, "用户名", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_NORMAL); userInput.setText(username);
        passwordInput = input(box, "密码", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        connect = new Button(this); connect.setText("连接"); connect.setOnClickListener(v -> connect()); box.addView(connect, new LinearLayout.LayoutParams(-1, dp(54)));
        Button forget = new Button(this); forget.setText("清除已保存连接"); forget.setOnClickListener(v -> {
            invalidateConnection(true); endpoint = null; username = ""; password = "";
            addressInput.setText(ConnectionPolicy.DEFAULT_URL); userInput.setText(""); passwordInput.setText(""); connect.setEnabled(true); status.setText("");
        }); box.addView(forget, new LinearLayout.LayoutParams(-1, dp(48)));
        status = new TextView(this); status.setTextColor(0xff555555); status.setPadding(0, dp(12), 0, 0); status.setText(message == null ? "" : message); box.addView(status);
    }
    private void connect() {
        final URI candidate;
        final String u = userInput.getText().toString().trim(), p = passwordInput.getText().toString();
        try {
            candidate = ConnectionPolicy.parse(addressInput.getText().toString());
            if (u.isEmpty() || p.isEmpty() || u.contains(":") || u.contains("\n") || u.contains("\r")) throw new IllegalArgumentException("请输入有效的用户名和密码");
        } catch (Exception e) { status.setText(e.getMessage()); return; }
        final int generation; synchronized (credentialLock) { generation = ++connectionGeneration; }
        connect.setEnabled(false); status.setText("正在连接…");
        network.execute(() -> {
            String error = null;
            try {
                HttpsURLConnection probe = connection(candidate.toString());
                int code = probe.getResponseCode(); String challenge = probe.getHeaderField("WWW-Authenticate"); probe.disconnect();
                if (code != 401 || !ConnectionPolicy.validBasicChallenge(challenge)) throw new IOException("服务未提供预期的 liveUI 登录入口");
                HttpsURLConnection check = connection(candidate.toString()); check.setRequestProperty("Authorization", authorization(u, p));
                code = check.getResponseCode(); check.disconnect();
                if (code == 401 || code == 403) throw new IOException("用户名或密码不正确");
                if (code != 200) throw new IOException("连接失败，HTTP " + code);
                synchronized (credentialLock) {
                    if (generation != connectionGeneration) return;
                    store.save(candidate.toString(), u, p);
                }
            } catch (javax.net.ssl.SSLException e) { error = "无法验证服务器证书，未发送登录信息"; }
            catch (Exception e) { error = e instanceof IOException && e.getMessage() != null && !e.getMessage().contains("://") ? e.getMessage() : "无法连接，请检查地址和网络后重试"; }
            String finalError = error;
            runOnUiThread(() -> {
                if (isFinishing() || generation != connectionGeneration) return;
                connect.setEnabled(true);
                if (finalError != null) { status.setText(finalError); return; }
                endpoint = candidate; username = u; password = p; currentSession = new Session(candidate, u, p); authenticated = true; openWorkspace();
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
        TextView title = new TextView(this); title.setText("liveUI"); title.setTextSize(18); title.setTextColor(Color.BLACK); bar.addView(title, new LinearLayout.LayoutParams(0, -1, 1));
        Button menu = new Button(this); menu.setText("⋮"); menu.setTextSize(22); menu.setContentDescription("菜单"); menu.setOnClickListener(this::showMenu); bar.addView(menu, new LinearLayout.LayoutParams(dp(52), -1));
        root.addView(bar, new LinearLayout.LayoutParams(-1, dp(44)));
        loading = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal); loading.setMax(100); root.addView(loading, new LinearLayout.LayoutParams(-1, dp(2)));
        web = new WebView(this); web.setBackgroundColor(Color.WHITE); root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        WebSettings settings = web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true); settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false); settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setSafeBrowsingEnabled(true); settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setBuiltInZoomControls(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        authBootstrap = new AuthBootstrap(endpoint);
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
            @Override public void onPageCommitVisible(WebView view, String url) { if (authBootstrap != null) authBootstrap.close(); }
            @Override public void onPageFinished(WebView view, String url) { loading.setVisibility(View.GONE); }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) { handler.cancel(); notice("证书验证失败，连接已停止"); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) notice("页面加载失败。请用菜单重新加载；已提交任务不会自动重发。"); }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && (response.getStatusCode() == 401 || response.getStatusCode() == 403)) notice("登录已失效，请在菜单中退出连接后重新登录");
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int progress) { loading.setProgress(progress); loading.setVisibility(progress == 100 ? View.GONE : View.VISIBLE); }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null); upload = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = params.getAcceptTypes(); if (types != null && types.length > 0 && !types[0].isEmpty()) pick.putExtra(Intent.EXTRA_MIME_TYPES, types);
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, PICK_FILE); } catch (ActivityNotFoundException e) { upload.onReceiveValue(null); upload = null; notice("没有可用的文件选择器"); }
                return true;
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String value, JsPromptResult result) {
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
    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0, 1, 0, "重新加载"); menu.getMenu().add(0, 2, 1, "在浏览器打开"); menu.getMenu().add(0, 3, 2, "分享入口"); menu.getMenu().add(0, 4, 3, "退出账号并关闭");
        menu.setOnMenuItemClickListener(item -> {
            switch (item.getItemId()) {
                case 1: web.reload(); break;
                case 2: external(endpoint.toString()); break;
                case 3: startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, endpoint.toString()), "分享 liveUI")); break;
                case 4: new AlertDialog.Builder(this).setMessage("退出账号后将关闭 App。重新打开可连接其他账号或服务，服务器上的应用和数据会保留。").setNegativeButton("取消", null).setPositiveButton("退出", (d, w) -> logout()).show(); break;
            } return true;
        }); menu.show();
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
        invalidateConnection(true); currentSession = null; authenticated = false; if (authBootstrap != null) authBootstrap.close(); password = "";
        if (upload != null) { upload.onReceiveValue(null); upload = null; }
        if (web != null) { web.stopLoading(); web.loadUrl("about:blank"); web.clearHistory(); web.clearCache(true); web.clearFormData(); root.removeView(web); web.destroy(); web = null; }
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
        if (request == PICK_FILE && upload != null) {
            Uri[] values = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) { int n = Math.min(32, data.getClipData().getItemCount()); values = new Uri[n]; for (int i = 0; i < n; i++) values[i] = data.getClipData().getItemAt(i).getUri(); }
                else if (data.getData() != null) values = new Uri[]{data.getData()};
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
        invalidateConnection(false);
        if (upload != null) { upload.onReceiveValue(null); upload = null; }
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        if (pendingDownload != null) pendingDownload.delete(); network.shutdownNow(); super.onDestroy();
    }
}
