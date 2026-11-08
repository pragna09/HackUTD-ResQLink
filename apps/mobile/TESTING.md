# Test the mesh on real phones (Android Studio)

**Goal:** Phone A has no signal and presses SOS. The SOS hops over Bluetooth to Phone B, which has internet,
and Phone B uploads it. It then appears on the dashboard on your laptop.

**You need:** 2 Android phones (Android 8 or newer), a USB cable that carries data (not charge-only), and this laptop.
Android and iPhone can't talk to each other over this mesh, and Expo Go can't run this app.

Time: about 45 minutes the first time (mostly downloads). After that, about 5 minutes.

---

## Part 1 — Install Android Studio (once)

1. Download Android Studio from <https://developer.android.com/studio> and run the installer with the defaults.
2. Open Android Studio. In the setup wizard choose **Standard**, accept every licence, and let it download.
   This installs the Android SDK to `C:\Users\<you>\AppData\Local\Android\Sdk`.
3. On the welcome screen open **More Actions → SDK Manager → SDK Tools** tab. Tick these, then click **Apply**:
   - **Android SDK Command-line Tools (latest)**
   - **NDK (Side by side)**
   - **CMake**
4. Close Android Studio. You don't need to open the project in it; the build runs from the terminal.

## Part 2 — Point the terminal at Android (once)

Open **PowerShell** and paste this block. It saves the settings for every future terminal:

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $sdk, "User")
[Environment]::SetEnvironmentVariable("JAVA_HOME", "C:\Program Files\Android\Android Studio\jbr", "User")
$p = [Environment]::GetEnvironmentVariable("Path", "User")
[Environment]::SetEnvironmentVariable("Path", "$p;$sdk\platform-tools", "User")
```

**Close PowerShell and open a new one**, then check:

```powershell
adb version          # prints "Android Debug Bridge version ..."
java -version        # prints a version 17 or 21
& "$env:LOCALAPPDATA\Android\Sdk\cmdline-tools\latest\bin\sdkmanager.bat" --licenses   # press y for each
```

## Part 3 — Prepare each phone (once per phone)

1. **Settings → About phone →** tap **Build number** 7 times until it says you're a developer.
2. **Settings → System → Developer options →** turn on **USB debugging**.
3. Plug the phone into the laptop. On the phone, tap **Allow** on "Allow USB debugging?" (tick "Always allow").
4. In PowerShell run `adb devices`. You should see one line ending in `device`.
   If it says `unauthorized`, unlock the phone and accept the prompt.

## Part 4 — Network: use the laptop's hotspot

Venue and campus Wi-Fi usually stop devices from talking to each other, so let the laptop be the network:

1. **Windows Settings → Network & internet → Mobile hotspot →** turn it **On** (note the name and password).
2. Find the laptop's hotspot address:
   ```powershell
   ipconfig        # look for "Local Area Connection* …" with IPv4 192.168.137.1 (usually)
   ```
3. Allow phones to reach SpacetimeDB. Run **PowerShell as Administrator** once:
   ```powershell
   New-NetFirewallRule -DisplayName "SpacetimeDB 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
   ```

## Part 5 — Start the backend and dashboard on the laptop

Each in its own terminal, from the repo folder:

```powershell
& "$env:LOCALAPPDATA\SpacetimeDB\spacetime.exe" start          # 1: database (skip if already running)
npm --prefix agents run dev                                     # 2: AI agents (optional)
npm --prefix web run dev                                        # 3: dashboard -> http://localhost:5173/dashboard
```

## Part 6 — Build and install the app

With **Phone A** plugged in (use your hotspot IP from Part 4):

```powershell
cd apps\mobile
npm install
$env:EXPO_PUBLIC_STDB_URI = "ws://192.168.137.1:3000"
npx expo prebuild --clean --platform android
npx expo run:android --variant release
```

The first build takes 10–20 minutes. When it finishes, **ResQLink** opens on the phone. The release build
contains everything, so it keeps working after you unplug the phone.

Then **unplug Phone A, plug in Phone B**, and install the same app without rebuilding:

```powershell
adb install -r android\app\build\outputs\apk\release\app-release.apk
```

## Part 7 — Run the test

| | Phone A (no signal) | Phone B (has signal) |
|---|---|---|
| Network | **Airplane mode on**, then turn **Bluetooth** and **Wi-Fi** back on but don't join any network | Join the **laptop's hotspot** |
| Location | Location **on** | Location **on** |
| In the app | Enter a fake name → **Join the mesh** → allow every permission | Same |
| Should show | "No signal…" | "You have signal…" and, in Activity, "connected to …" |

Put the phones within a few metres of each other. On **Phone A**, type a short note and press **SEND SOS**.

**It worked if:**
- Phone B's Activity shows **"carrying sos from …"** and then **"uploaded 1 message(s)"**.
- The dashboard shows a new **SOS** case at the top, tagged **via mesh**, with an alert to the nearest center.
  The phone's real location is probably outside the three demo zones, so the case goes to the nearest zone.
  Switch the dashboard between Dallas, LA and Miami to find it.

## If something goes wrong

| Problem | Fix |
|---|---|
| `SDK location not found` | You skipped Part 2, or didn't open a new terminal afterwards. |
| `JAVA_HOME is set to an invalid directory` | Check that `C:\Program Files\Android\Android Studio\jbr` exists, and fix the path in Part 2. |
| `adb devices` is empty | Use a data cable, try another USB port, re-accept the prompt on the phone. |
| Build fails about licences or NDK | Rerun the `sdkmanager --licenses` line in Part 2, and check Part 1 step 3. |
| Phones never connect | Both need Bluetooth, Wi-Fi **and** Location on, plus the "Nearby devices" permission (Settings → Apps → ResQLink → Permissions). Keep both apps open on screen. |
| Phone B never uploads | Open `http://192.168.137.1:3000` in Phone B's browser. If it doesn't load, recheck the hotspot IP and the firewall rule. |
| Laptop IP changed | Redo Part 6 with the new IP. The address is built into the app. |

To change the app code later: edit it, then rerun `npx expo run:android --variant release` (Part 6).
