import 'dart:async';
import 'dart:math';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// The public app's live state. Location is foreground-only: it is used for
/// the map, nearby-emergency alerts (sent over the live socket, never
/// stored), SOS/reports when the user sends one, and - only if the user opts
/// in - anonymous traffic pings under a tag that changes every 10 minutes.
class PublicState extends ChangeNotifier {
  PublicState(this.session)
      : feed = RealtimeFeed(baseUrl: session.baseUrl!, token: session.token!, app: 'public', onUnreachable: session.relocate) {
    feed.addListener(_onTick);
    feed.versionChanged.addListener(refreshLists);
    location.addListener(_onFix);
  }

  final Session session;
  final RealtimeFeed feed;
  final location = LocationService();

  Map<String, dynamic> meta = {};
  List<Map<String, dynamic>> alerts = [];
  List<Map<String, dynamic>> myIncidents = [];

  /// Emergency vehicles currently responding near me (category only).
  List<Map<String, dynamic>> get nearby =>
      ((feed.tick?['nearby'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

  /// My open SOS incidents, live (status, responding units, ETA).
  List<Map<String, dynamic>> get openSos =>
      ((feed.tick?['myIncidents'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

  Map<String, dynamic>? get approaching => nearby.where((n) => n['approaching'] == true).firstOrNull;

  /// Whether Command's traffic engine is tracking real phones right now.
  bool get realistic => (feed.tick?['engine'] as Map?)?['simMode'] == 'realistic';
  bool get simulating {
    final e = feed.tick?['engine'] as Map?;
    return e?['connected'] == true && e?['simMode'] == 'simulation';
  }

  ApiClient get api => session.api;
  Map<String, dynamic> get me => session.profile!;

  DateTime? _lastPosSent;
  DateTime? _lastPing;
  bool _pinging = false;
  String _tag = _newTag();
  DateTime _tagSince = DateTime.now();
  bool _wasApproaching = false;

  static String _newTag() {
    final r = Random.secure();
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    return List.generate(12, (_) => chars[r.nextInt(chars.length)]).join();
  }

  Future<void> start() async {
    feed.start();
    location.start();
    try {
      meta = Map<String, dynamic>.from(await api.get('/public/meta') as Map);
      await session.updateProfile(Map<String, dynamic>.from(await api.get('/public/me') as Map));
    } catch (_) {}
    await refreshLists();
  }

  Future<void> refreshLists() async {
    try {
      final f = location.fix;
      alerts = (await api.get('/public/alerts', query: {'lat': f?.lat, 'lon': f?.lon}) as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      myIncidents = (await api.get('/public/incidents') as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    } catch (_) {}
    notifyListeners();
  }

  void _onTick() {
    final a = approaching != null;
    if (a && !_wasApproaching) {
      // Once per approach, not every second it lasts.
      HapticFeedback.vibrate();
      SystemSound.play(SystemSoundType.alert);
    }
    _wasApproaching = a;
    notifyListeners();
  }

  void _onFix() {
    final f = location.fix;
    notifyListeners();
    if (f == null) return;
    final now = DateTime.now();
    if (_lastPosSent == null || now.difference(_lastPosSent!) > const Duration(seconds: 3)) {
      _lastPosSent = now;
      feed.sendPosition(f.lat, f.lon);
    }
    // Anonymous traffic sharing (opt-in) shows this phone's vehicle on
    // Command's traffic picture in realistic mode. Sent whenever Command isn't
    // running a simulation - if the traffic engine is down, the server starts
    // it in realistic mode.
    if (me['shareTraffic'] == true && !simulating && !_pinging &&
        (_lastPing == null || now.difference(_lastPing!) > const Duration(milliseconds: 1500))) {
      _ping(f);
    }
  }

  Future<void> _ping(Fix f) async {
    _pinging = true;
    _lastPing = DateTime.now();
    if (DateTime.now().difference(_tagSince) > const Duration(minutes: 10)) {
      _tag = _newTag();
      _tagSince = DateTime.now();
    }
    try {
      await api.post('/public/traffic-ping', {'tag': _tag, 'lat': f.lat, 'lon': f.lon, 'heading_deg': f.heading, 'speed_kmh': f.speedKmh});
    } catch (_) {
    } finally {
      _pinging = false;
    }
  }

  Future<void> setShareTraffic(bool on) async {
    final r = await api.patch('/public/me', {'share_traffic': on});
    await session.updateProfile(Map<String, dynamic>.from(r as Map));
    notifyListeners();
  }

  @override
  void dispose() {
    feed.removeListener(_onTick);
    feed.versionChanged.removeListener(refreshLists);
    location.removeListener(_onFix);
    feed.dispose();
    location.dispose();
    super.dispose();
  }
}
