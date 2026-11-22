import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:latlong2/latlong.dart';

import 'format.dart';
import 'location.dart';

/// Turn-by-turn guidance along a route from the backend (points + steps, see
/// fear_backend/navigation.py): where you are along it, the next manoeuvre
/// and how far away it is, spoken prompts, and an off-route signal so the
/// screen can ask for a new route.
class NavSession extends ChangeNotifier {
  NavSession({this.voice = true});

  bool voice;
  List<LatLng> points = const [];
  List<Map<String, dynamic>> steps = const [];
  double durationSec = 0;
  double totalM = 0;
  int stepIdx = 0; // the manoeuvre we are heading towards
  double alongM = 0;
  double toNextM = 0;
  bool arrived = false;
  bool offRoute = false;
  bool active = false;
  DateTime? startedAt;

  List<double> _cum = const [];
  List<double> _stepAlong = const [];
  int _offCount = 0;
  final Set<String> _spoken = {};
  FlutterTts? _tts;
  static const _distance = Distance(roundResult: false);

  /// Called when the device has left the route - the screen re-plans.
  VoidCallback? onOffRoute;

  Map<String, dynamic>? get next => stepIdx < steps.length ? steps[stepIdx] : null;
  Map<String, dynamic>? get after => stepIdx + 1 < steps.length ? steps[stepIdx + 1] : null;
  double get remainingM => math.max(0, totalM - alongM);
  double get remainingSec => totalM <= 0 ? 0 : durationSec * remainingM / totalM;

  void start(Map<String, dynamic> route) {
    points = (route['points'] as List).map((p) => LatLng(((p as List)[0] as num).toDouble(), (p[1] as num).toDouble())).toList();
    steps = ((route['steps'] as List?) ?? const []).map((s) => Map<String, dynamic>.from(s as Map)).toList();
    durationSec = (route['durationSec'] as num?)?.toDouble() ?? 0;
    final cum = <double>[0];
    for (var i = 1; i < points.length; i++) {
      cum.add(cum.last + _distance.as(LengthUnit.Meter, points[i - 1], points[i]));
    }
    _cum = cum;
    totalM = cum.isEmpty ? 0 : cum.last;
    _stepAlong = steps.map((s) => _project(LatLng((s['lat'] as num).toDouble(), (s['lon'] as num).toDouble())).$1).toList();
    stepIdx = steps.length > 1 ? 1 : 0; // step 0 is "depart"
    alongM = 0;
    arrived = false;
    offRoute = false;
    _offCount = 0;
    _spoken.clear();
    active = true;
    startedAt ??= DateTime.now();
    if (steps.isNotEmpty) _say('start', steps.first['instruction'] as String);
    notifyListeners();
  }

  void toggleVoice() {
    voice = !voice;
    if (!voice) _tts?.stop();
    notifyListeners();
  }

  void stop() {
    active = false;
    arrived = false;
    startedAt = null;
    points = const [];
    steps = const [];
    _tts?.stop();
    notifyListeners();
  }

  /// (distance along the route, distance off it) for a position.
  (double, double) _project(LatLng p) {
    if (points.length < 2) return (0, double.infinity);
    final kx = math.cos(p.latitude * math.pi / 180) * 111320.0, ky = 110540.0;
    var best = double.infinity, bestAlong = 0.0;
    for (var i = 0; i + 1 < points.length; i++) {
      final ax = (points[i].longitude - p.longitude) * kx, ay = (points[i].latitude - p.latitude) * ky;
      final bx = (points[i + 1].longitude - p.longitude) * kx, by = (points[i + 1].latitude - p.latitude) * ky;
      final ex = bx - ax, ey = by - ay;
      final seg2 = ex * ex + ey * ey;
      final t = seg2 < 1e-9 ? 0.0 : (-(ax * ex + ay * ey) / seg2).clamp(0.0, 1.0);
      final px = ax + ex * t, py = ay + ey * t;
      final d = math.sqrt(px * px + py * py);
      if (d < best) {
        best = d;
        bestAlong = _cum[i] + (_cum[i + 1] - _cum[i]) * t;
      }
    }
    return (bestAlong, best);
  }

