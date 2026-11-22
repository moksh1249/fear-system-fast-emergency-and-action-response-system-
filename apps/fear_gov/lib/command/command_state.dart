import 'package:fear_core/fear_core.dart';
import 'package:flutter/foundation.dart';

/// Everything the Command dashboard shows, kept current from the real-time
/// feed (units, engine, corridors - every second) plus lists refetched
/// whenever the server's change counter moves (incidents, alerts).
class CommandState extends ChangeNotifier {
  CommandState(this.session)
      : feed = RealtimeFeed(baseUrl: session.baseUrl!, token: session.token!, app: 'gov', onUnreachable: session.relocate) {
    feed.addListener(notifyListeners);
    feed.versionChanged.addListener(refresh);
  }

  final Session session;
  final RealtimeFeed feed;

  Map<String, dynamic> meta = {};
  List<Map<String, dynamic>> incidents = [];
  List<Map<String, dynamic>> alerts = [];
  Map<String, dynamic>? ai; // the AI dispatch agent's settings and status (GET /gov/ai)
  Map<String, String> orgNames = {};
  String? selectedIncidentId;
  String? selectedVehicleId;
  bool loaded = false;

  ApiClient get api => session.api;
  Map<String, dynamic> get profile => session.profile!;
  Map<String, dynamic> get perms => Map<String, dynamic>.from(profile['permissions'] as Map);
  String get role => profile['role'] as String;
  bool get isCommand => role == 'super_admin' || role == 'operator';
  bool can(String p) => perms[p] == true;
  List<String> get dispatchCategories => List<String>.from(perms['dispatchCategories'] as List);

  Map<String, dynamic>? get tick => feed.tick;
  List<Map<String, dynamic>> get units =>
      ((tick?['units'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  List<Map<String, dynamic>> get corridors =>
      ((tick?['corridors'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
  Map<String, dynamic> get engine => Map<String, dynamic>.from((tick?['engine'] as Map?) ?? const {});

  /// Every vehicle the engine is moving, anonymous (simulated, or in realistic
  /// mode every phone sending GPS) - for accounts allowed the traffic picture.
  Map<String, dynamic>? get traffic => (tick?['traffic'] as Map?)?.cast<String, dynamic>();

  Map<String, dynamic>? unit(String? id) => units.where((u) => u['vehicleId'] == id).firstOrNull;
  Map<String, dynamic>? incident(String? id) => incidents.where((i) => i['id'] == id).firstOrNull;

  Future<void> start() async {
    feed.start();
    try {
      meta = Map<String, dynamic>.from(await api.get('/gov/meta') as Map);
      final me = await api.get('/gov/me');
      await session.updateProfile(Map<String, dynamic>.from(me as Map));
    } catch (_) {}
    await refresh();
  }

  Future<void> refresh() async {
    try {
      if (isCommand) {
        incidents = (await api.get('/gov/incidents') as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
        ai = Map<String, dynamic>.from(await api.get('/gov/ai') as Map);
      }
      alerts = (await api.get('/gov/alerts') as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
      final orgs = await api.get('/gov/orgs') as List;
      orgNames = {for (final o in orgs) (o as Map)['id'] as String: o['name'] as String};
    } catch (_) {}
    loaded = true;
    notifyListeners();
  }

  Future<void> setAi({bool? enabled, String? mode}) async {
    final r = await api.put('/gov/ai', {'enabled': ?enabled, 'mode': ?mode});
    ai = {...?ai, ...Map<String, dynamic>.from(r as Map)};
    notifyListeners();
  }

  void selectIncident(String? id) {
    selectedIncidentId = id;
    if (id != null) selectedVehicleId = null;
    notifyListeners();
  }

  void selectVehicle(String? id) {
    selectedVehicleId = id;
    if (id != null) selectedIncidentId = null;
    notifyListeners();
  }

  String label(String table, String? key) {
    final m = meta[table];
    if (m is Map && key != null && m[key] != null) return '${m[key]}';
    return titleCase(key ?? '');
  }

  @override
  void dispose() {
    feed.versionChanged.removeListener(refresh);
    feed.removeListener(notifyListeners);
    feed.dispose();
    super.dispose();
  }
}
