package com.lumen.reader;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

// Lectura en voz alta con el motor de voz del teléfono (el WebView de Android no trae speechSynthesis).
// speak() se resuelve cuando termina de leer el texto; stop() corta y resuelve lo pendiente con stopped=true.
@CapacitorPlugin(name = "LumenTts")
public class TtsPlugin extends Plugin {
    private TextToSpeech tts;
    private boolean ready = false;
    private final Map<String, PluginCall> pending = new HashMap<>();

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), (status) -> {
            ready = status == TextToSpeech.SUCCESS;
            if (ready) tts.setLanguage(Locale.forLanguageTag("es"));
        });
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String id) {}
            @Override public void onDone(String id) { finish(id, false); }
            @Override public void onError(String id) {
                PluginCall c;
                synchronized (pending) { c = pending.remove(id); }
                if (c != null) c.reject("No se pudo leer en voz alta");
            }
            @Override public void onStop(String id, boolean interrupted) { finish(id, true); }
        });
    }

    private void finish(String id, boolean stopped) {
        PluginCall c;
        synchronized (pending) { c = pending.remove(id); }
        if (c == null) return;
        JSObject r = new JSObject();
        r.put("stopped", stopped);
        c.resolve(r);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject r = new JSObject();
        r.put("available", ready);
        call.resolve(r);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        if (!ready) { call.reject("El teléfono no tiene un motor de voz activo"); return; }
        String text = call.getString("text", "");
        Float rate = call.getFloat("rate", 1f);
        String lang = call.getString("lang", "es");
        tts.setLanguage(Locale.forLanguageTag(lang));
        tts.setSpeechRate(rate == null ? 1f : rate);
        String id = UUID.randomUUID().toString();
        synchronized (pending) { pending.put(id, call); }
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
            synchronized (pending) { pending.remove(id); }
            call.reject("No se pudo leer en voz alta");
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        // Por si el motor no avisa onStop: se liberan las lecturas pendientes.
        Map<String, PluginCall> copy;
        synchronized (pending) { copy = new HashMap<>(pending); pending.clear(); }
        for (PluginCall c : copy.values()) {
            JSObject r = new JSObject();
            r.put("stopped", true);
            c.resolve(r);
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) tts.shutdown();
    }
}
