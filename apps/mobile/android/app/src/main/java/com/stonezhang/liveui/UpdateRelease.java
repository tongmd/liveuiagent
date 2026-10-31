package com.stonezhang.liveui;

import org.json.JSONObject;

final class UpdateRelease {
    final long versionCode, size;
    final String packageName, versionName, url, sha256, notes;
    final int minSdk;
    UpdateRelease(JSONObject o) throws Exception {
        for (String key : new String[]{"schemaVersion", "versionCode", "size", "minSdk"}) {
            Object value = o.get(key); if (!(value instanceof Integer) && !(value instanceof Long)) throw new IllegalArgumentException("Update numbers must be integers");
        }
        for (String key : new String[]{"packageName", "versionName", "url", "sha256"}) if (!(o.get(key) instanceof String)) throw new IllegalArgumentException("Invalid update text");
        if (o.has("notes") && !(o.get("notes") instanceof String)) throw new IllegalArgumentException("Invalid update notes");
        if (o.getInt("schemaVersion") != 1) throw new IllegalArgumentException("Unsupported update format");
        packageName = o.getString("packageName"); versionCode = o.getLong("versionCode");
        versionName = o.getString("versionName"); size = o.getLong("size"); minSdk = o.getInt("minSdk");
        url = o.getString("url"); sha256 = o.getString("sha256"); notes = o.optString("notes", "");
        UpdatePolicy.metadata(packageName, versionCode, versionName, minSdk, size, sha256);
        UpdatePolicy.trustedUrl(url, true);
        if (notes.length() > 2000) throw new IllegalArgumentException("Update notes are too long");
    }
    JSONObject json() throws Exception {
        return new JSONObject().put("schemaVersion", 1).put("packageName", packageName).put("versionCode", versionCode)
            .put("versionName", versionName).put("size", size).put("minSdk", minSdk).put("url", url).put("sha256", sha256).put("notes", notes);
    }
}
