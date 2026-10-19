package com.lumen.reader;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

// Documentos que llegan con "Abrir con" o "Compartir" desde otras apps (WhatsApp, Drive, Archivos…).
// MainActivity los copia a cache/incoming y la web los toma con take().
@CapacitorPlugin(name = "LumenIncoming")
public class IncomingPlugin extends Plugin {
    private static final List<JSObject> queue = new ArrayList<>();
    private static IncomingPlugin instance;

    @Override
    public void load() { instance = this; }

    static void add(JSObject file) {
        synchronized (queue) { queue.add(file); }
        if (instance != null) instance.notifyListeners("files", new JSObject());
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray arr = new JSArray();
        synchronized (queue) {
            for (JSObject o : queue) arr.put(o);
            queue.clear();
        }
        JSObject r = new JSObject();
        r.put("files", arr);
        call.resolve(r);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        File[] files = new File(getContext().getCacheDir(), "incoming").listFiles();
        if (files != null) for (File f : files) f.delete();
        call.resolve();
    }
}
