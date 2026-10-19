package com.lumen.reader;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Log;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TtsPlugin.class);
        registerPlugin(IncomingPlugin.class);
        super.onCreate(savedInstanceState);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    // "Abrir con Lumen" (VIEW) y "Compartir a Lumen" (SEND / SEND_MULTIPLE).
    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) uris.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;
        String type = intent.getType();
        // Se marca como atendido para que al rotar la pantalla no se vuelva a importar.
        intent.setAction(null);
        new Thread(() -> { for (Uri u : uris) copyIn(u, type); }).start();
    }

    private void copyIn(Uri uri, String type) {
        try {
            String name = displayName(uri);
            File dir = new File(getCacheDir(), "incoming");
            dir.mkdirs();
            File out = new File(dir, name);
            try (InputStream in = getContentResolver().openInputStream(uri);
                 OutputStream os = new FileOutputStream(out)) {
                if (in == null) return;
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            }
            JSObject o = new JSObject();
            o.put("uri", Uri.fromFile(out).toString());
            o.put("name", name);
            String mime = getContentResolver().getType(uri);
            o.put("mime", mime != null ? mime : type);
            IncomingPlugin.add(o);
        } catch (Exception e) {
            Log.w("Lumen", "No se pudo recibir el documento", e);
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) { }
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "documento";
        name = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (!name.contains(".")) {
            String t = getContentResolver().getType(uri);
            if (t == null) t = "";
            if (t.equals("application/pdf")) name += ".pdf";
            else if (t.contains("epub")) name += ".epub";
            else if (t.contains("wordprocessing")) name += ".docx";
            else name += ".txt";
        }
        return name;
    }
}
