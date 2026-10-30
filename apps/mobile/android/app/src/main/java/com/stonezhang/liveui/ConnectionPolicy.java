package com.stonezhang.liveui;

import java.net.URI;
import java.util.Locale;

/** URL and authentication boundaries shared by the browser and the downloader. */
public final class ConnectionPolicy {
    public static final String DEFAULT_URL = "https://liveui.stonezhang.com/liveui/";
    public static final String AUTH_REALM = "LiveUIAgent";
    public static URI parse(String input) {
        URI u = URI.create(input.trim()).normalize();
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getUserInfo() != null
                || u.getFragment() != null || u.getQuery() != null || u.getPort() == 0 || u.getPort() > 65535
                || input.indexOf('\\') >= 0 || input.indexOf('\r') >= 0 || input.indexOf('\n') >= 0)
            throw new IllegalArgumentException("请输入不含账号、参数或片段的 HTTPS 地址");
        String path = u.getRawPath();
        if (path == null || path.isEmpty()) path = "/";
        if (!path.endsWith("/")) path += "/";
        return URI.create("https://" + u.getRawAuthority().toLowerCase(Locale.ROOT) + path);
    }
    public static boolean sameOrigin(URI base, String value) {
        try {
            URI u = URI.create(value);
            return "https".equalsIgnoreCase(u.getScheme()) && u.getUserInfo() == null
                    && base.getHost().equalsIgnoreCase(u.getHost()) && port(base) == port(u);
        } catch (Exception ignored) { return false; }
    }
    private static int port(URI u) { return u.getPort() == -1 ? 443 : u.getPort(); }
    public static String safeFilename(String value) {
        String s = value == null ? "download" : value.replaceAll("[\\\\/\\p{Cntrl}]", "_");
        return s.trim().isEmpty() ? "download" : s.substring(0, Math.min(120, s.length()));
    }
    public static boolean validBasicChallenge(String header) {
        return header != null && header.matches("(?i)^Basic\\s+realm=\"LiveUIAgent\"(?:\\s*,\\s*charset=\"UTF-8\")?\\s*$");
    }
}
