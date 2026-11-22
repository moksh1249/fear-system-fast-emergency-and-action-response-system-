# FEAR apps

| Part | Who | Where |
|---|---|---|
| **FEAR Command** in the red-lights GUI | Control room (ICCC / department seats), FEAR admin, organization admins | `http://127.0.0.1:8765/simulation.html` on the laptop running FEAR - the **FEAR Command** panel at the top of the sidebar |
| **FEAR Command** app (`fear_gov`) | Emergency / government drivers (and admins on a tablet) | Android |
| **FEAR** app (`fear_public`) | Citizens | Android |

`fear_core` is shared by both Flutter apps: server discovery + QR sign-in, the API and live socket, location (GPS or a labelled demo position), the city map drawn natively in the red-lights viewer's style with live traffic lights, and turn-by-turn navigation. The older Flutter web dashboard is still served at `http://<laptop>:8080/command/`.

## Running it

Everyday use: the **Start FEAR** / **Stop FEAR** desktop icons. The project's top-level `README.md` is the step-by-step guide: starting FEAR, other computers, installing the phone apps (also at `/get`), and moving to a new server computer.

By hand, from `traffic light revamped`:

```
../.venv/Scripts/python.exe serve.py
```

That serves the GUI (port 8765), starts `fear_backend` (port 8080) and starts/compiles the traffic engine on demand (`g++` from MSYS2 UCRT64 on `PATH`).

Fresh demo data (stop the servers first): `../.venv/Scripts/python.exe -m backend.fear_backend.seed_demo --reset` - logins go to `apps/DEMO_CREDENTIALS.md`.

## One GUI, two modes

The **Simulation | Realistic** switch at the top of the GUI's sidebar (same as the engine's "Vehicle source"):

- **Simulation** - synthetic traffic from `vehicles.json`; the GUI's own Emergency Control dispatches simulated vehicles. Phone GPS is paused (phones are taken out of the engine).
- **Realistic** - only real phones move: on-duty FEAR Command drivers, plus FEAR app users who share anonymous traffic. Incidents come from SOS / reports / the panel; dispatch goes to real phones.

The traffic lights are simulated in both. In realistic mode an authorized emergency vehicle on an accepted task gets signal priority: the engine routes it and holds each signal on its route green ~10 s before it arrives.

## Traffic lights: one approach green at a time

Every signalised junction serves exactly one approach at a time - never two greens together:

- **Fixed-time / Emergency-priority modes** - each phase lists one approach, rotating clockwise, with a 2 s all-red between phases. Junctions made of two signal nodes take turns as a group. `backend/signal_rules.py` enforces this on every save from the editor, on every OSM import, and was run once over the existing map (backup in `maps/`).
- **Auto (density) mode** - the busiest approach (queue weight) gets the green, for at least 6 s while it has traffic and at most 30 s while others wait; the next approach starts only after the junction has cleared.
- **Emergency preemption** - only the emergency vehicle's approach is green; every other approach is red (whatever was green finishes on yellow first).

## Adding an area to the map (super admin)

GUI -> FEAR Command -> **Map** tab (signed in as `fear-admin`): upload an OpenStreetMap `.osm` export (openstreetmap.org -> Export). It runs the same processing as `osm_to_json.py` (roads split at junctions, junction groups, lane policy, buildings, amenities), turns OSM `traffic_signals` into working signals, merges it into `map_data.json` (backup kept), rebuilds the routing index and restarts the engine on the new map. The apps reload the map by themselves. Command line: `../.venv/Scripts/python.exe -m backend.map_import <file.osm>` (then Recalculate CH / restart the engine).

## Real GPS

Both apps use the phone's GPS by default (demo location is only a fallback you pick). Allow location when asked - if it was refused, the app shows **Allow location** / **Open settings**. Positions reach the engine in realistic mode only, and only for phones on or within 75 m of a mapped road; a phone outside the mapped area is told so (add the area from the Map tab).

