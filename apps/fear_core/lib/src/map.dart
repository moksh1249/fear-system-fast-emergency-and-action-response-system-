import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:latlong2/latlong.dart';

import 'project_map.dart';
import 'theme.dart';

/// Centre of the mapped area (map_data.json's projection origin, Ghaziabad).
const fearHome = LatLng(28.666925, 77.44868);

/// The base map both apps draw on: the city drawn natively in the
/// red-lights-revamped viewer's style ([ProjectMapLayer], with live traffic
/// lights), plus whatever layers the screen adds on top.
///
/// Every map gesture is on: drag, fling, pinch-zoom, two-finger rotate,
/// double-tap zoom, double-tap-and-drag zoom, mouse-wheel / trackpad zoom,
/// ctrl+drag rotate and arrow keys on desktop. [zoomButtons] adds +/- buttons
/// (for a mouse without a wheel); a compass appears whenever the map is
/// turned away from north - tap it to straighten up.
class FearMap extends StatelessWidget {
  const FearMap({
    super.key,
    this.controller,
    this.children = const [],
    this.onTap,
    this.onLongPress,
    this.initialCenter = fearHome,
    this.initialZoom = 14,
    this.onPositionChanged,
    this.zoomButtons = false,
    this.compass = true,
    this.controlsPadding = const EdgeInsets.fromLTRB(0, 12, 12, 0),
    this.minZoom = 11,
  });

  final MapController? controller;
  final List<Widget> children;
  final void Function(LatLng point)? onTap;
  final void Function(LatLng point)? onLongPress;
  final LatLng initialCenter;
  final double initialZoom;
  final void Function(MapCamera camera, bool hasGesture)? onPositionChanged;
  final bool zoomButtons;
  final bool compass;
  final EdgeInsets controlsPadding;
  final double minZoom;

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      FlutterMap(
      mapController: controller,
      options: MapOptions(
        initialCenter: initialCenter,
        initialZoom: initialZoom,
        minZoom: minZoom,
        maxZoom: 20,
        backgroundColor: mapBackground,
        // Not constrained to the mapped area: a phone outside it must still
        // see where it really is (the screens say it is outside coverage).
        onTap: onTap == null ? null : (_, p) => onTap!(p),
        onLongPress: onLongPress == null ? null : (_, p) => onLongPress!(p),
        onPositionChanged: onPositionChanged,
        interactionOptions: const InteractionOptions(
          flags: InteractiveFlag.all,
          // zoom and rotate together with two fingers, as in any maps app
          enableMultiFingerGestureRace: true,
          rotationThreshold: 15,
          keyboardOptions: KeyboardOptions(enableArrowKeysPanning: true, enableRFZooming: true, enableQERotating: true),
        ),
      ),
      children: [
        const ProjectMapLayer(),
        ...children,
        if (zoomButtons || compass) _MapControls(zoomButtons: zoomButtons, compass: compass, padding: controlsPadding),
      ],
      ),
      ListenableBuilder(
        listenable: ProjectMap.instance,
        builder: (context, _) {
          final m = ProjectMap.instance;
          if (m.ready) return const SizedBox.shrink();
          return Center(
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(14),
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (m.loading) const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
                  const SizedBox(width: 10),
                  Text(m.error ?? 'Loading the city map...'),
                ]),
              ),
            ),
          );
        },
      ),
    ]);
  }
}

/// Zoom buttons and a compass, drawn over the map (inside FlutterMap, so it
/// follows the camera).
class _MapControls extends StatelessWidget {
  const _MapControls({required this.zoomButtons, required this.compass, required this.padding});

  final bool zoomButtons;
  final bool compass;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final camera = MapCamera.of(context);
    final ctl = MapController.of(context);
    final rotated = camera.rotation % 360 != 0;
    void zoomBy(double d) => ctl.move(camera.center, (camera.zoom + d).clamp(camera.minZoom ?? 1, camera.maxZoom ?? 20));
    Widget button(IconData icon, String tip, VoidCallback onTap, {Widget? child}) => Material(
          color: Colors.white,
          elevation: 3,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onTap,
            child: Tooltip(
              message: tip,
              child: SizedBox(width: 40, height: 40, child: Center(child: child ?? Icon(icon, size: 22, color: Colors.black87))),
            ),
          ),
        );
    return Align(
      alignment: Alignment.topRight,
      child: Padding(
        padding: padding,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (zoomButtons) ...[
            button(Icons.add, 'Zoom in', () => zoomBy(1)),
            const SizedBox(height: 6),
            button(Icons.remove, 'Zoom out', () => zoomBy(-1)),
            const SizedBox(height: 6),
          ],
          if (compass && (rotated || zoomButtons))
            button(Icons.navigation, 'Face north', () => ctl.rotate(0),
                child: Transform.rotate(
                  angle: camera.rotationRad,
                  child: const Icon(Icons.navigation, size: 22, color: Color(0xFFD32F2F)),
                )),
        ]),
      ),
    );
  }
}

