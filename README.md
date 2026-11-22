# FEAR - Fast Emergency and Action Response

FEAR connects a city's emergency services, traffic lights and citizens:

- citizens report emergencies by voice or text;
- the control room dispatches ambulances, fire engines and police;
- traffic lights turn green ahead of the vehicles on their way.

**One computer runs FEAR.** Everyone else connects to it: other admins with a web browser, drivers and citizens with the Android apps.

| Part | Who uses it | Where |
|---|---|---|
| **FEAR server + GUI** (traffic simulation, map editor, FEAR Command panel) | The control room, on the server computer | Desktop icon **Start FEAR** |
| **FEAR Command** web dashboard | Admins and control-room staff on other computers | `https://app.fearsystem.me/command/` |
| **FEAR** Android app | Citizens | `https://app.fearsystem.me/get` |
| **FEAR Command** Android app | Emergency and government drivers; staff on a tablet | `https://app.fearsystem.me/get` |

**Contents**

1. [Starting and stopping FEAR](#1-starting-and-stopping-fear)
2. [Other computers: FEAR Command in a browser](#2-other-computers-fear-command-in-a-browser)
3. [Phones: installing the Android apps](#3-phones-installing-the-android-apps)
4. [Moving FEAR to another server computer](#4-moving-fear-to-another-server-computer)
5. [The internet address](#5-the-internet-address)
6. [When something goes wrong](#6-when-something-goes-wrong)
7. [For developers](#7-for-developers)

---

## 1. Starting and stopping FEAR

This is done on the **server computer**, the one that has this folder. If FEAR has never run on that computer, do [section 4](#4-moving-fear-to-another-server-computer) first.

### Start

Double-click **Start FEAR** on the desktop. You can also use **Start FEAR.bat** in this folder, or the **FEAR** folder in the Start menu.

1. A small window opens and starts FEAR in the background. This usually takes about 10 seconds. After a map change it can take a minute.
2. When FEAR is ready, the GUI opens in your browser (`http://127.0.0.1:8765/simulation.html`). The window then lists the addresses other people need:
   ```
   On this computer:              http://127.0.0.1:8765/simulation.html
   Other computers (any network): https://app.fearsystem.me/command/
   Other computers (same Wi-Fi):  http://<this computer's Wi-Fi address>:8080/command/
   Phones - get the apps:         https://app.fearsystem.me/get
   ```
3. You can close that window. FEAR keeps running.

If FEAR is already running, **Start FEAR** just opens the GUI again.

### Sign in

In the GUI, the **FEAR Command** panel is at the top of the sidebar. Sign in there with a FEAR Command account.

- **Super admin:** the account `fear-admin`.
- **Demo accounts:** listed in `apps/DEMO_CREDENTIALS.md`. Keep that file private.

### Stop

Double-click **Stop FEAR**, or press **Close server** in the GUI.

Stopping or restarting FEAR signs nobody out. While FEAR is off, phones and other computers show "Connecting to FEAR..." and reconnect on their own once it's running again.

### Keep the server computer awake

Phones and other computers reach FEAR through the server computer. While FEAR is in use, that computer must stay **on, awake and online**.

To stop it sleeping, open **Settings → System → Power**. Under **Screen, sleep & hibernate timeouts**, set sleep to **Never** for "When plugged in".

### The start and stop files

| File | What it does |
|---|---|
| `Start FEAR.bat` | Starts FEAR in the background and opens the GUI when it's ready. |
| `Stop FEAR.bat` | Stops FEAR, including the internet link and the traffic engine. |
| `Set up FEAR (first time).bat` | Installs what FEAR needs on a new computer and makes the desktop icons. |
| `Android apps/` | The two phone apps (`.apk`) and **Install on phone (USB).bat**. |
| `For other computers/` | Browser shortcuts to copy onto other computers. |
| `launcher/` | The script behind all of these (`fear.ps1`), the icons, **Make shortcuts.bat** and **Build phone apps.bat**. |
| `logs/server.log` | What FEAR printed since its last start. The backend's own log is `traffic light revamped/backend/fear_backend/fear_backend.log`. |

---

## 2. Other computers: FEAR Command in a browser

Other admins **don't install anything and don't start a server**. The server computer already serves the Command dashboard to any browser. Everyone shares one live system: the same map, incidents, units and traffic lights. A change made on one computer shows up on all the others within a second.

> **Never run Start FEAR on a second computer.** That makes a separate FEAR with its own empty accounts, incidents and map. Your phones and admins wouldn't see it.

### Open it

1. On the other computer, open **Chrome** or **Edge** and go to:
   - **Any network:** **`https://app.fearsystem.me/command/`**
   - **Same Wi-Fi as the server computer:** `http://<server's Wi-Fi address>:8080/command/`. The Wi-Fi address is shown in the **Start FEAR** window and in the GUI under **FEAR Command → Network**.
2. Sign in with **your own** FEAR Command account. Each person should have their own account, because every action is recorded under the name that made it.

### Make it an app icon on that computer

Pick one:

- **Edge:** **⋯ → Apps → Install this site as an app**
- **Chrome:** **⋮ → Cast, save and share → Install page as app**
- Copy **`For other computers/FEAR Command.url`** from this folder onto that computer's desktop.

### Accounts for other admins

Make accounts in FEAR Command under **Registry → Accounts**:

- **Super admin (`fear-admin`):** can make **Command seats** (control-room desks such as ICCC, Health 108, Fire 101 and Police 112) and **Organization admins**.
- **Organization admin:** can make admins for the organizations below their own.

The new password is shown **once**; give it to the person. The 🔑 button on an account makes a new password.

### What other computers can and can't do

- **The same things as the server computer:** the dashboard has the live map, incidents, dispatch, units, signals, alerts, registry, verification, analytics and the audit log. Each account sees what its role allows.
- **Only on the server computer:** the traffic simulation GUI and the map editor (`127.0.0.1:8765`).
- **The server computer must be on, with FEAR running.**
- **Same-Wi-Fi addresses can be blocked:** some office and campus Wi-Fi blocks computers from reaching each other. Use the `https://app.fearsystem.me` address there.

---

## 3. Phones: installing the Android apps

| App | For | File |
|---|---|---|
| **FEAR** | Everyone: SOS, voice or text incident reports, directions, live traffic | `Android apps/FEAR.apk` |
| **FEAR Command** | Emergency and government drivers; Command staff on a tablet | `Android apps/FEAR Command.apk` |

The apps are for Android only and aren't on the Play Store yet, so they install from a file. Pick whichever option suits you.

### Option A - The download page (easiest)

1. On the phone, open **`https://app.fearsystem.me/get`** in the browser.
   - **From a computer instead:** open the same page there. It shows a QR code: point the phone's camera at it and tap the link. The GUI links to this page under **FEAR Command → Network → Phone apps**.
2. Tap **Download FEAR** or **Download FEAR Command**. Each file is about 70 MB, so Wi-Fi is best.
3. Open the downloaded file (from the notification, or **Files → Downloads**) and tap **Install**.
   - **"For your security, your phone is not allowed to install unknown apps from this source":** tap **Settings**, turn on **Allow from this source**, go back and tap **Install**.
   - **Play Protect "Unsafe app blocked" or "unrecognised app" warning:** tap **More details → Install anyway**.

### Option B - Send the file

Send `FEAR.apk` or `FEAR Command.apk` from the `Android apps` folder to the phone in any of these ways:

- a USB cable in "File transfer" mode;
- WhatsApp or Telegram, sent as a *document*;
- Google Drive or email.

Then tap the file on the phone and install it as in Option A, step 3.

### Option C - USB cable, straight from the server computer

Double-click **`Android apps/Install on phone (USB).bat`** and follow the steps it shows. It's also in the Start menu under **FEAR**.

- **The computer needs** the Android SDK's `adb` tool (installed with Android Studio).
- **The phone needs USB debugging on.** To turn it on: **Settings → About phone** → tap **Build number** 7 times. Then **Settings → System → Developer options → USB debugging**.

### After installing

1. **Open the app.** It finds the FEAR server by itself, on Wi-Fi or mobile data. The server address is built into the app.
2. **Allow location when asked.** "While using the app" is enough. On duty, the FEAR Command app keeps sending the driver's position with the screen off and shows a notification while it does. Also allow the microphone, which voice reports need, and notifications.
3. **Sign in:**
   - **FEAR (citizens):** mobile number and password.
     - **New users:** tap **Use a one-time code** to sign up.
     - **The code isn't sent by SMS yet.** It appears in FEAR Command under **Dev OTP outbox** (signed in as `fear-admin`), so an admin has to pass it on.
     - **Afterwards:** people can set a password under **Me**.
   - **FEAR Command (drivers):** the username and password their organization gave them. To make a driver:
     - **Registry → Drivers** in FEAR Command (organization admins);
     - or, in the GUI, **FEAR Command → Phones → Government**. This makes the vehicle, the driver and the sign-in in one step.
   - **Or with a QR code:** an admin makes a sign-in QR in the GUI under **FEAR Command → Phones**, and the person taps **Scan QR code** in the app. QR codes are optional; typing the username and password works everywhere.

**Updating an app:** download it again and install over the old one. Nobody is signed out.

---

## 4. Moving FEAR to another server computer

Do this only when FEAR moves to a new server computer, or runs on a computer for the first time. **FEAR runs on one computer at a time.**

1. **Stop FEAR on the old computer.** Copy this whole folder to the new computer. Everything is in it:
   - the database: accounts, incidents and vehicles, in `traffic light revamped/backend/fear_backend/fear.db`;
   - the map, the apps and the traffic engine.
2. On the new computer, double-click **`Set up FEAR (first time).bat`**. It:
   - installs Python 3.13 if the computer has no Python 3.10 or newer (it asks first);
   - creates FEAR's Python environment (`.venv`) and installs the packages in `requirements.txt`;
   - checks that the traffic engine, route planner and internet-link tool are there;
   - makes the **Start FEAR** and **Stop FEAR** desktop icons and a **FEAR** Start menu folder.
3. Start FEAR. When Windows asks whether Python may use networks, click **Allow**. Without that, computers and phones on the same Wi-Fi can't connect, although the internet address still works.
4. Move the internet address, as described in [section 5](#5-the-internet-address).

The voice features (speech to text and the AI responder) use a Sarvam AI key. It's stored in `traffic light revamped/backend/fear_backend/local_secrets.json`, which travels with the folder. Keep that file private.

---

## 5. The internet address

`https://app.fearsystem.me` is FEAR's permanent address. It reaches the server computer from any network, using a Cloudflare Tunnel on the `fearsystem.me` domain.

**It stays the same:**
- after restarts;
- when the server computer changes Wi-Fi;
- when its own IP address changes.

That's why the apps have it built in and QR codes are optional.

- It's up whenever FEAR is running. Start FEAR connects it, and Stop FEAR disconnects it.
- It's tied to the tunnel's key, which is stored on the server computer in `C:\Users\<you>\.cloudflared\`. Treat that folder like a password.
- **To move it to a new server computer:**
  1. Copy the `.cloudflared` folder from the old computer's user folder to the new one's.
  2. Run this once in PowerShell on the new computer:
     ```powershell
     cd "<FEAR folder>\traffic light revamped\backend"
     ..\..\.venv\Scripts\python.exe setup_permanent_link.py app.fearsystem.me
     ```
  3. Restart FEAR. The address then points at the new computer.
  4. Don't run FEAR on the old computer anymore. Two computers on one address would split the users between two different FEARs.
- **To set it up from scratch** (for example for another domain): the domain must be on a Cloudflare account. Run the same command with the new address; it opens a browser once to sign in to Cloudflare. To use a different address in the apps, rebuild them with `--dart-define=FEAR_SERVER=https://<address>`.
- **Without an internet address:** if the key is missing, the server falls back to a temporary `trycloudflare.com` link. **FEAR Command → Network → Go public** in the GUI does the same. Phones then need a fresh QR code to find it, and devices on the same Wi-Fi can still use the Wi-Fi address.

---

## 6. When something goes wrong

| What you see | What to do |
|---|---|
| **Start FEAR** says FEAR isn't set up | Double-click **Set up FEAR (first time)**, then start FEAR again. |
| **Start FEAR** says FEAR didn't start | It shows the last lines of `logs/server.log`. "Address already in use" means another program has port 8765 or 8080: restart the computer and try again. |
| Phones or other computers say "Connecting to FEAR..." | FEAR is off, or the server computer is asleep or offline. Start FEAR; they reconnect by themselves. |
| `https://app.fearsystem.me` doesn't open | Check that FEAR is running and the server computer is online. On the server computer, the GUI at `http://127.0.0.1:8765/simulation.html` always works. |
| Another computer on the same Wi-Fi can't open `http://<address>:8080/command/` | The Wi-Fi blocks devices from reaching each other, or Windows Firewall on the server computer is blocking Python. Use `https://app.fearsystem.me/command/` instead. |
| The phone says "App not installed" | An older copy of the app was built on a different computer. Uninstall it, then install again. Also check the phone has about 200 MB free. |
| A new user didn't get their one-time code | Codes aren't sent by SMS yet. An admin finds the code in FEAR Command under **Dev OTP outbox** (signed in as `fear-admin`). |
| Someone forgot their password | **Staff and drivers:** an admin presses 🔑 on their account under **Registry**. **Citizens:** sign in with a one-time code, then set a new password under **Me**. |
| A driver's position doesn't show on the map | The app needs location permission and its notifications must be allowed. The driver must be **on duty** and within 75 m of a mapped road. |

---

## 7. For developers

```
FEAR System/
├─ Start FEAR.bat / Stop FEAR.bat / Set up FEAR (first time).bat
├─ launcher/                fear.ps1 (start, stop, setup, shortcuts, phone, build) + icons
├─ Android apps/            the release APKs, served at /get
├─ For other computers/     browser shortcuts
├─ requirements.txt         the server's Python packages
├─ tools/cloudflared/       the internet link (Cloudflare Tunnel client)
├─ apps/                    Flutter: fear_public (FEAR), fear_gov (FEAR Command app + web dashboard), fear_core (shared)
└─ traffic light revamped/
   ├─ serve.py              GUI server (port 8765, this computer only); starts the backend and the traffic engine
   ├─ front-end/            GUI: simulation.html (viewer + FEAR Command panel), index.html (map editor)
   ├─ maps/                 map sources and the routing index
   └─ backend/
      ├─ fear_backend/      FastAPI backend (port 8080): accounts, incidents, dispatch, AI triage, live socket, /get
      ├─ sim/               C++ traffic engine (sim_engine.exe, WebSocket on 8766)
      └─ ch/                C++ route planner (contraction hierarchies)
```

- **Run it by hand** (shows the console output):
  ```powershell
  cd "traffic light revamped"
  ..\.venv\Scripts\python.exe serve.py
  ```
  - `serve.py` opens the map editor.
  - Set `FEAR_OPEN_BROWSER=0` to stop it opening a browser.
  - Fresh demo data, with FEAR stopped: `..\.venv\Scripts\python.exe -m backend.fear_backend.seed_demo --reset`. This writes new logins to `apps/DEMO_CREDENTIALS.md`.
- **Rebuild the apps:**
  - **`launcher/Build phone apps.bat`** builds both APKs and the web dashboard, then copies the APKs into `Android apps/`. It needs Flutter on `PATH` or in `C:\flutter\flutter`.
  - The commands it runs:
    - `flutter build apk --release` in `apps/fear_public` and in `apps/fear_gov`;
    - `flutter build web --release --base-href /command/` in `apps/fear_gov`.
- **Signing:** release APKs are signed with this computer's debug key (`%USERPROFILE%\.android\debug.keystore`). An APK built on another computer won't install over one built here, so keep that file if the build moves. A real release key is needed before publishing to the Play Store.
- **The C++ engine** is rebuilt automatically when its source is newer than the `.exe`. That needs `g++` from MSYS2 UCRT64 on `PATH`. The `.exe` files in the folder are prebuilt and static, so a normal server computer doesn't need `g++`.
- **More documentation:**
  - `apps/README.md` covers features, roles and permissions, the AI dispatch agent, the voice responder, signals and phones in detail;
  - `traffic light revamped/IMPLEMENTATION_STATUS.md`;
  - `CLAUDE.md` and `graphify-out/` hold the code knowledge graph.