- **FEAR app** - shares its position anonymously while open (on by default, explained at first launch, off-switch under Me), every 1.5 s - this is what the Auto signals count.
- **FEAR Command driver app** - broadcasts every second while on duty, responding or not (also with the screen off, under a notification); with an accepted task it also gets signal priority.

## Connecting phones

- **Same Wi-Fi** - phones reach `http://<laptop Wi-Fi IP>:8080` (shown in the GUI under **Network**). Windows Firewall must allow Python on that network (it does on this machine).
- **Any network** - **Network -> Go public** opens a temporary Cloudflare link (`https://<random>.trycloudflare.com`) using `tools/cloudflared/cloudflared.exe`. Anyone with the link reaches the sign-in screens; turn it off when done. It also stops when the backend stops.
- **QR codes** - **Phones -> Add a phone** in the GUI issues a single-use QR (30 min) that carries every server address (Wi-Fi first, then the public link) and a one-time sign-in. It has two modes:
  - **Government** - *new emergency / government vehicle + driver*: name, mobile number, address, vehicle plate and vehicle type (ambulance, fire engine, police, bus, municipal...) and the organization; creates the vehicle (FEAR ID), the driver and the assignment, and the FEAR Command app signs straight in. Or *phone for an existing vehicle's driver*.
  - **Public** - *new public user with their vehicle*: name, mobile number, address, vehicle plate and vehicle type (car, bike, scooter, auto-rickshaw, bus, truck, other); signs the FEAR app in with traffic sharing on and the vehicle queued for RTO verification. Or *connect only* - the QR just sets the server; the person signs in with their own number.
- Over USB for development: `adb reverse tcp:8080 tcp:8080`, then the apps find `127.0.0.1:8080`.

## Navigation (FEAR app)

- **Directions from any place to any place** - the directions button opens From / To. Each end can be *Your location*, a search result, or *Choose on map* (tap the point; it is named after the road it is on). Swap flips them; long-pressing the map offers *Directions from here* / *to here*.
- **Autocomplete** - before you type, the search lists the roads and places right around you (or around where the map is looking); as you type, matches come nearest-first, name matches ahead of mid-word ones, and a road answers with its stretch nearest you. Typing a kind ("hosp", "fuel") lists every place of that kind by distance.
- Route preview: time, distance, reported problems, and a **Steps** list. **Start** (from your location): heading-up map following you smoothly, turn instructions, spoken prompts, re-routing when you leave the route, arrival. Drivers get the same guidance on their task route.
- An emergency vehicle's route (Command's dispatch corridor, a driver's priority route, one approaching you) is dark blue with a light-blue glow and a bright dashed centre.

## The map on phones

The phones draw the same map as the GUI, loaded in two levels so a phone only downloads what it shows: the base (`/v2/map`, major roads and their junctions, areas, traffic lights - about 60 KB) once, and 1 km detail tiles (`/v2/map/tile`: minor roads, buildings, amenities) only when zoomed in to street level, only for the part on screen. Zoomed out, smaller roads are hidden (secondary from zoom 11.5, tertiary from 12.5, streets from 14, footpaths from 16). Junctions are drawn as filled open areas, so trimmed road ends meet instead of leaving holes. The GUI viewer has the same road-level zoom (Settings -> View, on by default).

## Me (both apps)

- **FEAR app -> Me**: your name, number, address, vehicles. Edit name and address; set or change a password (then sign in with number + password instead of a code); change your mobile number (confirmed by a code sent to the new number); transfer a vehicle to another FEAR user; request account deletion.
- **FEAR Command driver app -> menu -> Me**: your details and vehicle; change password, mobile number and address; request account deletion.
- Requests are reviewed in the GUI under **Requests**: citizens' deletions by FEAR's admin (`fear-admin`), vehicle transfers by the RTO desk, drivers' requests by their organization's admin. Approving a deletion removes the person's details and signs them out; approving a transfer moves the vehicle to the new owner (who must already use FEAR).

## Voice reports and triage

