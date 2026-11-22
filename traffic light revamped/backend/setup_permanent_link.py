"""Sets up FEAR's permanent public address - a named Cloudflare Tunnel - so
phones and other desktops reach this server at the same https address even
after restarts (the quick tunnel's trycloudflare.com address changes every
time).

Before running: the domain must be in your Cloudflare account (added as a
site, nameservers at the registrar pointed to Cloudflare).

    python setup_permanent_link.py app.fearsystem.me

What it does, each step only if not already done:
  1. `cloudflared tunnel login` - opens the browser once: sign in to
     Cloudflare and click Authorize on the domain (saves ~/.cloudflared/cert.pem)
  2. creates a tunnel named "fear-system" (credentials in ~/.cloudflared/)
  3. points the hostname at it (a DNS CNAME in your Cloudflare zone)
  4. writes ~/.cloudflared/fear-system.yml (hostname -> this server's port)
     and records it in fear_backend/public_link.json - the backend then
     runs this tunnel instead of a quick one, and every QR code carries the
     permanent address.
Nothing secret is printed.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from fear_backend import config, netinfo  # noqa: E402

TUNNEL_NAME = "fear-system"
HOME = os.path.join(os.path.expanduser("~"), ".cloudflared")
CERT = os.path.join(HOME, "cert.pem")


def run(*args, check=True) -> str:
    r = subprocess.run([netinfo.CLOUDFLARED, *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    out = (r.stdout or "") + (r.stderr or "")
    if check and r.returncode != 0:
        raise SystemExit(f"cloudflared {' '.join(args[:3])} failed:\n{out.strip()[-800:]}")
    return out


def main() -> None:
    if len(sys.argv) != 2 or "." not in sys.argv[1]:
        raise SystemExit("usage: python setup_permanent_link.py <hostname, e.g. app.fearsystem.me>")
    hostname = sys.argv[1].strip().lower()
    if not os.path.exists(netinfo.CLOUDFLARED):
        raise SystemExit(f"cloudflared not found at {netinfo.CLOUDFLARED}")

    # 1. authorize this machine for the domain (browser, once)
    if not os.path.exists(CERT):
        print("1/4 A browser window opens: sign in to Cloudflare and click Authorize on your domain...")
        subprocess.run([netinfo.CLOUDFLARED, "tunnel", "login"], check=True)
        if not os.path.exists(CERT):
            raise SystemExit("Cloudflare didn't authorize this machine - run the script again.")
    print("1/4 authorized (cert.pem present)")

    # 2. the tunnel itself
    listing = json.loads(run("tunnel", "list", "--output", "json") or "null") or []  # "null" when there are none yet
    tunnel = next((t for t in listing if t.get("name") == TUNNEL_NAME), None)  # `list` shows live tunnels only
    if tunnel is None:
        out = run("tunnel", "create", TUNNEL_NAME)
        m = re.search(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", out)
        if not m:
            raise SystemExit("couldn't read the new tunnel's id")
        tid = m.group(1)
        print(f"2/4 tunnel {TUNNEL_NAME} created")
    else:
        tid = tunnel["id"]
        print(f"2/4 tunnel {TUNNEL_NAME} already exists")
    creds = os.path.join(HOME, f"{tid}.json")
    if not os.path.exists(creds):
        raise SystemExit(f"the tunnel's credentials file is missing ({creds}) - delete the tunnel in Cloudflare and run again")

    # 3. DNS: hostname -> tunnel
    out = run("tunnel", "route", "dns", "--overwrite-dns", TUNNEL_NAME, hostname, check=False)
    if "already" in out.lower() or "added cname" in out.lower() or "route" in out.lower():
        print(f"3/4 {hostname} points at the tunnel")
    else:
        raise SystemExit(f"couldn't create the DNS record for {hostname}:\n{out.strip()[-600:]}")

    # 4. config for the backend
    cfg = os.path.join(HOME, f"{TUNNEL_NAME}.yml")
    with open(cfg, "w", encoding="utf-8") as f:
        f.write(f"tunnel: {tid}\ncredentials-file: {creds}\n"
                f"ingress:\n  - hostname: {hostname}\n    service: http://127.0.0.1:{config.API_PORT}\n"
                f"  - service: http_status:404\n")
    netinfo.set_named_tunnel(hostname, cfg)
    print(f"4/4 done - restart the FEAR servers; the permanent address is https://{hostname}")


if __name__ == "__main__":
    main()