/// A repeating soft ring - marks vehicles running with emergency priority.
class Pulse extends StatefulWidget {
  const Pulse({super.key, required this.color, required this.size});

  final Color color;
  final double size;

  @override
  State<Pulse> createState() => _PulseState();
}

class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (_, _) => Container(
        width: widget.size * (0.5 + _c.value * 0.5),
        height: widget.size * (0.5 + _c.value * 0.5),
        decoration: BoxDecoration(shape: BoxShape.circle, color: widget.color.withValues(alpha: 0.45 * (1 - _c.value))),
      ),
    );
  }
}

/// A fleet vehicle: category icon in its colour, a heading arrow, a pulse
/// while it holds emergency priority, faded when its position is stale.
/// How big a vehicle marker is at a zoom level: small enough zoomed out that
/// a busy city stays readable, full size at street level.
double vehicleMarkerSize(double zoom) => (6 + (zoom - 13) * 4.5).clamp(9.0, 26.0);

class VehicleMarkerIcon extends StatelessWidget {
  const VehicleMarkerIcon({
    super.key,
    required this.category,
    this.heading,
    this.emergency = false,
    this.stale = false,
    this.selected = false,
    this.demo = false,
    this.animate = true,
    this.size = 30,
  });

  /// Diameter of the round badge; the arrow, pulse and border scale with it.
  final double size;

  final String category;
  final double? heading;
  final bool emergency;
  final bool stale;
  final bool selected;
  final bool demo;

  /// false when [heading] is already smoothed (see [SmoothFix]).
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final color = FearColors.category(category);
    final k = size / 30;
    return Opacity(
      opacity: stale ? 0.45 : 1,
      child: Stack(alignment: Alignment.center, children: [
        if (emergency) Pulse(color: color, size: 56 * k),
        if (heading != null)
          animate
              ? SmoothHeading(heading: heading!, child: _arrow(color, 16 * k))
              : Transform.rotate(angle: heading! * math.pi / 180, child: _arrow(color, 16 * k)),
        Container(
          width: size,
          height: size,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
            border: Border.all(color: selected ? Colors.yellowAccent : Colors.white, width: (selected ? 3 : 2) * k.clamp(0.6, 1.0)),
            boxShadow: [BoxShadow(blurRadius: 4 * k, color: Colors.black38)],
          ),
          child: size >= 16 ? Icon(FearIcons.category(category), size: 17 * k, color: Colors.white) : null,
        ),
        if (demo)
          Positioned(
            right: 6,
            bottom: 6,
            child: Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(color: FearColors.demo, shape: BoxShape.circle, border: Border.all(color: Colors.white)),
            ),
          ),
      ]),
    );
  }
}

Widget _arrow(Color color, double size) => Align(alignment: Alignment.topCenter, child: Icon(Icons.navigation, size: size, color: color));

class IncidentMarkerIcon extends StatelessWidget {
  const IncidentMarkerIcon({super.key, required this.kind, this.selected = false, this.pending = false, this.size = 30});

  final String kind;
  final bool selected;
  final bool pending;
  final double size;

  @override
  Widget build(BuildContext context) {
    final color = FearColors.incident(kind);
    final k = size / 30;
    return Stack(alignment: Alignment.center, children: [
      if (!pending) Pulse(color: color, size: 48 * k),
      Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          color: pending ? Colors.white : color,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: selected ? Colors.yellowAccent : (pending ? color : Colors.white), width: selected ? 3 : 2),
          boxShadow: const [BoxShadow(blurRadius: 4, color: Colors.black38)],
        ),
        child: Icon(FearIcons.incident(kind), size: 18 * k, color: pending ? color : Colors.white),
      ),
    ]);
  }
}

/// The device's own position: blue, or orange in demo mode. Pass
/// [animate] false when [heading] is already smoothed (see [SmoothFix]).
class MeMarkerIcon extends StatelessWidget {
  const MeMarkerIcon({super.key, this.demo = false, this.heading, this.animate = true});

  final bool demo;
  final double? heading;
  final bool animate;

  @override
  Widget build(BuildContext context) {
    final color = demo ? FearColors.demo : const Color(0xFF1976D2);
    final arrow = Icon(Icons.navigation, color: color, size: 30);
    return Stack(alignment: Alignment.center, children: [
      Container(width: 34, height: 34, decoration: BoxDecoration(shape: BoxShape.circle, color: color.withValues(alpha: 0.18))),
      if (heading != null)
        animate ? SmoothHeading(heading: heading!, child: arrow) : Transform.rotate(angle: heading! * math.pi / 180, child: arrow)
      else
        Container(
          width: 16,
          height: 16,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle, border: Border.all(color: Colors.white, width: 3)),
        ),
    ]);
  }
}

