package com.stonezhang.liveui;

import android.content.*;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;

/** Narrow grant-only provider: a camera can access only the named, app-created capture. */
public final class CaptureProvider extends ContentProvider {
    static File file(Context context, Uri uri) throws FileNotFoundException {
        if (!"content".equals(uri.getScheme()) || !(context.getPackageName() + ".captures").equals(uri.getAuthority()) || uri.getQuery() != null || uri.getFragment() != null || uri.getPathSegments().size() != 1) throw new FileNotFoundException();
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches("ulemi-capture-[a-f0-9-]{36}\\.jpg")) throw new FileNotFoundException();
        File file = new File(context.getCacheDir(), name);
        if (!file.isFile()) throw new FileNotFoundException();
        return file;
    }
    @Override public boolean onCreate() { return true; }
    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(file(getContext(), uri), ParcelFileDescriptor.parseMode(mode));
    }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String order) {
        try {
            File file = file(getContext(), uri); String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor cursor = new MatrixCursor(columns); Object[] values = new Object[columns.length];
            for (int i=0;i<columns.length;i++) values[i] = OpenableColumns.DISPLAY_NAME.equals(columns[i]) ? file.getName() : OpenableColumns.SIZE.equals(columns[i]) ? file.length() : null;
            cursor.addRow(values); return cursor;
        } catch (FileNotFoundException e) { return null; }
    }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
}
