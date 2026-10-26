#!/usr/bin/env bash
# Runs inside the Android emulator job (see .github/workflows/android-apk.yml).
# Checks that the tracker keeps posting GPS with the screen off and stops after clock-out.
set -u
LOG=mobile/test/pings.log
PKG=com.vynn.erp
adb install -r VYNN-ERP-test.apk
adb shell pm grant $PKG android.permission.ACCESS_FINE_LOCATION
adb shell pm grant $PKG android.permission.ACCESS_COARSE_LOCATION
adb shell pm grant $PKG android.permission.POST_NOTIFICATIONS || true
adb emu geo fix 100.5018 13.7563
adb shell am start -n $PKG/.MainActivity
sleep 40
adb emu geo fix 100.5100 13.7600
echo "--- screen off + doze"
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
echo "pings=$PINGS with_loc=$WITH_LOC with_cookie=$WITH_COOKIE service_after_clockout=$RUNNING"
adb logcat -d -s VynnTracker:* Capacitor:E | tail -40
[ "$PINGS" -ge 3 ] && [ "$WITH_LOC" -ge 2 ] && [ "$WITH_COOKIE" -eq "$PINGS" ] && [ "$RUNNING" -eq 0 ]
