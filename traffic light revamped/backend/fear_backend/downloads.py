"""The phone apps, for download.

GET /get                - a page with both Android apps, install steps, and
                          (on a computer) a QR code of the page itself, so a
                          phone's camera opens it - no app needed beforehand.
GET /get/fear           - FEAR.apk          (citizens)
GET /get/fear-command   - FEAR Command.apk  (drivers / Command staff)

The files come from config.APPS_DIR ("Android apps" in the project folder;
`launcher/fear.ps1 build` refreshes them). Public on purpose, like the apps'
sign-in screens: an APK holds no secrets, and every account still needs its
own sign-in.

The file URLs have no .apk extension so Cloudflare's edge doesn't cache them
by extension (it would keep handing out an old build after an update); the
browser still saves them under the right name from Content-Disposition.
"""

from __future__ import annotations

import html
import os
from datetime import datetime
from urllib.parse import quote

import segno
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse

from . import config, netinfo

router = APIRouter()

# key -> (file in APPS_DIR, app name, who it is for)
APPS = {
    "fear": ("FEAR.apk", "FEAR", "For everyone: SOS, voice or text incident reports, directions and live traffic."),
    "fear-command": ("FEAR Command.apk", "FEAR Command",
                     "For emergency and government drivers (ambulance, fire, police, bus, municipal) and Command staff on a tablet."),
}


def _path(key: str) -> str:
    return os.path.join(config.APPS_DIR, APPS[key][0])


def _qr_target(request: Request) -> str:
    """The address a phone should open: the internet address when it's up
    (works on mobile data and any Wi-Fi), else the one this visitor used -
    unless that's this computer's own loopback, which a phone can't reach."""
    urls = netinfo.server_urls()
    public = [u for u in urls if u.startswith("https://")]
    if public:
        return public[0].rstrip("/") + "/get"
    host = request.headers.get("host", "")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    if host and not host.startswith(("127.", "localhost", "[::1]")):
        return f"{proto}://{host}/get"
    return (urls[0].rstrip("/") if urls else f"{proto}://{host}") + "/get"


_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Get the FEAR apps</title>
<style>
:root {{ --bg:#f4f6fa; --card:#fff; --ink:#14213d; --muted:#5b6478; --line:#dfe3ec; --brand:#0d2b4e; --accent:#c62828; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#0e1420; --card:#161e2e; --ink:#e8ecf4; --muted:#9aa4b8; --line:#28324a; --brand:#8fb4ff; --accent:#ff6b6b; }} }}
* {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--bg); color:var(--ink); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }}
main {{ max-width:880px; margin:0 auto; padding:24px 16px 48px; }}
h1 {{ margin:0 0 4px; font-size:28px; color:var(--brand); }}
h2 {{ margin:28px 0 8px; font-size:19px; }}
p {{ margin:6px 0; }}
.muted {{ color:var(--muted); }}
.apps {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:14px; margin-top:18px; }}
.card {{ background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px; }}
.card h3 {{ margin:0 0 4px; font-size:20px; }}
.btn {{ display:inline-block; margin-top:12px; padding:12px 18px; border-radius:10px; background:var(--accent); color:#fff;
        font-weight:700; text-decoration:none; }}
.btn:active {{ transform:translateY(1px); }}
ol {{ padding-left:22px; }} li {{ margin:6px 0; }}
.qr {{ display:flex; gap:18px; align-items:center; flex-wrap:wrap; }}
.qr .code {{ background:#fff; padding:8px; border-radius:10px; line-height:0; }}
.warn {{ background:var(--card); border-left:4px solid var(--accent); padding:10px 14px; border-radius:8px; margin-top:14px; }}
code {{ font-size:14px; word-break:break-all; }}
@media (max-width:640px) {{ .on-computer {{ display:none; }} }}
</style></head>
<body><main>
<h1>Get the FEAR apps</h1>
<p class="muted">Android phones. The apps find the FEAR server by themselves on Wi-Fi or mobile data.</p>
{iphone}
<div class="apps">{cards}</div>

<section class="on-computer">
<h2>On a computer? Open this page on the phone</h2>
<div class="qr"><div class="code">{qr}</div>
<p>Point the phone's camera at this code and tap the link,<br>or type <code>{target}</code> into the phone's browser.</p></div>
</section>

<h2>Installing</h2>
<ol>
<li>Tap <b>Download</b> on the app you need. It's a big file, so Wi-Fi is best.</li>
<li>Open the downloaded file (from the download notification, or Files &rarr; Downloads) and tap <b>Install</b>.
  <ul>
  <li>If the phone says it can't install apps from this source: tap <b>Settings</b>, turn on <b>Allow from this source</b>, go back and tap <b>Install</b>.</li>
  <li>If Play Protect warns about an unrecognised app: tap <b>More details &rarr; Install anyway</b>. FEAR isn't on the Play Store yet.</li>
  </ul></li>
<li>Open the app. Allow <b>location</b> (and the <b>microphone</b> for voice reports) when asked.</li>
<li>Sign in.
  <ul>
  <li><b>FEAR:</b> your mobile number and password. New to FEAR? Tap <b>Use a one-time code</b>.</li>
  <li><b>FEAR Command:</b> the username and password your organization gave you.</li>
  <li>Or scan a sign-in QR code from a Command admin.</li>
  </ul></li>
</ol>
<p class="muted">Updating: download again and install over the old app. You stay signed in.</p>
</main></body></html>
"""


@router.get("/get", response_class=HTMLResponse)
async def get_apps(request: Request):
    ua = request.headers.get("user-agent", "")
    cards = []
    for key, (_, name, who) in APPS.items():
        p = _path(key)
        if os.path.exists(p):
            st = os.stat(p)
            meta = f"{st.st_size / 1_048_576:.0f} MB &middot; updated {datetime.fromtimestamp(st.st_mtime):%d %b %Y}"
            button = f'<a class="btn" href="/get/{key}">Download {html.escape(name)}</a>'
        else:
            meta, button = "Not on this server yet.", ""
        cards.append(f'<div class="card"><h3>{html.escape(name)}</h3><p>{html.escape(who)}</p>'
                     f'<p class="muted">{meta}</p>{button}</div>')
    target = _qr_target(request)
    qr = segno.make(target, error="m").svg_inline(scale=5, border=1, dark="#0b1f3a", light="#ffffff")
    iphone = ('<div class="warn">This is an iPhone or iPad: the FEAR apps are Android only for now.</div>'
              if any(k in ua for k in ("iPhone", "iPad")) else "")
    return HTMLResponse(_PAGE.format(cards="".join(cards), qr=qr, target=html.escape(target), iphone=iphone),
                        headers={"Cache-Control": "no-cache"})


@router.api_route("/get/{key}", methods=["GET", "HEAD"])
async def get_apk(key: str):
    if key not in APPS or not os.path.exists(_path(key)):
        raise HTTPException(404, "That app isn't available on this server.")
    name = APPS[key][0]
    # Content-Encoding: identity keeps the GZip middleware off an already
    # compressed 70 MB file, so the phone sees its size and progress. Both
    # filename forms: plain for older Android browsers, encoded for the rest.
    return FileResponse(_path(key), media_type="application/vnd.android.package-archive", headers={
        "Cache-Control": "no-cache", "Content-Encoding": "identity",
        "Content-Disposition": f"attachment; filename=\"{name}\"; filename*=UTF-8''{quote(name)}",
    })
