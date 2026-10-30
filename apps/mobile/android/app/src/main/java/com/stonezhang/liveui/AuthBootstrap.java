package com.stonezhang.liveui;
import java.net.URI;

/** One challenge for the initial protected document. No subframe or retry credentials. */
final class AuthBootstrap {
    private final URI document;
    private boolean available = true;
    AuthBootstrap(URI document) { this.document = document; }
    boolean take(String currentDocument, String host, String realm) {
        boolean wasAvailable = available;
        available = false;
        return wasAvailable && document.toString().equals(currentDocument)
                && document.getHost().equalsIgnoreCase(host) && ConnectionPolicy.AUTH_REALM.equals(realm);
    }
    void close() { available = false; }
}