  void update(Fix fix) {
    if (!active || points.length < 2) return;
    final (along, off) = _project(fix.latLng);
    // Never jump backwards along the route by more than a little (GPS jitter at junctions).
    alongM = math.max(alongM - 20, along);
    if (off > 45) {
      _offCount++;
      if (_offCount >= 3 && !offRoute) {
        offRoute = true;
        _say('off', 'Recalculating');
        onOffRoute?.call();
      }
    } else {
      _offCount = 0;
      offRoute = false;
    }
    while (stepIdx < steps.length - 1 && _stepAlong[stepIdx] - alongM < 12) {
      stepIdx++;
    }
    toNextM = stepIdx < _stepAlong.length ? math.max(0, _stepAlong[stepIdx] - alongM) : 0;
    final n = next;
    if (n != null) {
      final text = n['instruction'] as String;
      if (n['type'] == 'arrive') {
        if (remainingM < 25 && !arrived) {
          arrived = true;
          _say('arrive', 'You have arrived');
        }
      } else if (toNextM <= 60) {
        _say('now$stepIdx', text);
      } else if (toNextM <= 350 && toNextM > 150) {
        _say('soon$stepIdx', 'In ${(toNextM / 50).round() * 50} metres, ${text[0].toLowerCase()}${text.substring(1)}');
      }
    }
    notifyListeners();
  }

  Future<void> _say(String key, String text) async {
    if (!voice || _spoken.contains(key)) return;
    _spoken.add(key);
    try {
      _tts ??= FlutterTts()
        ..setLanguage('en-IN')
        ..setSpeechRate(0.5);
      await _tts!.speak(text);
    } catch (_) {}
  }

  @override
  void dispose() {
    _tts?.stop();
    super.dispose();
  }
}

IconData maneuverIcon(String? type, String? modifier) {
  final left = modifier == 'left';
  return switch (type) {
    'depart' => Icons.navigation,
    'arrive' => Icons.flag,
    'continue' => Icons.straight,
    'slight' => left ? Icons.turn_slight_left : Icons.turn_slight_right,
    'turn' => left ? Icons.turn_left : Icons.turn_right,
    'sharp' => left ? Icons.turn_sharp_left : Icons.turn_sharp_right,
    'uturn' => left ? Icons.u_turn_left : Icons.u_turn_right,
    _ => Icons.straight,
  };
}

/// The green instruction card at the top of the screen while navigating.
class NavBanner extends StatelessWidget {
  const NavBanner({super.key, required this.nav, this.color = const Color(0xFF0B6E4F)});

  final NavSession nav;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final n = nav.next;
    if (n == null) return const SizedBox.shrink();
    final a = nav.after;
    return Material(
      color: nav.offRoute ? const Color(0xFF8E2C2C) : color,
      borderRadius: BorderRadius.circular(14),
      elevation: 6,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Row(children: [
            Icon(nav.offRoute ? Icons.sync : maneuverIcon(n['type'] as String?, n['modifier'] as String?), color: Colors.white, size: 42),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(nav.offRoute ? 'Recalculating...' : (n['type'] == 'arrive' ? fmtDistance(nav.remainingM) : fmtDistance(nav.toNextM)),
                    style: const TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800)),
                Text(n['instruction'] as String, style: const TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600)),
              ]),
            ),
          ]),
          if (a != null && !nav.offRoute)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Row(children: [
                const Text('Then ', style: TextStyle(color: Colors.white70)),
                Icon(maneuverIcon(a['type'] as String?, a['modifier'] as String?), color: Colors.white70, size: 18),
                const SizedBox(width: 4),
                Flexible(child: Text(a['instruction'] as String, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Colors.white70))),
              ]),
            ),
        ]),
      ),
    );
  }
}

/// ETA / arrival time / distance left, with an end button.
class NavBottomBar extends StatelessWidget {
  const NavBottomBar({super.key, required this.nav, required this.onEnd, this.title});

  final NavSession nav;
  final VoidCallback onEnd;
  final String? title;

  @override
  Widget build(BuildContext context) {
    final eta = DateTime.now().add(Duration(seconds: nav.remainingSec.round()));
    String two(int v) => v.toString().padLeft(2, '0');
    return Material(
      elevation: 8,
      borderRadius: BorderRadius.circular(16),
      color: Theme.of(context).colorScheme.surface,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Text(nav.arrived ? 'Arrived' : fmtDuration(nav.remainingSec),
                  style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Color(0xFF0B6E4F))),
              Text('${fmtDistance(nav.remainingM)} · arrive ${two(eta.hour)}:${two(eta.minute)}${title != null ? ' · $title' : ''}',
                  maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
          IconButton(
            tooltip: nav.voice ? 'Mute voice' : 'Voice on',
            onPressed: nav.toggleVoice,
            icon: Icon(nav.voice ? Icons.volume_up : Icons.volume_off),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: const Color(0xFFC62828)),
            onPressed: onEnd,
            child: const Text('Exit'),
          ),
        ]),
      ),
    );
  }
}
