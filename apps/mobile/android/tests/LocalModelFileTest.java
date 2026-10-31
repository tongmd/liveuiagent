package com.stonezhang.liveui;
import java.io.*;
import java.net.*;
import java.nio.file.*;
import java.security.*;
import java.security.cert.Certificate;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.net.ssl.HttpsURLConnection;

public final class LocalModelFileTest {
    static final byte[] BODY = "official-model-fixture".getBytes();
    static String hash(byte[] b) throws Exception { StringBuilder s = new StringBuilder(); for (byte x:MessageDigest.getInstance("SHA-256").digest(b)) s.append(String.format("%02x",x&255)); return s.toString(); }
    static int passed;
    interface Test { void run(File dir) throws Exception; }
    static void test(String name, Test t) throws Exception { File dir = Files.createTempDirectory("model-test").toFile(); try { t.run(dir); passed++; System.out.println("PASS " + name); } finally { try (var paths = Files.walk(dir.toPath())) { paths.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete()); } } }
    static void require(boolean value) { if (!value) throw new AssertionError(); }
    static void rejects(RunnableThrow r) throws Exception { boolean failed=false; try { r.run(); } catch (IOException e) { failed=true; } require(failed); }
    interface RunnableThrow { void run() throws Exception; }
    static Fake response(int code, byte[] bytes, String range) throws Exception { return new Fake(code, bytes, range); }
    static LocalModelFile model(File d, Fake f) throws Exception { return new LocalModelFile(d,"https://huggingface.co/pinned",BODY.length,hash(BODY), u -> f); }
    static void download(LocalModelFile m) throws Exception { m.download(new AtomicBoolean(),(b,v)->{}); }
    public static void main(String[] args) throws Exception {
        test("complete verified file atomically published", d -> { LocalModelFile m=model(d,response(200,BODY,null));download(m);require(m.installed());require(m.verify(new AtomicBoolean()));require(!new File(d,"gemma-4-e4b.part").exists()); });
        test("resume exact range from persisted partial", d -> { Files.write(new File(d,"gemma-4-e4b.part").toPath(),Arrays.copyOf(BODY,5));Fake f=response(206,Arrays.copyOfRange(BODY,5,BODY.length),"bytes 5-"+(BODY.length-1)+"/"+BODY.length);LocalModelFile m=model(d,f);download(m);require("bytes=5-".equals(f.getRequestProperty("Range")));require(m.verify(new AtomicBoolean())); });
        test("ignored range resets partial", d -> { Files.write(new File(d,"gemma-4-e4b.part").toPath(),new byte[]{0,0,0});LocalModelFile m=model(d,response(200,BODY,null));download(m);require(m.verify(new AtomicBoolean())); });
        test("incorrect206 refused before write", d -> { File p=new File(d,"gemma-4-e4b.part");Files.write(p.toPath(),Arrays.copyOf(BODY,5)); LocalModelFile m=model(d,response(206,Arrays.copyOfRange(BODY,5,BODY.length),"bytes 6-20/21"));rejects(()->download(m));require(p.length()==5);require(!m.installed()); });
        test("same length corruption never ready", d -> { byte[] b=BODY.clone();b[0]^=1;LocalModelFile m=model(d,response(200,b,null));rejects(()->download(m));require(!m.installed());require(m.downloaded()==0); });
        test("cancel keeps partial and no ready model", d -> { AtomicBoolean cancelled=new AtomicBoolean(); Fake f=response(200,BODY,null);f.onRead=()->cancelled.set(true);LocalModelFile m=model(d,f);rejects(()->m.download(cancelled,(b,v)->{}));require(!m.installed()); });
        test("truncated unknown length kept for resume", d -> { Fake f=response(200,Arrays.copyOf(BODY,7),null);f.length=-1; LocalModelFile m=model(d,f);rejects(()->download(m));require(m.downloaded()==7);require(!m.installed()); });
        test("oversize response rejected", d -> { Fake f=response(200,Arrays.copyOf(BODY,BODY.length+1),null);f.length=-1;LocalModelFile m=model(d,f);rejects(()->download(m));require(!m.installed()); });
        test("HTTP error not a model", d -> { LocalModelFile m=model(d,response(403,BODY,null));rejects(()->download(m));require(!m.installed()); });
        test("HTTPS downgrade redirect refused", d -> { Fake f=response(302,new byte[0],null);f.redirect="http://example.invalid/model";LocalModelFile m=model(d,f);rejects(()->download(m));require(!m.installed()); });
        test("corrupt installed model replaced from verified source", d -> { File p=new File(d,"gemma-4-e4b.litertlm");Files.write(p.toPath(),new byte[BODY.length]);LocalModelFile m=model(d,response(200,BODY,null));download(m);require(m.verify(new AtomicBoolean())); });
        test("storage requirement subtracts resumed bytes", d -> require(LocalModelFile.requiredSpace(100,40)==60+LocalModelFile.RESERVE));
        test("delete removes only model and partial", d -> { File other=new File(d,"unrelated");Files.write(other.toPath(),BODY);LocalModelFile m=model(d,response(200,BODY,null));download(m);m.delete();require(!m.installed());require(other.exists()); });
        System.out.println(passed+" tests passed");
    }
    static final class Fake extends HttpsURLConnection {
        int code;byte[] bytes;String range,redirect;long length;Runnable onRead;
        Fake(int code,byte[] bytes,String range) throws Exception {super(new URL("https://huggingface.co/pinned"));this.code=code;this.bytes=bytes;this.range=range;length=bytes.length;}
        public int getResponseCode(){return code;} public String getHeaderField(String name){return "Content-Range".equals(name)?range:"Location".equals(name)?redirect:null;}
        public long getContentLengthLong(){return length;} public InputStream getInputStream(){if(onRead!=null)onRead.run();return new ByteArrayInputStream(bytes);}
        public void disconnect(){}public boolean usingProxy(){return false;}public void connect(){}public String getCipherSuite(){return "fixture";}public Certificate[] getLocalCertificates(){return null;}public Certificate[] getServerCertificates(){return null;}
    }
}