- **FEAR app** (one-shot dictation, separate from the responder conversation): *Report a problem -> Speak instead*, the mic next to the SOS note, and *Tell responders more* on an open SOS. Up to 28 s, any Indian language. Sarvam AI (`saaras:v4`) transcribes it, with an English translation, and the person checks and edits the text before sending. No audio is stored.
- **Triage** (`fear_backend/triage.py`): every SOS, report and Command-created incident gets a severity from 1 Minor to 5 Critical, key terms, people affected, vehicles involved and likely needs. The key-term rules set a floor that nothing can go below. Sarvam AI (`sarvam-105b`) adds a summary and can raise the rating, but by more than one level only when its key terms really appear in the text. Ambulances scale with the number of people hurt. A service the rules didn't ask for is added only where it fits the incident type.
- Command sees the severity, key terms, the transcript (and the words as spoken), and the triage summary on every incident.
- The Sarvam key lives in `traffic light revamped/backend/fear_backend/local_secrets.json` (or the `SARVAM_API_KEY` environment variable). Without a key, voice is off and triage uses the key-term rules alone.

## AI dispatch agent (`fear_backend/ai_dispatch.py`)

If an emergency (medical, fire, crime, accident) waits **2 minutes with no response from Command and no unit dispatched**, the agent dispatches the nearest suitable units by road time. Sarvam AI decides how many of each service to send, within limits.

**What counts as a response.** Any of these from Command stops the agent for that incident: Acknowledge, verify or reject, a note, a dispatch, a recall, or closing it. The agent re-checks right before it acts. It never touches an incident Command created.

**Guard rails.**
- Hazards, blocked roads, congestion and "other" are never auto-dispatched.
- An unverified public report needs severity 3 (Serious) or worse, and must be an accident or a fire.
- Only ambulances, fire engines and police are sent, with caps per service and per severity.
- At most 10 AI-sent units city-wide per 10 minutes, and 2 rounds per incident.
- Units must be no more than 20 minutes away; incidents older than 30 minutes are left alone.
- An incident within 150 m of another one that already has units is flagged as a possible duplicate instead of dispatched.
- A Minor or Moderate incident never takes a service's last free unit.
- If Sarvam is down, the plan falls back to triage.

**Visibility and control.**
- Every decision, with its reason, goes on the incident timeline and in the audit log.
- Every unit it sends is an ordinary assignment that Command can recall.
- A countdown on each waiting incident shows when it will act.
- **Auto / Advise / Off**: the ICCC seat or `fear-admin` switches it in the GUI (Incidents tab) or the web dashboard. In Advise mode it recommends units without dispatching them.

## Traffic in realistic mode

Command (ICCC, city traffic, police command, analytics, `fear-admin`) sees every vehicle the engine is moving. In realistic mode that means every phone sending GPS: drivers, plus FEAR app users with anonymous traffic sharing on. In simulation mode it is the simulated vehicles.

- The vehicles appear without identities.
- The web dashboard draws them as dots coloured by speed, with the count, average speed and share of slow vehicles. The GUI shows the same numbers in its live line and the vehicles on the map.

## Map gestures

All maps support drag, pinch-zoom, two-finger rotate, double-tap and double-tap-drag zoom, and mouse-wheel or trackpad zoom. On desktop they also support ctrl+drag rotate and the keyboard: arrows pan, R/F zoom, Q/E rotate.

- A compass appears whenever the map is turned; tap it to face north.
- The web dashboard also has + / - zoom buttons and can zoom out further.

## More admins on other desktops

The Command dashboard is a web app served by this PC, so other admins only need a browser:

- **Same Wi-Fi:** open `http://<this PC's Wi-Fi address>:8080/command/`. The address is shown in the GUI under Network and at `http://127.0.0.1:8080/v2/servers`; today it is 10.12.46.54. Each admin signs in with their own account. Everyone sees the same live map, incidents, units and signals, because they all talk to this one server.
- **Any other network:** open `https://app.fearsystem.me/command/`.
- **Things to know:**
  - This PC must be on, with the servers running.
  - Windows Firewall already allows Python on this network.
  - Some campus or office Wi-Fi blocks device-to-device traffic. Use the public link there.
