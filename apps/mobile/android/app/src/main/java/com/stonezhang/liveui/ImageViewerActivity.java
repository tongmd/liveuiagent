package com.stonezhang.liveui;

import android.app.Activity;
import android.content.Intent;
import android.graphics.*;
import android.net.Uri;
import android.os.Bundle;
import android.view.*;
import android.widget.*;
import java.io.*;
import java.util.concurrent.*;

/** On-device viewing. A selected image is never sent to the workspace or model. */
public final class ImageViewerActivity extends Activity {
    private static final int PICK = 1450;
    static final int MAX_BYTES = 32 * 1024 * 1024;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private ZoomImage view;
    private ImageCapture capture;
    private TextView status;
    private int generation;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        capture = new ImageCapture(this);
        getWindow().setStatusBarColor(Color.BLACK); getWindow().setNavigationBarColor(Color.BLACK);
        getWindow().getDecorView().setSystemUiVisibility(0);
        if (android.os.Build.VERSION.SDK_INT >= 29) { getWindow().setStatusBarContrastEnforced(false); getWindow().setNavigationBarContrastEnforced(false); }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.BLACK);
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()); v.setPadding(bars.left,bars.top,bars.right,bars.bottom); return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom()); return insets.consumeSystemWindowInsets();
        });
        LinearLayout controls = new LinearLayout(this);
        addButton(controls, "Close", this::finish); addButton(controls, "Open", this::pick); addButton(controls, "Camera", () -> capture.start(uri -> { if (uri != null) open(uri); }, this::pick)); addButton(controls, "Fit", () -> view.reset());
        root.addView(controls, new LinearLayout.LayoutParams(-1, -2));
        status = new TextView(this); status.setTextColor(Color.WHITE); status.setPadding(16, 8, 16, 8); status.setText("Choose an image to view on this device."); root.addView(status);
        view = new ZoomImage(this); root.addView(view, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root); root.requestApplyInsets();
        if (state == null) { if (getIntent().getData() != null) open(getIntent().getData()); else pick(); }
    }
    private void addButton(LinearLayout row, String title, Runnable action) {
        Button button = new Button(this); button.setAllCaps(false); button.setText(title); button.setTextSize(14); button.setTextColor(Color.WHITE);
        button.setElevation(0); button.setStateListAnimator(null); button.setPadding(0,0,0,0);
        button.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x44ffffff), new android.graphics.drawable.ColorDrawable(Color.BLACK), null));
        int height = Math.round(52 * getResources().getDisplayMetrics().density); button.setMinHeight(height); button.setMinimumHeight(height);
        button.setOnClickListener(v -> action.run()); row.addView(button, new LinearLayout.LayoutParams(0, height, 1));
    }
    private void pick() {
        try { startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), PICK); }
        catch (android.content.ActivityNotFoundException e) { status.setText("No image picker is available on this device."); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        capture.result(request, result);
        if (request != PICK || result != RESULT_OK || data == null) return;
        open(data.getData());
    }
    private void open(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme())) { status.setText("Choose an image from the system picker."); return; }
        final int attempt = ++generation; status.setText("Opening image…");
        decoder.execute(() -> {
            try {
                byte[] bytes;
                try (InputStream stream = getContentResolver().openInputStream(uri)) { bytes = readBounded(stream); }
                Bitmap image = decode(bytes);
                runOnUiThread(() -> {
                    if (attempt != generation || isFinishing() || isDestroyed()) { image.recycle(); return; }
                    view.image(image); status.setText("Pinch to zoom · Double-tap to zoom or fit");
                });
            } catch (Exception | OutOfMemoryError e) { runOnUiThread(() -> { if (attempt == generation && !isFinishing()) status.setText("This image could not be opened. Choose a valid image under 32 MB."); }); }
        });
    }
    static byte[] readBounded(InputStream stream) throws IOException {
        if (stream == null) throw new IOException("Missing image");
        ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] block = new byte[16384]; int n, total = 0;
        while ((n = stream.read(block)) != -1) { total += n; if (total > MAX_BYTES) throw new IOException("Image too large"); out.write(block, 0, n); }
        return out.toByteArray();
    }
    static Bitmap decode(byte[] bytes) throws IOException {
        BitmapFactory.Options options = new BitmapFactory.Options(); options.inJustDecodeBounds = true; BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (options.outWidth <= 0 || options.outHeight <= 0) throw new IOException("Not an image");
        int sample = 1; while (Math.max(options.outWidth, options.outHeight) / sample > 4096) sample *= 2;
        options.inJustDecodeBounds = false; options.inSampleSize = sample;
        Bitmap image;
        if (android.os.Build.VERSION.SDK_INT >= 28) {
            final int target = sample;
            image = ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes)), (decoder, info, source) -> { decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE); decoder.setTargetSampleSize(target); });
        } else {
            image = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
            if (image != null) {
                try {
                    int orientation = new android.media.ExifInterface(new ByteArrayInputStream(bytes)).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1);
                    Matrix transform = new Matrix();
                    switch (orientation) {
                        case 2: transform.setScale(-1,1); break;
                        case 3: transform.setRotate(180); break;
                        case 4: transform.setScale(1,-1); break;
                        case 5: transform.setRotate(90); transform.postScale(-1,1); break;
                        case 6: transform.setRotate(90); break;
                        case 7: transform.setRotate(-90); transform.postScale(-1,1); break;
                        case 8: transform.setRotate(-90); break;
                    }
                    if (!transform.isIdentity()) { Bitmap rotated = Bitmap.createBitmap(image,0,0,image.getWidth(),image.getHeight(),transform,true); if (rotated != image) image.recycle(); image = rotated; }
                } catch (IOException ignored) { /* Formats without EXIF retain their decoded orientation. */ }
            }
        }
        if (image == null) throw new IOException("Not an image");
        return image;
    }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) { super.onRequestPermissionsResult(request, permissions, results); capture.permissions(request); }
    @Override protected void onDestroy() { capture.cancel(); ++generation; decoder.shutdownNow(); if (view != null) view.image(null); super.onDestroy(); }
    static final class ZoomImage extends View {
        private Bitmap bitmap;
        private float zoom = 1, offsetX, offsetY, lastX, lastY;
        private final ScaleGestureDetector pinch;
        private final GestureDetector taps;
        ZoomImage(android.content.Context context) {
            super(context); setContentDescription("Image preview. Pinch to zoom, drag to pan, double-tap to zoom or fit.");
            pinch = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                @Override public boolean onScale(ScaleGestureDetector detector) { zoom = Math.max(1, Math.min(8, zoom * detector.getScaleFactor())); bound(); invalidate(); return true; }
            });
            taps = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
                @Override public boolean onDown(MotionEvent e) { return true; }
                @Override public boolean onDoubleTap(MotionEvent e) { zoom = zoom > 1 ? 1 : 2.5f; offsetX = offsetY = 0; invalidate(); return true; }
            });
        }
        void image(Bitmap next) { Bitmap old = bitmap; bitmap = next; reset(); if (old != null && old != next) old.recycle(); }
        void reset() { zoom = 1; offsetX = offsetY = 0; invalidate(); }
        float zoom() { return zoom; }
        private float fit() { return bitmap == null ? 1 : Math.min(getWidth() / (float)bitmap.getWidth(), getHeight() / (float)bitmap.getHeight()); }
        private void bound() {
            if (bitmap == null) return;
            float scale = fit() * zoom, x = Math.max(0, (bitmap.getWidth() * scale - getWidth()) / 2), y = Math.max(0, (bitmap.getHeight() * scale - getHeight()) / 2);
            offsetX = Math.max(-x, Math.min(x, offsetX)); offsetY = Math.max(-y, Math.min(y, offsetY));
        }
        @Override protected void onSizeChanged(int w, int h, int oldw, int oldh) { bound(); }
        @Override protected void onDraw(Canvas canvas) {
            super.onDraw(canvas); if (bitmap == null) return;
            float scale = fit() * zoom; canvas.save(); canvas.translate((getWidth() - bitmap.getWidth() * scale) / 2 + offsetX, (getHeight() - bitmap.getHeight() * scale) / 2 + offsetY); canvas.scale(scale, scale); canvas.drawBitmap(bitmap, 0, 0, new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG)); canvas.restore();
        }
        @Override public boolean onTouchEvent(MotionEvent event) {
            pinch.onTouchEvent(event); taps.onTouchEvent(event);
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE && event.getPointerCount() == 1 && !pinch.isInProgress()) { offsetX += event.getX() - lastX; offsetY += event.getY() - lastY; bound(); invalidate(); }
            lastX = event.getX(); lastY = event.getY(); return true;
        }
    }
}
