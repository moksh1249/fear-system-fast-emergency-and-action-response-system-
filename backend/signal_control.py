"""
Take control of a traffic light intersection over the network - from any
Python script. (See signal_control_example.cpp for the same thing in C++;
the underlying HTTP API works from any language.)

The running serve.py (python serve.py, at the project root) exposes a tiny
JSON API on http://127.0.0.1:8765 for this:

    POST /api/signal/override   {nodeId, wayId, controller, token?, force?}
        -> {ok, token}            Forces `wayId`'s approach green and every
                                   OTHER approach at `nodeId` red, and
                                   freezes that intersection's own
                                   fixed-time phase clock (or its whole
                                   turn-taking group's clock, if it's
                                   grouped) so the cycle picks back up
                                   exactly where it left off once released.
                                   Pass wayId=None to force every approach
                                   red instead (a full stop). Returns 409 if
                                   someone else already holds it - pass
                                   force=True to steal it anyway.
    POST /api/signal/release     {nodeId, token, force?}
        -> {ok}                    Hands control back. Only the token that
                                    took control can release it, unless
                                    force=True.
    GET  /api/signal/overrides
        -> {ok, overrides}          Everything currently under external
                                     control (nodeId -> {wayId, controller,
                                     since}) - this is what the browser
                                     polls to mirror the override and draw
                                     it in the simulation viewer.

nodeId/wayId are whatever ids the intersection/road already have in
map_data.json - click the intersection in the editor or simulation viewer
and its id is shown in the inspector panel's title.

Usage:
    from signal_control import SignalController

    ctl = SignalController("n4821", "w1188", controller="my-script")
    ctl.take_control()
    ...                      # do work with the light held green
    ctl.release()

    # or, as a context manager (always releases, even on exception):
    with SignalController("n4821", "w1188") as ctl:
        ...

Run directly for a quick manual test against a locally running serve.py:
    python signal_control.py n4821 w1188 --seconds 15
"""

import argparse
import json
import time
import urllib.error
import urllib.request


class SignalControlError(RuntimeError):
    pass


class SignalController:
    def __init__(self, node_id, way_id=None, controller="python-script",
                 base_url="http://127.0.0.1:8765", force=False, timeout=5):
        self.node_id = node_id
        self.way_id = way_id
        self.controller = controller
        self.base_url = base_url.rstrip("/")
        self.force = force
        self.timeout = timeout
        self.token = None

    def _post(self, path, payload):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}", data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            # serve.py still returns a JSON body on 4xx (e.g. 409 conflict) -
            # surface that instead of raising a generic HTTPError.
            return json.loads(e.read())

    def take_control(self, way_id=None):
        """Forces `way_id` (or the one passed to __init__) green, every
        other approach at this intersection red, and freezes its clock.
        Pass way_id=None (with none set on __init__ either) to force the
        whole intersection to all-red instead. Raises SignalControlError if
        someone else already holds this intersection and force=False."""
        way_id = way_id if way_id is not None else self.way_id
        result = self._post("/api/signal/override", {
            "nodeId": self.node_id, "wayId": way_id,
            "controller": self.controller, "token": self.token, "force": self.force,
        })
        if not result.get("ok"):
            raise SignalControlError(result.get("error", "override request failed"))
        self.token = result["token"]
        self.way_id = way_id
        return self.token

    def release(self):
        """Hands control back - the intersection's phase clock resumes
        exactly where it was frozen. Safe to call even if take_control()
        was never called, or control was already released."""
        if not self.token:
            return
        self._post("/api/signal/release", {"nodeId": self.node_id, "token": self.token})
        self.token = None

    def __enter__(self):
        self.take_control()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()
        return False


def _main():
    parser = argparse.ArgumentParser(description="Take control of a traffic light intersection for a while, then release it.")
    parser.add_argument("node_id", help="intersection node id, e.g. n4821")
    parser.add_argument("way_id", nargs="?", default=None,
                         help="road id to force green (omit to force all-red)")
    parser.add_argument("--seconds", type=float, default=10,
                         help="how long to hold control before releasing (default: 10)")
    parser.add_argument("--controller", default="python-cli")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--force", action="store_true", help="steal control even if already held")
    args = parser.parse_args()

    ctl = SignalController(args.node_id, args.way_id, controller=args.controller,
                            base_url=args.url, force=args.force)
    print(f"Taking control of {args.node_id} (green: {args.way_id or 'none - all red'}) ...")
    ctl.take_control()
    print(f"In control (token {ctl.token}). Holding for {args.seconds}s - "
          f"open the simulation viewer to watch it live.")
    try:
        time.sleep(args.seconds)
    finally:
        ctl.release()
        print("Released.")


if __name__ == "__main__":
    _main()