- The red-lights GUI (`simulation.html`, port 8765) is meant for this PC only. Use the web dashboard everywhere else.

## Staying signed in

- **Sign-ins don't expire.** The FEAR app, the FEAR Command app and the GUI's Command panel stay signed in until someone signs out, or until the account is disabled, removed or has its password reset.
- **The server address can change.** Each phone remembers every address it has reached the server on: Wi-Fi IPs, the public link, and the addresses the server reports at `/v2/servers`. If the server stops answering, the app keeps the sign-in, shows "Still signed in - reconnecting", and finds the server again on its own.
- **Phones signed in before this change** were on the old 12-hour limit and need to sign in once more.

## Signing in without a QR code

Both apps have the permanent address `https://app.fearsystem.me` built in. Change it at build time with `--dart-define=FEAR_SERVER=https://...`.

- **Finding the server:** a freshly installed app, or one whose server restarted, finds the server by itself on Wi-Fi or mobile data. It tries the last address it used, then every address it has learned, then the USB link, then `app.fearsystem.me`, then a Wi-Fi search.
- **FEAR Command app:** sign in with username and password.
- **FEAR app:** sign in with mobile number and password; the screen opens on that. New users without a password sign up with a one-time code (in development the code appears in the server console and in Dev OTP outbox).
- **Accounts created in Command (GUI Phones -> Public):** the person gets a password, shown once next to their QR as "Typed login instead". It is issued only if the account doesn't have a password already.
- **Drivers created in Phones -> Government:** they get a username and password the same way.
- **People can change their password in Me.**
- **Server restarts:** they don't sign anyone out, because sign-ins are stored on the server and last until sign-out.
- **QR codes:** now just a shortcut.

## Sign-in QR codes for existing accounts (no new account)

- **FEAR Command app:** the QR button in the top bar.
  - **Sign in on my phone:** any signed-in user. It shows a QR that signs your phone in as you.
  - **Sign in an existing account on a phone:** an employee or driver by username, or a FEAR app user by mobile number.
  - The Registry rows also have a QR button for each admin and driver.
- **GUI:** Phones -> **Existing**.
- **Who can issue which QR:**
  - FEAR's admin: any employee.
  - ICCC: drivers, and FEAR app users.
  - An org admin: drivers and admins of their own organization and those below it.
- **Every QR works on the same Wi-Fi and from anywhere on the internet.** Making a QR switches on the public link (a Cloudflare quick tunnel) if it isn't on, and waits until it answers. The QR then carries both addresses: the Wi-Fi one (VPN adapters such as Cloudflare WARP are left out) and the `https://...trycloudflare.com` link.
- **Scanning:** the phone tries both at once and uses whichever answers, so it works on mobile data with no USB cable. If neither answers, it also tries the server it already reaches.
- **The permanent public address is `https://app.fearsystem.me`.** It is a named Cloudflare Tunnel called `fear-system` on the `fearsystem.me` domain. It stays the same across restarts, so a phone that joined over the internet keeps working. The backend starts it with the servers, and every QR carries it.
  - Its settings live in `~/.cloudflared/` (credentials, `fear-system.yml`) and `fear_backend/public_link.json`.
  - To set it up again on another machine, or with another name: `python setup_permanent_link.py <host>` in `traffic light revamped/backend`. It opens the browser once, for the Cloudflare sign-in and Authorize.
- **Other desktops:** use `https://app.fearsystem.me/command/` from anywhere.
- **Fallback:** if the permanent tunnel can't connect, the server falls back to a temporary `trycloudflare.com` link. That link changes on every restart.
- **Turning it off:** Network -> Go public (off) turns the public address off until the next QR is made. Codes are single-use and valid for 30 minutes.

## Removing staff and vehicles (by hierarchy)

