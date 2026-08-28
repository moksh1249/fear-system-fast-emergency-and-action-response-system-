"""
Take control of a traffic light intersection over the network - from any
Python script. (See signal_control_example.cpp for the same thing in C++;
the underlying HTTP API works from any language.)

Every traffic-light intersection has up to 8 individually-controllable
lamps - each approach (up to 4 of them) has its OWN "straight" and "right"
lamp (see front-end/redlight.js's "Paired 4-way choreography" section for
how a normal 4-way intersection times these 8 lamps against each other on
its own). External control can force ANY combination of those lamps green
at once, from a single one of the 8 up to a whole custom phase - every
other lamp at that intersection is forced red.

The running serve.py (python serve.py, at the project root) exposes a tiny
JSON API on http://127.0.0.1:8765 for this:

    POST /api/signal/override   {nodeId, greenLamps, controller, token?, force?}
        -> {ok, token}            greenLamps is a list of {wayId, movement}
                                   ("through" or "right"), e.g.
                                   [{"wayId":"w1188","movement":"through"}] -
                                   every lamp it names is forced green, every
                                   OTHER lamp at `nodeId` is forced red, and
                                   the intersection's own fixed-time clock
                                   (or its whole turn-taking group's clock,
                                   if it's grouped) freezes so it picks back
                                   up exactly where it left off once
                                   released. Pass an empty list to force
                                   every lamp red instead (a full stop).
                                   Returns 409 if someone else already holds
                                   it - pass force=True to steal it anyway.
                                   (A legacy {wayId, controller, ...} shape
                                   with no greenLamps is still accepted, and
                                   expands to "both movements of this
                                   approach" - see SignalController.take_control.)
    POST /api/signal/release     {nodeId, token, force?}
        -> {ok}                    Hands control back. Only the token that
                                    took control can release it, unless
                                    force=True.
    GET  /api/signal/overrides
        -> {ok, overrides}          Everything currently under external
                                     control (nodeId -> {greenLamps,
                                     controller, since}) - this is what the
                                     browser polls to mirror the override and
                                     draw it in the simulation viewer.

nodeId/wayId are whatever ids the intersection/road already have in
map_data.json - click the intersection in the editor or simulation viewer
and its id is shown in the inspector panel's title; the "Traffic light ·
external control" panel there also lists each of its up to 8 lamps by
wayId + movement.

Usage:
    from signal_control import SignalController

    # Whole-approach control (both of an approach's lamps at once) -
    # matches what this project's override always did before per-lamp
    # control existed:
    ctl = SignalController("n4821", "w1188", controller="my-script")
    ctl.take_control()
    ...                      # do work with the light held green
    ctl.change_approach("w2054")   # switch which approach is green, still held
    ctl.release()

    # Per-lamp / per-phase control - force an ARBITRARY set of the up to 8
    # lamps green at once (one entry = one lamp; several entries = a custom
    # phase, e.g. this approach's straight lamp plus the opposite
    # approach's straight lamp):
    ctl = SignalController("n4821", controller="my-script")
    ctl.take_control_lamps([("w1188", "right")])                 # one lamp
    ctl.take_control_lamps([("w1188", "through"), ("w2054", "through")])  # a phase
    ctl.release()

    # or, as a context manager (always releases, even on exception):
    with SignalController("n4821", "w1188") as ctl:
        ctl.change_approach("w2054")
        ...

change_approach()/take_control_lamps() re-send the SAME token take_control()
got, which serve.py treats as updating your existing hold (not a new one -
it never 409s you out of a light you already hold, and the hold's "since"
timestamp doesn't reset), so you can switch which lamps are green as often
as you like without releasing and re-taking control in between.

Run directly for a quick manual test against a locally running serve.py -
holds `way_id` (both its lamps), then cycles through any EXTRA way ids
given, spending --seconds on each before releasing. Append ":through" or
":right" to a way id to control just that one lamp instead of the whole
approach:
    python signal_control.py n4821 w1188 --seconds 15
    python signal_control.py n4821 w1188 w2054 w3399 --seconds 5
    python signal_control.py n4821 w1188:right w1188:through --seconds 5
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

    def change_approach(self, way_id):
        """Switches which approach is forced green without releasing control
        in between - the intersection's clock stays frozen the whole time,
        it just picks up wherever it was once you eventually release().
        Pass way_id=None to switch to forcing every approach red instead.
        Just an alias for take_control(way_id) - since this instance already
        holds a token after an earlier take_control()/__enter__, calling it
        again with a different way_id updates the existing hold instead of
        requesting a new one. Raises SignalControlError if take_control()
        hasn't been called yet (nothing to change)."""
        if not self.token:
            raise SignalControlError("change_approach() called before take_control() - nothing is held yet")
        return self.take_control(way_id)

    def take_control_lamps(self, green_lamps):
        """The general form of take_control()/change_approach(): forces an
        ARBITRARY set of individual lamps green rather than a whole
        approach's both lamps at once. `green_lamps` is an iterable of
        (way_id, movement) pairs, movement being "through" or "right" -
        one pair takes control of just that single lamp (one of the up to
        8 at a 4-way intersection); several pairs force a custom phase, e.g.
        [("w1188", "through"), ("w2054", "through")] to hold both
        opposite approaches' straight lamps green together. Pass an empty
        list to force every lamp at this intersection red instead.

        Composes with everything else on this instance the same way
        take_control() does: reuses self.token if already held (so this is
        also how you change an existing hold's lamps without releasing
        first), respects self.force, and raises SignalControlError on a
        409 conflict."""
        result = self._post("/api/signal/override", {
            "nodeId": self.node_id,
            "greenLamps": [{"wayId": w, "movement": m} for w, m in green_lamps],
            "controller": self.controller, "token": self.token, "force": self.force,
        })
        if not result.get("ok"):
            raise SignalControlError(result.get("error", "override request failed"))
        self.token = result["token"]
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


