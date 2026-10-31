package com.stonezhang.liveui;

import android.app.*;
import android.content.*;
import android.graphics.*;
import android.net.Uri;
import android.os.SystemClock;
import android.view.*;
import android.webkit.PermissionRequest;
import java.io.*;

final class MediaChecks {
    private static void require(boolean value) { if (!value) throw new AssertionError("Media check failed"); }
    static void decodingAndGestures(Instrumentation test) throws Exception {
        Bitmap source = Bitmap.createBitmap(200, 100, Bitmap.Config.ARGB_8888); source.eraseColor(Color.BLUE);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); require(source.compress(Bitmap.CompressFormat.PNG, 100, bytes)); source.recycle();
        Bitmap decoded = ImageViewerActivity.decode(bytes.toByteArray()); require(decoded.getWidth() == 200 && decoded.getHeight() == 100);
        boolean rejected = false; try { ImageViewerActivity.decode("<html>not an image</html>".getBytes()); } catch (IOException expected) { rejected = true; } require(rejected);
        rejected = false; try { ImageViewerActivity.readBounded(new InputStream() {
            int left = ImageViewerActivity.MAX_BYTES + 1;
            public int read() { return left-- > 0 ? 1 : -1; }
            public int read(byte[] b, int off, int size) { if (left <= 0) return -1; int n = Math.min(size, left); left -= n; return n; }
        }); } catch (IOException expected) { rejected = true; } require(rejected);
        onMain(test, () -> {
            ImageViewerActivity.ZoomImage view = new ImageViewerActivity.ZoomImage(test.getTargetContext()); view.layout(0, 0, 400, 600); view.image(decoded);
            Bitmap frame = Bitmap.createBitmap(400,600,Bitmap.Config.ARGB_8888); view.draw(new Canvas(frame)); require(frame.getPixel(200,300) == Color.BLUE); frame.recycle();
            long t = SystemClock.uptimeMillis(); touch(view,t,t,MotionEvent.ACTION_DOWN,200,300); touch(view,t,t+40,MotionEvent.ACTION_UP,200,300); touch(view,t+120,t+120,MotionEvent.ACTION_DOWN,200,300); touch(view,t+120,t+160,MotionEvent.ACTION_UP,200,300); require(view.zoom() > 1);
            view.reset(); require(view.zoom() == 1);
            view.image(null);
            ImageViewerActivity.ZoomImage pinchView = new ImageViewerActivity.ZoomImage(test.getTargetContext()); pinchView.layout(0,0,1080,1600);
            pinch(pinchView); require(pinchView.zoom() > 1); pinchView.reset(); require(pinchView.zoom() == 1);
        });
    }
    static void originsAndCancellation(Instrumentation test) throws Exception {
        require(WebCapabilityPermissions.androidPermissions(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE, "future-resource"}) == null);
        require(WebCapabilityPermissions.androidPermissions(new String[]{PermissionRequest.RESOURCE_PROTECTED_MEDIA_ID}) == null);
        require(WebCapabilityPermissions.androidPermissions(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}).length == 1);
        Activity activity = test.startActivitySync(new Intent(test.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); SystemClock.sleep(600);
        try { onMain(test, () -> {
            WebCapabilityPermissions gate = new WebCapabilityPermissions(activity, value -> value.equals("https://liveui.stonezhang.com"));
            FakeRequest foreign = new FakeRequest("https://foreign.example", PermissionRequest.RESOURCE_VIDEO_CAPTURE); gate.media(foreign); require(foreign.denied && foreign.granted == null);
            gate.capture("https://liveui.stonezhang.com", () -> {}, () -> {});
            FakeRequest request = new FakeRequest("https://liveui.stonezhang.com", PermissionRequest.RESOURCE_VIDEO_CAPTURE); gate.media(request); require(!request.denied); gate.cancel(); require(request.denied && request.granted == null); gate.result(WebCapabilityPermissions.REQUEST); require(request.granted == null);
            final boolean[] denied = {false}; gate.location("https://foreign.example", (origin, allow, retain) -> denied[0] = !allow && !retain); require(denied[0]);
            final int[] canceled={0}, launched={0};
            gate.capture("https://liveui.stonezhang.com", () -> launched[0]++, () -> canceled[0]++);
            gate.capture("https://liveui.stonezhang.com", () -> launched[0]++, () -> canceled[0]++);
            gate.location("https://liveui.stonezhang.com", (origin,allow,retain) -> { if(!allow)canceled[0]++; });
            gate.cancel(); gate.resume(); require(launched[0]==1 && canceled[0]==3 && !gate.busy());
        }); } finally { onMain(test, activity::finish); }
    }
    static void realPermissionGrantAndApproximateLocation(Instrumentation test) throws Exception {
        String pkg = test.getTargetContext().getPackageName();
        test.getUiAutomation().grantRuntimePermission(pkg, android.Manifest.permission.CAMERA);
        test.getUiAutomation().grantRuntimePermission(pkg, android.Manifest.permission.RECORD_AUDIO);
        test.getUiAutomation().grantRuntimePermission(pkg, android.Manifest.permission.ACCESS_COARSE_LOCATION);
        Activity activity = test.startActivitySync(new Intent(test.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); SystemClock.sleep(600);
        try { onMain(test, () -> {
            try {
                WebCapabilityPermissions gate = new WebCapabilityPermissions(activity, value -> true);
                gate.capture("https://liveui.stonezhang.com", () -> {}, () -> {});
                FakeRequest request = new FakeRequest("https://liveui.stonezhang.com", PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE); gate.media(request);
                final boolean[] allowed = {false}; gate.location("https://liveui.stonezhang.com", (origin, allow, retain) -> allowed[0] = allow && !retain);
                require(request.granted == null && !allowed[0]);
                gate.finishCapture();
                require(request.granted != null && request.granted.length == 2 && !request.denied && allowed[0]);
                require(!gate.busy());
            } catch (Exception e) { throw new AssertionError(e); }
        }); } finally { onMain(test, activity::finish); }
        // Revoking a permission kills its app process. This instrumentation therefore keeps these test-app grants.
    }
    static void captureProviderAndViewer(Instrumentation test) throws Exception {
        Context context = test.getTargetContext();
        require(ImageCapture.imageOnly(new String[]{"image/png", "image/jpeg"})); require(!ImageCapture.imageOnly(new String[]{"*/*"}));
        File file = new File(context.getCacheDir(), "ulemi-capture-" + java.util.UUID.randomUUID() + ".jpg");
        Uri uri = Uri.parse("content://" + context.getPackageName() + ".captures/" + file.getName());
        Bitmap bitmap = Bitmap.createBitmap(200,100,Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.MAGENTA);
        try (FileOutputStream out = new FileOutputStream(file)) { require(bitmap.compress(Bitmap.CompressFormat.JPEG,95,out)); } bitmap.recycle();
        require(CaptureProvider.file(context,uri).equals(file));
        for (String suffix : new String[]{"?query=1", "/../private", "#secret"}) {
            boolean rejected = false; try { CaptureProvider.file(context, Uri.parse(uri + suffix)); } catch (FileNotFoundException expected) { rejected = true; } require(rejected);
        }
        try (InputStream stream = context.getContentResolver().openInputStream(uri)) { require(stream != null && stream.read() == 255); }
        Activity activity = test.startActivitySync(new Intent(context, ImageViewerActivity.class).setData(uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        SystemClock.sleep(700); test.waitForIdleSync();
        onMain(test, () -> {
            try {
                java.lang.reflect.Field field = ImageViewerActivity.class.getDeclaredField("status"); field.setAccessible(true); require(((android.widget.TextView)field.get(activity)).getText().toString().contains("Pinch"));
                Bitmap screenshot = Bitmap.createBitmap(activity.getWindow().getDecorView().getWidth(),activity.getWindow().getDecorView().getHeight(),Bitmap.Config.ARGB_8888); activity.getWindow().getDecorView().draw(new Canvas(screenshot));
                try(FileOutputStream out = new FileOutputStream(new File(context.getFilesDir(),"android-image-viewer.png"))) { screenshot.compress(Bitmap.CompressFormat.PNG,100,out); } screenshot.recycle();
                activity.finish();
            } catch (Exception e) { throw new AssertionError(e); }
        });
        file.delete();
    }
    static void webUploadPixels(Instrumentation test) throws Exception {
        Context context = test.getTargetContext();
        Activity activity = test.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); SystemClock.sleep(600);
        File file = new File(context.getCacheDir(), "ulemi-capture-" + java.util.UUID.randomUUID() + ".jpg");
        Uri uri = Uri.parse("content://" + context.getPackageName() + ".captures/" + file.getName());
        Bitmap bitmap = Bitmap.createBitmap(16,12,Bitmap.Config.ARGB_8888); bitmap.eraseColor(Color.RED);
        try(FileOutputStream out=new FileOutputStream(file)){require(bitmap.compress(Bitmap.CompressFormat.PNG,100,out));} bitmap.recycle();
        require(UploadSelection.parse(Activity.RESULT_CANCELED,new Intent().setData(uri)) == null);
        require(UploadSelection.parse(Activity.RESULT_OK,new Intent().setData(Uri.parse("file:///private"))) == null);
        final android.webkit.WebView[] browser = {null};
        try {
            for (boolean sandbox : new boolean[]{false,true}) {
                java.util.concurrent.CountDownLatch loaded = new java.util.concurrent.CountDownLatch(1);
                java.util.concurrent.CountDownLatch chooser = new java.util.concurrent.CountDownLatch(1);
                String script = "const f=document.getElementById('photo');f.onchange=async()=>{try{const file=f.files[0];const data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(file)});const im=new Image();im.src=data;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').drawImage(im,0,0);parent.postMessage({width:im.width,height:im.height,size:file.size,pixels:[...c.getContext('2d').getImageData(0,0,1,1).data]},'*')}catch(e){parent.postMessage({error:String(e)},'*')}};";
                String css = "<meta name=viewport content=\"width=device-width,initial-scale=1\"><style>html,body{margin:0;padding:0}input{position:absolute;left:16px;top:16px;width:250px;height:64px;font-size:20px}iframe{width:100%;height:160px;border:0}</style>";
                String inner = css + "<input id='photo' type='file' accept='image/*'><script>" + script + "</script>";
                String html = "<html>" + css + "<body><script>window.addEventListener('message',e=>window.uploadResult=e.data)</script>" + (sandbox ? "<iframe sandbox='allow-scripts' srcdoc=\"" + inner.replace("&","&amp;").replace("\"","&quot;") + "\"></iframe>" : inner) + "</body></html>";
                onMain(test, () -> {
                    if(browser[0]!=null)browser[0].destroy();
                    android.webkit.WebView web=new android.webkit.WebView(activity);browser[0]=web;activity.setContentView(web);
                    web.getSettings().setJavaScriptEnabled(true);web.getSettings().setAllowContentAccess(false);web.getSettings().setAllowFileAccess(false);
                    web.setWebViewClient(new android.webkit.WebViewClient(){@Override public void onPageFinished(android.webkit.WebView view,String url){loaded.countDown();}});
                    web.setWebChromeClient(new android.webkit.WebChromeClient(){@Override public boolean onShowFileChooser(android.webkit.WebView view,android.webkit.ValueCallback<Uri[]> callback,FileChooserParams params){callback.onReceiveValue(UploadSelection.parse(Activity.RESULT_OK,new Intent().setData(uri)));chooser.countDown();return true;}});
                    web.loadDataWithBaseURL("https://image-fixture.invalid/",html,"text/html","UTF-8",null);
                });
                require(loaded.await(15,java.util.concurrent.TimeUnit.SECONDS));
                // Both documents use a real user tap; the opaque frame is never scripted by its parent.
                int[] xy = new int[2];onMain(test, () -> browser[0].getLocationOnScreen(xy));
                float density=context.getResources().getDisplayMetrics().density;
                float x=xy[0]+50*density,y=xy[1]+50*density;long when=SystemClock.uptimeMillis();
                test.sendPointerSync(MotionEvent.obtain(when,when,MotionEvent.ACTION_DOWN,x,y,0));
                test.sendPointerSync(MotionEvent.obtain(when,when+25,MotionEvent.ACTION_UP,x,y,0));
                require(chooser.await(10,java.util.concurrent.TimeUnit.SECONDS));
                String value = null;
                for(int i=0;i<50;i++){
                    java.util.concurrent.atomic.AtomicReference<String> result=new java.util.concurrent.atomic.AtomicReference<>();java.util.concurrent.CountDownLatch read=new java.util.concurrent.CountDownLatch(1);
                    onMain(test, () -> browser[0].evaluateJavascript("JSON.stringify(window.uploadResult||null)",v->{result.set(v);read.countDown();}));require(read.await(3,java.util.concurrent.TimeUnit.SECONDS));
                    value=result.get();if(value!=null&&value.contains("pixels"))break;SystemClock.sleep(100);
                }
                require(value != null && value.contains("pixels") && value.contains("255,0,0,255") && value.contains("width"));
                try(FileOutputStream out=new FileOutputStream(new File(context.getFilesDir(),sandbox?"media-upload-sandbox.json":"media-upload-top.json"))){out.write(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));}
            }
        } finally { onMain(test, () -> {if(browser[0]!=null)browser[0].destroy();activity.finish();});file.delete(); }
    }
    private static void onMain(Instrumentation test, Runnable action) {
        java.util.concurrent.atomic.AtomicReference<Throwable> failure = new java.util.concurrent.atomic.AtomicReference<>();
        test.runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError("Main-thread media assertion", failure.get());
    }
    private static void touch(View view,long down,long time,int action,float x,float y) { MotionEvent e=MotionEvent.obtain(down,time,action,x,y,0); view.onTouchEvent(e);e.recycle(); }
    private static void pinch(View view) {
        long t=SystemClock.uptimeMillis(); touch(view,t,t,MotionEvent.ACTION_DOWN,200,600);
        MotionEvent.PointerProperties[] props={new MotionEvent.PointerProperties(),new MotionEvent.PointerProperties()};props[0].id=0;props[1].id=1;props[0].toolType=props[1].toolType=MotionEvent.TOOL_TYPE_FINGER;
        MotionEvent.PointerCoords[] coords={new MotionEvent.PointerCoords(),new MotionEvent.PointerCoords()};coords[0].x=200;coords[1].x=600;coords[0].y=coords[1].y=600;coords[0].pressure=coords[1].pressure=1;coords[0].size=coords[1].size=1;
        for(int i=0;i<5;i++){coords[0].x=200-i*45;coords[1].x=600+i*90;MotionEvent e=MotionEvent.obtain(t,t+20+i*25,i==0?MotionEvent.ACTION_POINTER_DOWN|(1<<MotionEvent.ACTION_POINTER_INDEX_SHIFT):MotionEvent.ACTION_MOVE,2,props,coords,0,0,1,1,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0);view.onTouchEvent(e);e.recycle();}
        touch(view,t,t+160,MotionEvent.ACTION_UP,200,600);
    }
    private static final class FakeRequest extends PermissionRequest {
        final Uri origin; final String[] resources; boolean denied; String[] granted;
        FakeRequest(String origin,String...resources){this.origin=Uri.parse(origin);this.resources=resources;}
        public Uri getOrigin(){return origin;} public String[] getResources(){return resources;}
        public void grant(String[] values){granted=values;} public void deny(){denied=true;}
    }
}
