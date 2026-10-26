#!/usr/bin/env bash
# Runs inside the Android emulator job (see .github/workflows/android-apk.yml).
# Checks that the tracker keeps posting GPS with the screen off and stops after clock-out.
set -u
LOG=mobile/test/pings.log
PKG=com.vynn.erp
timeout 120 adb install -r VYNN-ERP-test.apk
adb shell pm grant $PKG android.permission.ACCESS_FINE_LOCATION
adb shell pm grant $PKG android.permission.ACCESS_COARSE_LOCATION
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb emu geo fix 100.5018 13.7563
adb shell am start -n $PKG/.MainActivity
sleep 40
adb emu geo fix 100.5100 13.7600
echo "--- screen off + doze"
OFF_AT=$(date -u +%Y-%m-%dT%H:%M:%S)
adb shell input keyevent KEYCODE_SLEEP
adb shell dumpsys deviceidle force-idle || true
sleep 400
adb shell dumpsys activity services $PKG | grep -E "TrackerService|isForeground" || true
echo "--- clock out"
curl -s http://127.0.0.1:8080/clockout
sleep 200
RUNNING=$(adb shell dumpsys activity services $PKG | grep -c TrackerService || true)
adb shell dumpsys deviceidle unforce || true
echo "--- log"; cat $LOG
PINGS=$(grep -c '"u":"/api/auth"' $LOG || true)
WITH_LOC=$(grep '"u":"/api/auth"' $LOG | grep -c 'lat' || true)
WITH_COOKIE=$(grep '"u":"/api/auth"' $LOG | grep -c 'TESTTOKEN' || true)
SCREEN_OFF_PINGS=$(awk -v t="$OFF_AT" -F'"t":"' '/"u":"\/api\/auth"/{split($2,a,"\"");if(a[1]>t)n++}END{print n+0}' $LOG)
RES="pings=$PINGS with_loc=$WITH_LOC with_cookie=$WITH_COOKIE pings_while_screen_off=$SCREEN_OFF_PINGS service_after_clockout=$RUNNING"
echo "$RES"
echo "::notice title=Emulator GPS test::$RES"
DIAG="requests=$(wc -l < $LOG 2>/dev/null || echo 0) | $(tail -5 $LOG 2>/dev/null | cut -c1-160 | tr '\n' ' ') | $(adb logcat -d -s VynnTracker:* Capacitor:* Capacitor/Console:* AndroidRuntime:E | tail -15 | cut -c1-200 | tr '\n' ' ')"
echo "$DIAG"
echo "::notice title=Emulator diagnostics::${DIAG//%/%25}"
[ "$PINGS" -ge 3 ] && [ "$WITH_LOC" -ge 2 ] && [ "$SCREEN_OFF_PINGS" -ge 2 ] && [ "$WITH_COOKIE" -eq "$PINGS" ] && [ "$RUNNING" -eq 0 ]