def _parse_lamp_arg(arg):
    """"w1188" -> whole approach (both lamps); "w1188:right" -> just that
    one lamp. Returns a list of (way_id, movement) pairs, ready to hand to
    take_control_lamps()."""
    if ":" in arg:
        way_id, movement = arg.split(":", 1)
        if movement not in ("through", "right"):
            raise SystemExit(f"invalid movement {movement!r} in {arg!r} - use 'through' or 'right'")
        return [(way_id, movement)]
    return [(arg, "through"), (arg, "right")]


def _main():
    parser = argparse.ArgumentParser(
        description="Take control of a traffic light intersection, optionally cycling through "
                     "several approaches/lamps without ever releasing control in between, then release it.")
    parser.add_argument("node_id", help="intersection node id, e.g. n4821")
    parser.add_argument("way_ids", nargs="*", default=[],
                         help="one or more road ids to force green in turn (omit entirely to force all-red); "
                              "append :through or :right to control just that one lamp, e.g. w1188:right")
    parser.add_argument("--seconds", type=float, default=10,
                         help="how long to hold each step before switching/releasing (default: 10)")
    parser.add_argument("--controller", default="python-cli")
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--force", action="store_true", help="steal control even if already held")
    args = parser.parse_args()

    steps = [_parse_lamp_arg(a) for a in args.way_ids] or [[]]  # no args at all -> force all-red
    ctl = SignalController(args.node_id, controller=args.controller, base_url=args.url, force=args.force)
    print(f"Taking control of {args.node_id} (green: {steps[0] or 'none - all red'}) ...")
    ctl.take_control_lamps(steps[0])
    print(f"In control (token {ctl.token}). Holding for {args.seconds}s - "
          f"open the simulation viewer to watch it live.")
    try:
        time.sleep(args.seconds)
        for lamps in steps[1:]:
            print(f"Switching to {lamps} (control never released) ...")
            ctl.take_control_lamps(lamps)
            time.sleep(args.seconds)
    finally:
        ctl.release()
        print("Released.")


if __name__ == "__main__":
    _main()
