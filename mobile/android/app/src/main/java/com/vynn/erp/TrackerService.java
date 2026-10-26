package com.vynn.erp;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/**
 * Foreground service that keeps reporting the phone's location while the person is clocked in,
 * also with the screen off or the app in the background.
 *
 * It calls the same endpoint as the web app (POST /api/auth {a:"ping", loc}) with the WebView's
 * login cookie. The server stores a point only while a shift is open, so the service stops on its
 * own when the person clocks out (open == null) or the session ends (401).
 */
public class TrackerService extends Service {

    static final String PREFS = "vynn_tracker";
    static final String KEY_ON = "on";
    static final String KEY_SERVER = "server";
    static final String EXTRA_SERVER = "server";

    private static final String TAG = "VynnTracker";
    private static final String CHANNEL = "tracking";
    private static final int NOTIF_ID = 3001;
    private static final long PING_EVERY_MS = 3 * 60 * 1000L; // same cadence as the web app
    private static final long GPS_EVERY_MS = 60 * 1000L;
    private static final long MAX_FIX_AGE_MS = 10 * 60 * 1000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newSingleThreadExecutor();
    private LocationManager lm;
    private PowerManager.WakeLock wake;
    private Location best;
    private String server;
    private boolean running;

    private final LocationListener listener = this::onFix;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            send();
            handler.postDelayed(this, PING_EVERY_MS);
        }
    };

    static void start(Context ctx, String server) {
        prefs(ctx).edit().putBoolean(KEY_ON, true).putString(KEY_SERVER, server).apply();
        Intent i = new Intent(ctx, TrackerService.class).putExtra(EXTRA_SERVER, server);
        androidx.core.content.ContextCompat.startForegroundService(ctx, i);
    }

    static void stop(Context ctx) {
        prefs(ctx).edit().putBoolean(KEY_ON, false).apply();
        ctx.stopService(new Intent(ctx, TrackerService.class));
    }

    static boolean isOn(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ON, false);
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A null intent means Android restarted the service after killing it (START_STICKY).
        server = intent != null ? intent.getStringExtra(EXTRA_SERVER) : null;
        if (server == null) server = prefs(this).getString(KEY_SERVER, null);
        if (server == null || !isOn(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        server = server.replaceAll("/+$", "");

        try {
            ServiceCompat.startForeground(this, NOTIF_ID, notification(),
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION : 0);
        } catch (Exception e) {
            // Android refuses a location service without the location permission.
            Log.w(TAG, "cannot start foreground", e);
            prefs(this).edit().putBoolean(KEY_ON, false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!running) begin();
        return START_STICKY;
    }

    @SuppressLint("MissingPermission")
    private void begin() {
        running = true;
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VynnErp:tracker");
        wake.setReferenceCounted(false);
        wake.acquire(14 * 60 * 60 * 1000L); // a long shift at most
        lm = (LocationManager) getSystemService(LOCATION_SERVICE);
        for (String p : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
            try {
                if (lm.isProviderEnabled(p)) {
                    lm.requestLocationUpdates(p, GPS_EVERY_MS, 0f, listener, Looper.getMainLooper());
                    onFix(lm.getLastKnownLocation(p));
                }
            } catch (Exception e) {
                Log.w(TAG, "provider " + p, e);
            }
        }
        handler.postDelayed(tick, 15 * 1000L); // first report soon after clocking in
    }

    private void onFix(Location l) {
        if (l == null) return;
        if (best == null
            || l.getTime() - best.getTime() > 2 * 60 * 1000L // newer
            || l.getAccuracy() <= best.getAccuracy() * 1.5f) best = l; // or about as sharp
    }

    private void send() {
        final Location l = best;
        final String cookie = CookieManager.getInstance().getCookie(server);
        net.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("a", "ping");
                if (l != null && System.currentTimeMillis() - l.getTime() < MAX_FIX_AGE_MS) {
                    body.put("loc", new JSONObject()
                        .put("lat", l.getLatitude())
                        .put("lng", l.getLongitude())
                        .put("acc", Math.round(l.getAccuracy())));
                }
                HttpURLConnection c = (HttpURLConnection) new URL(server + "/api/auth").openConnection();
                c.setRequestMethod("POST");
                c.setConnectTimeout(20000);
                c.setReadTimeout(20000);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json");
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                try (OutputStream o = c.getOutputStream()) {
                    o.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                if (code == 401) {
                    handler.post(this::finish); // logged out
                    return;
                }
                if (code != 200) return; // try again next round
                try (InputStream in = c.getInputStream()) {
                    String res = new String(readAll(in), StandardCharsets.UTF_8);
                    if (new JSONObject(res).isNull("open")) handler.post(this::finish); // clocked out
                }
            } catch (Exception e) {
                Log.w(TAG, "ping failed: " + e.getMessage()); // no signal; keep the service and retry
            }
        });
    }

    private void finish() {
        stop(this);
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        return b.toByteArray();
    }

    private Notification notification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "บันทึกตำแหน่งระหว่างเข้างาน", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("แสดงตลอดเวลาที่ลงเวลาเข้างานอยู่ และหายไปเมื่อกดออกงาน");
            nm.createNotificationChannel(ch);
        }
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_tracking)
            .setContentTitle("กำลังเข้างาน · บันทึกตำแหน่ง")
            .setContentText("VYNN ERP บันทึกตำแหน่งประมาณทุก 3 นาที จนกว่าจะกดออกงาน")
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .build();
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(tick);
        if (lm != null) lm.removeUpdates(listener);
        if (wake != null && wake.isHeld()) wake.release();
        net.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