Use **Registry -> Remove** (the red icon) in the FEAR Command app. Organizations form a tree.

- **FEAR's admin** can remove anyone except another super admin, and any vehicle.
- **An org admin** can remove:
  - drivers and vehicles in their own organization and every organization below it;
  - the admins of organizations below theirs.

  They can never remove a peer in their own organization, anyone above them, or themselves.
- **Command seats** can't remove anyone.

Removing deactivates the account or vehicle and erases personal data:

- the sign-in stops on every device;
- it disappears from lists and the map;
- name, phone, address and licence are wiped.

Past incidents keep the vehicle ID. A vehicle out on an incident must be recalled first. The code is in `fear_backend/staff.py`.

## Red-light durations

At street zoom (16 and closer), the Command map shows a number beside each approach's lamp:

- `12`: seconds until the light changes (fixed-time plans).
- `≤12`: Auto/density mode, at most this much green is left. The engine ends a green after 30 s, or sooner when its queue clears.
- `+12`: seconds this red has been waiting under density control.
- `⚡12`: seconds held for an emergency vehicle.

## Vehicles on the Command map

- **Traffic:** every moving vehicle is drawn as its own shape at its real size and heading, so it shrinks with the city when you zoom out.
  - Colour shows the type: car blue, bus teal, truck brown, two-wheeler purple, emergency red.
  - The edge shows speed: red crawling, amber slow, green flowing.
- **FEAR units:** these keep round badges, which also shrink as you zoom out.
- **Map key:** it can be collapsed, and starts collapsed on small screens.

## AI responder (voice SOS and reports)

Tapping SOS or Report first asks: **Talk to the FEAR responder** or **Fill in a form**.

**How a voice conversation goes:**
- The responder speaks short questions in the reporter's language (Sarvam `bulbul:v3`; Hindi questions are hand-written, other languages are translated).
- The phone listens and stops by itself when the person pauses.
- Each answer is transcribed in any Indian language and also translated to English (`saaras:v4`).
- It asks at most 6 questions, in order: what happened; unconscious, not breathing or heavy bleeding; how many hurt; trapped, fire or fuel; vehicles; nearest landmark; is the caller safe. It skips anything it already knows.

**When the incident is raised:**
- **SOS:** raised from the first answer (or a tap on Medical, Accident, Fire or Police). Help never waits for the interview, and every later answer updates the incident.
- **Report:** sent when the person confirms the summary.

**How the facts are worked out (`responder.py`):**
- The key-term script in `triage.py` finds counts, injuries, hazards and vehicles in the words actually spoken.
- Sarvam's model fills in a fact only for a question the caller has actually answered.

**What Command sees:**
- the interview, with each question and answer and the words as spoken;
- the extracted facts, severity and likely needs;
- a **Dispatch recommended** button, which sends the nearest free units of the services that seat may dispatch.

If nobody responds and nothing is dispatched within 2 minutes, the AI dispatch agent acts (see above).

## What is a development stand-in

| Real system | Here |
|---|---|
| SMS gateway for OTP | Printed in the backend console and listed in **Dev OTP outbox** (`fear-admin`). |
| RTO / VAHAN vehicle checks | Manual review queue for an RTO desk. |
| Physical traffic signal controllers | The traffic engine's simulated signals. |
| Permanent public hosting / TLS | This laptop behind a named Cloudflare Tunnel (`https://app.fearsystem.me`) - real HTTPS, but up only while the laptop runs FEAR. Plain HTTP on the LAN. |

## Who can see what (enforced in `fear_backend/access.py`)

- Command works with **vehicle identities**; a driver's identity stays with the employing organization (break-glass access needs a reason and is audited).
- A caller's phone number is visible only to the authority handling that incident, only while it is open, and every opening is audited.
- Citizens' positions are never stored; anonymous traffic pings use a tag that changes every 10 minutes.
- Commercial fleets are only counted in aggregate.
- Departments dispatch their own units; the **ICCC** seat coordinates all three emergency services.
