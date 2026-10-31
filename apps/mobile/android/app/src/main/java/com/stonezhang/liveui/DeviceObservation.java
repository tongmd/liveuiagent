package com.stonezhang.liveui;

import org.json.*;
import java.text.SimpleDateFormat;
import java.util.*;

/** Immutable capture envelope passed once from native readings into the user's workspace draft. */
public final class DeviceObservation {
    private DeviceObservation() { }
    public static String timestamp(long unixMillis) { return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US).format(new Date(unixMillis)); }
    public static JSONObject create(String kind, String source, JSONObject values, String description) {
        try {
            return new JSONObject().put("id", UUID.randomUUID().toString()).put("kind", kind)
                .put("source", source).put("capturedAt", timestamp(System.currentTimeMillis()))
                .put("values", values).put("description", description);
        } catch (JSONException e) { throw new IllegalArgumentException("Unable to record device observation", e); }
    }
    public static String readable(JSONObject observation) throws JSONException {
        return "Device observation\nSource: " + observation.getString("source") + "\nCaptured: " + observation.getString("capturedAt")
            + "\n" + observation.getString("description");
    }
    public static String composerScript(String serialized, String origin) throws JSONException {
        JSONObject capture = new JSONObject(serialized);
        String text = JSONObject.quote(readable(capture)).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        String id = JSONObject.quote(capture.getString("id"));
        return "(()=>{if(location.origin!==" + JSONObject.quote(origin) + ")return 'wrong_origin';"
            + "const seen=window.__ulemiDeviceCaptures||(window.__ulemiDeviceCaptures=new Map());const old=seen.get("+id+");if(old?.done)return 'already_added';"
            + "const visible=x=>x&&x.getClientRects().length&&getComputedStyle(x).visibility!=='hidden';"
            + "const sheets=[...document.querySelectorAll('.app-sheet')].filter(visible).sort((a,b)=>(parseInt(getComputedStyle(a).zIndex)||0)-(parseInt(getComputedStyle(b).zIndex)||0));"
            + "const scope=sheets.at(-1);const input=scope?[...scope.querySelectorAll('.ulemi-native-compose textarea,.rich-workspace-request textarea,.complete-app-edit textarea')].find(visible):[...document.querySelectorAll('.liveui-composer textarea,.frontend-prompt textarea')].find(visible);"
            + "if(!input||input.disabled||input.readOnly)return 'composer_unavailable';"
            + "const addition="+text+";if(old&&old.input===input&&input.value.includes(old.addition))return 'staged';"
            + "const value=input.value+(input.value.trim()?'\\n\\n':'')+addition;if(input.maxLength>=0&&value.length>input.maxLength)return 'draft_too_long';"
            + "const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(input,value);"
            + "seen.set("+id+",{input,addition,done:false});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));"
            + "input.focus();return 'staged';})()";
    }
    public static String acknowledgementScript(String serialized, String origin) throws JSONException {
        String id = JSONObject.quote(new JSONObject(serialized).getString("id"));
        return "(()=>{if(location.origin!=="+JSONObject.quote(origin)+")return 'wrong_origin';const item=window.__ulemiDeviceCaptures?.get("+id+");"
            + "if(!item||!item.input.isConnected||!item.input.value.includes(item.addition))return 'draft_not_updated';item.done=true;return 'added';})()";
    }
}