/// A junction the traffic engine is currently holding green for an emergency vehicle.
class PreemptedSignalIcon extends StatelessWidget {
  const PreemptedSignalIcon({super.key});

  @override
  Widget build(BuildContext context) {
    return Stack(alignment: Alignment.center, children: [
      const Pulse(color: Color(0xFF00C853), size: 40),
      Container(
        width: 22,
        height: 22,
        decoration: BoxDecoration(color: const Color(0xFF1B5E20), borderRadius: BorderRadius.circular(6), border: Border.all(color: Colors.white, width: 2)),
        child: const Icon(Icons.traffic, size: 14, color: Color(0xFF69F0AE)),
      ),
    ]);
  }
}

/// Rotates [child] to [heading] (degrees clockwise from north), turning the
/// short way round over [duration] instead of snapping - north to south
/// sweeps through east or west, never jumps.
class SmoothHeading extends StatefulWidget {
  const SmoothHeading({super.key, required this.heading, required this.child, this.duration = const Duration(milliseconds: 450)});

  final double heading;
  final Widget child;
  final Duration duration;

  @override
  State<SmoothHeading> createState() => _SmoothHeadingState();
}

class _SmoothHeadingState extends State<SmoothHeading> {
  late double _target = widget.heading;

  @override
  void didUpdateWidget(SmoothHeading old) {
    super.didUpdateWidget(old);
    _target += shortestTurn(_target, widget.heading);
  }

  @override
  Widget build(BuildContext context) {
    return TweenAnimationBuilder<double>(
      tween: Tween<double>(end: _target),
      duration: widget.duration,
      curve: Curves.easeOutCubic,
      builder: (_, v, child) => Transform.rotate(angle: v * math.pi / 180, child: child),
      child: widget.child,
    );
  }
}

/// The signed turn (-180..180 degrees) from heading [from] to heading [to].
double shortestTurn(double from, double to) {
  final d = (to - from) % 360;
  return d > 180 ? d - 360 : d;
}

/// Glides the shown position and heading between GPS fixes (which arrive
/// about once a second), so the "me" arrow - and a camera following it -
/// move continuously instead of jumping from fix to fix. [heading] is
/// unwrapped (it can pass 360 or go below 0), so it always turns the short
/// way; it is still a valid rotation angle.
class SmoothFix extends ChangeNotifier {
  SmoothFix(TickerProvider vsync, {Duration duration = const Duration(milliseconds: 950)}) {
    _c = AnimationController(vsync: vsync, duration: duration)..addListener(_tick);
  }

  late final AnimationController _c;
  LatLng? position;
  double? heading;
  LatLng? _from;
  LatLng? _to;
  double? _hFrom;
  double? _hTo;

  void push(LatLng p, double? h) {
    final cur = position;
    // the first fix, or a teleport (demo pin, GPS catching up): no glide
    if (cur == null || const Distance().as(LengthUnit.Meter, cur, p) > 300) {
      _c.stop();
      position = p;
      if (h != null) heading = heading == null ? h : heading! + shortestTurn(heading!, h);
      notifyListeners();
      return;
    }
    _from = cur;
    _to = p;
    _hFrom = heading;
    _hTo = h == null ? heading : (heading == null ? h : heading! + shortestTurn(heading!, h));
    _hFrom ??= _hTo;
    _c.forward(from: 0);
  }

  void _tick() {
    final t = _c.value;
    final a = _from, b = _to;
    if (a == null || b == null) return;
    position = LatLng(a.latitude + (b.latitude - a.latitude) * t, a.longitude + (b.longitude - a.longitude) * t);
    final h0 = _hFrom, h1 = _hTo;
    if (h0 != null && h1 != null) heading = h0 + (h1 - h0) * t;
    notifyListeners();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }
}

/// An emergency vehicle's route as Command draws it: a dark-blue line with a
/// light-blue glow and a bright dashed centre, so it stands out from every
/// road colour and from the person's own (Google-blue) route.
const emergencyRouteColor = Color(0xFF0B2E83);
const emergencyRouteGlow = Color(0x884FC3F7);
const emergencyRouteHighlight = Color(0xFF8FD3FF);

List<Polyline> emergencyRoutePolylines(List<LatLng> pts, {double width = 7}) => [
      Polyline(points: pts, strokeWidth: width, color: emergencyRouteColor, borderStrokeWidth: 3, borderColor: emergencyRouteGlow),
      Polyline(points: pts, strokeWidth: 2, color: emergencyRouteHighlight, pattern: StrokePattern.dashed(segments: const [10, 8])),
    ];

List<LatLng> toLatLngs(List? pts) =>
    (pts ?? const []).map((p) => LatLng(((p as List)[0] as num).toDouble(), (p[1] as num).toDouble())).toList();

LatLng? latLngOf(Map? m) {
  if (m == null || m['lat'] == null || m['lon'] == null) return null;
  return LatLng((m['lat'] as num).toDouble(), (m['lon'] as num).toDouble());
}
