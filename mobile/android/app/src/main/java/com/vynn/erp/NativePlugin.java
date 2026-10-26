package com.vynn.erp;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.Settings;
import androidx.appcompat.app.AlertDialog;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS: Capacitor.registerPlugin('VynnNative')
 *  - startTracking() while the person is clocked in, stopTracking() on clock-out or logout.
 *    Before Android's own permission prompt, explains in Thai why location is needed (PDPA).
 *  - print(): Android's WebView ignores window.print(), so "พิมพ์ / บันทึก PDF" calls this to open
 *    the system print dialog (which can also save a PDF).
 */
@CapacitorPlugin(
    name = "VynnNative",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NativePlugin extends Plugin {

    private static final String KEY_BATTERY_ASKED = "battery_asked";

    @PluginMethod
    public void startTracking(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            run(call);
            return;
        }
        getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
            .setTitle("ขออนุญาตใช้ตำแหน่ง (GPS)")
            .setMessage(
                "ระหว่างที่คุณลงเวลาเข้างาน VYNN ERP จะบันทึกตำแหน่งของเครื่องประมาณทุก 3 นาที " +
                "แม้ปิดจอหรือสลับไปใช้แอปอื่น เพื่อใช้ยืนยันการเข้างานและการไปหน้างาน\n\n" +
                "• บันทึกเฉพาะช่วงเข้างาน หยุดทันทีเมื่อกดออกงาน\n" +
                "• มีแจ้งเตือนค้างไว้ตลอดเวลาที่บันทึก\n" +
                "• เห็นได้เฉพาะ CEO และเก็บไว้ 60 วัน\n\n" +
                "ในหน้าถัดไป กรุณาเลือก \"ขณะใช้แอป\" และ \"ตำแหน่งที่แน่นอน\"")
            .setCancelable(false)
            .setPositiveButton("ดำเนินการต่อ", (d, w) -> ask(call))
            .setNegativeButton("ไม่อนุญาต", (d, w) -> resolve(call, false, "denied"))
            .show());
    }

    private void ask(PluginCall call) {
        String[] aliases = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            ? new String[] { "location", "notifications" }
            : new String[] { "location" };
        requestPermissionForAliases(aliases, call, "permsDone");
    }

    @PermissionCallback
    private void permsDone(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) run(call);
        else resolve(call, false, "denied");
    }

    private void run(PluginCall call) {
        TrackerService.start(getContext(), getBridge().getServerUrl());
        askBatteryOnce();
        resolve(call, true, null);
    }

    /** Some phones (Xiaomi, Oppo, Vivo, Samsung) kill background work to save battery; ask once to be left alone. */
    @SuppressLint("BatteryLife")
    private void askBatteryOnce() {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        android.content.SharedPreferences p = ctx.getSharedPreferences(TrackerService.PREFS, Context.MODE_PRIVATE);
        if (pm.isIgnoringBatteryOptimizations(ctx.getPackageName()) || p.getBoolean(KEY_BATTERY_ASKED, false)) return;
        p.edit().putBoolean(KEY_BATTERY_ASKED, true).apply();
        getActivity().runOnUiThread(() -> new AlertDialog.Builder(getActivity())
            .setTitle("ให้บันทึกตำแหน่งได้ต่อเนื่อง")
            .setMessage("มือถือบางรุ่นหยุดแอปที่ทำงานเบื้องหลังเพื่อประหยัดแบตเตอรี่ ทำให้ตำแหน่งขาดหาย\n\nกด \"ตั้งค่า\" แล้วเลือก \"อนุญาต\" เพื่อไม่ให้ระบบหยุด VYNN ERP ระหว่างเข้างาน")
            .setPositiveButton("ตั้งค่า", (d, w) -> {
                try {
                    getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + ctx.getPackageName())));
                } catch (Exception e) {
                    getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            })
            .setNegativeButton("ไว้ทีหลัง", null)
            .show());
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        TrackerService.stop(getContext());
        resolve(call, false, null);
    }

    @PluginMethod
    public void trackingStatus(PluginCall call) {
        resolve(call, TrackerService.isOn(getContext()), null);
    }

    @PluginMethod
    public void print(PluginCall call) {
        String t = call.getString("title", "");
        String name = t == null || t.trim().isEmpty() ? "VYNN ERP" : t.trim();
        getActivity().runOnUiThread(() -> {
            PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            pm.print(name, getBridge().getWebView().createPrintDocumentAdapter(name), new PrintAttributes.Builder().build());
            call.resolve();
        });
    }

    private void resolve(PluginCall call, boolean tracking, String reason) {
        JSObject r = new JSObject();
        r.put("tracking", tracking);
        if (reason != null) r.put("reason", reason);
        call.resolve(r);
    }
}
