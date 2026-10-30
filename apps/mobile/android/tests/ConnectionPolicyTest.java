package com.stonezhang.liveui;
import java.net.URI;
public final class ConnectionPolicyTest {
    private static int checks = 0;
    private static void check(boolean b) { checks++; if (!b) throw new AssertionError("check " + checks); }
    private static void rejects(String s) { try { ConnectionPolicy.parse(s); throw new AssertionError("accepted invalid URL"); } catch (IllegalArgumentException expected) { checks++; } }
    public static void main(String[] args) {
        URI base = ConnectionPolicy.parse("https://liveui.stonezhang.com/liveui");
        check(base.toString().equals(ConnectionPolicy.DEFAULT_URL));
        check(ConnectionPolicy.sameOrigin(base,"https://liveui.stonezhang.com:443/liveui/agent/run"));
        check(!ConnectionPolicy.sameOrigin(base,"https://liveui.stonezhang.com:444/liveui/"));
        check(!ConnectionPolicy.sameOrigin(base,"http://liveui.stonezhang.com/liveui/"));
        check(!ConnectionPolicy.sameOrigin(base,"https://liveui.stonezhang.com.attacker.example/"));
        check(!ConnectionPolicy.sameOrigin(base,"https://" + "alice@liveui.stonezhang.com/"));
        check(!ConnectionPolicy.sameOrigin(base,"javascript:alert(1)"));
        rejects("http://liveui.stonezhang.com/"); rejects("https://" + "u:p@liveui.stonezhang.com/"); rejects("https://liveui.stonezhang.com/?token=x"); rejects("https://liveui.stonezhang.com/#x"); rejects("https://liveui.stonezhang.com:99999/");
        check(ConnectionPolicy.validBasicChallenge("Basic realm=\"LiveUIAgent\""));
        check(!ConnectionPolicy.validBasicChallenge("Basic realm=\"Other\""));
        check(!ConnectionPolicy.validBasicChallenge("Digest realm=\"LiveUIAgent\""));
        check(ConnectionPolicy.safeFilename("../../private\\file\n.txt").equals(".._.._private_file_.txt"));
        AuthBootstrap auth = new AuthBootstrap(base);
        check(auth.take(base.toString(), "liveui.stonezhang.com", "LiveUIAgent"));
        check(!auth.take(base.toString(), "liveui.stonezhang.com", "LiveUIAgent"));
        check(!new AuthBootstrap(base).take("https://liveui.stonezhang.com:8443/liveui/", "liveui.stonezhang.com", "LiveUIAgent"));
        check(!new AuthBootstrap(base).take(base.toString(), "other.example", "LiveUIAgent"));
        check(!new AuthBootstrap(base).take(base.toString(), "liveui.stonezhang.com", "Other"));
        AuthBootstrap failed = new AuthBootstrap(base);
        check(!failed.take(base.toString(), "other.example", "LiveUIAgent"));
        check(!failed.take(base.toString(), "liveui.stonezhang.com", "LiveUIAgent"));
        AuthBootstrap committed = new AuthBootstrap(base); committed.close();
        check(!committed.take(base.toString(), "liveui.stonezhang.com", "LiveUIAgent"));
        check(ConnectionPolicy.isContentUpload("content://com.android.providers.downloads.documents/document/3"));
        check(!ConnectionPolicy.isContentUpload("file:///data/data/com.stonezhang.liveui/private"));
        check(!ConnectionPolicy.isContentUpload("https://example.com/file.txt"));
        check(!ConnectionPolicy.isContentUpload("javascript:alert(1)"));
        check(!ConnectionPolicy.isContentUpload("content:/missing-authority"));
        System.out.println(checks + " connection policy checks passed");
    }
}
