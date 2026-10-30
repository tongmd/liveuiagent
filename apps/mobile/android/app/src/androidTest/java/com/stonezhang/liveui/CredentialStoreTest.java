package com.stonezhang.liveui;
import android.test.AndroidTestCase;
public final class CredentialStoreTest extends AndroidTestCase {
    public void testEncryptedRoundTripAndLogout() throws Exception {
        CredentialStore s = new CredentialStore(getContext(), ".test"); s.clear();
        s.save(ConnectionPolicy.DEFAULT_URL, "test-user", "test-password-unique");
        assertEquals("test-user", s.load().getString("user"));
        assertEquals("test-password-unique", s.load().getString("password"));
        String stored = getContext().getSharedPreferences("connection.test",0).getString("data", "");
        assertFalse(stored.contains("test-password-unique")); assertFalse(stored.contains("test-user"));
        s.clear(); assertNull(s.load());
    }
    public void testOriginBoundaries() {
        assertFalse(ConnectionPolicy.sameOrigin(ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL), "https://liveui.stonezhang.com:8443/"));
        assertFalse(ConnectionPolicy.sameOrigin(ConnectionPolicy.parse(ConnectionPolicy.DEFAULT_URL), "http://liveui.stonezhang.com/"));
    }
}
