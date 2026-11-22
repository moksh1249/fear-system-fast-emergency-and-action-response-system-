import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';
import 'project_map.dart';
import 'server.dart';

/// The app's connection and sign-in state, persisted on the device.
///
/// [app] namespaces the stored keys ('gov' / 'public') so the two apps never
/// share a token even on the same device.
///
/// Once signed in, the app stays signed in: the token is only dropped when
/// the person signs out or the server says the sign-in is no longer valid
/// (account disabled or removed, password reset). Losing the server - laptop
/// off, a new Wi-Fi address, a new public link - keeps the token; the app
/// looks for the server on every address it has ever reached it on and
/// carries on where it was.
class Session extends ChangeNotifier {
  Session(this.app);

  final String app;

  String? baseUrl;
  String? token;
  Map<String, dynamic>? profile;
  bool loading = true;
  String? connectError;

  late ApiClient api = ApiClient('');

  bool get connected => baseUrl != null;
  bool get signedIn => token != null && profile != null;

  String get _k => 'fear.$app';

  /// Every address this phone has reached the server on, most recent first.
  List<String> known = [];

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString('$_k.baseUrl');
    token = prefs.getString('$_k.token');
    final p = prefs.getString('$_k.profile');
    profile = p == null ? null : jsonDecode(p) as Map<String, dynamic>;
    known = prefs.getStringList('$_k.servers') ?? (saved == null ? [] : [saved]);
    await connect(saved: saved);
  }

  Future<void> _remember(Iterable<String> urls) async {
    final next = <String>[];
    for (final u in [...urls, ...known]) {
      if (u.isNotEmpty && !next.contains(u)) next.add(u);
    }
    known = next.take(10).toList();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList('$_k.servers', known);
  }

  /// Learns the server's other addresses (its Wi-Fi IPs and public link) so
  /// the phone can find it again if the one in use changes.
  Future<void> _learnServers(String base) async {
    try {
      final r = await ApiClient(base).get('/v2/servers');
      final list = ((r as Map)['servers'] as List?)?.cast<String>() ?? const [];
      await _remember([base, ...list.map(ServerLocator.normalize)]);
    } catch (_) {
      await _remember([base]);
    }
  }

  bool _relocating = false;

  /// Called when the live feed can't reach the server for a while: tries the
  /// current address, then every known one. The sign-in is kept throughout.
  Future<void> relocate() async {
    if (_relocating || baseUrl == null) return;
    _relocating = true;
    try {
      if (await ServerLocator.probe(baseUrl!, timeout: const Duration(seconds: 4))) return;
      final found = await ServerLocator.locate(known: known);
      if (found == baseUrl) return;
      final prefs = await SharedPreferences.getInstance();
      if (found != null) {
        baseUrl = found;
        await prefs.setString('$_k.baseUrl', found);
        ProjectMap.instance.load(found, force: true);
        _learnServers(found);
      } else {
        baseUrl = null; // shows the reconnect screen, still signed in
        connectError = 'The FEAR server isn\'t answering. Still signed in - reconnecting...';
      }
      _rebuildApi();
      notifyListeners();
    } finally {
      _relocating = false;
    }
  }

  /// Locates the backend (see [ServerLocator]). [manual] is an address the
  /// user typed, tried as-is.
  Future<bool> connect({String? saved, String? manual}) async {
    loading = true;
    connectError = null;
    notifyListeners();
    String? found;
    if (manual != null) {
      final url = ServerLocator.normalize(manual);
      found = await ServerLocator.probe(url) ? url : null;
      if (found == null) connectError = 'No FEAR server answered at $url.';
    } else {
      found = await ServerLocator.locate(saved: saved ?? (known.isEmpty ? null : known.first), known: known);
      if (found == null) connectError = 'Couldn\'t find the FEAR server on this network.';
    }
    if (found != null) {
      baseUrl = found;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('$_k.baseUrl', found);
      ProjectMap.instance.load(found, force: true);
      _learnServers(found);
    }
    _rebuildApi();
    loading = false;
    notifyListeners();
    return found != null;
  }

  void _rebuildApi() {
    api = ApiClient(baseUrl ?? '', token: token, onUnauthorized: () => signOut(expired: true));
  }

  bool sessionExpired = false;

  Future<void> signIn(String newToken, Map<String, dynamic> newProfile) async {
    token = newToken;
    profile = newProfile;
    sessionExpired = false;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('$_k.token', newToken);
    await prefs.setString('$_k.profile', jsonEncode(newProfile));
    _rebuildApi();
    notifyListeners();
  }

  Future<void> updateProfile(Map<String, dynamic> newProfile) async {
    profile = newProfile;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('$_k.profile', jsonEncode(newProfile));
    notifyListeners();
  }

  Future<void> signOut({bool expired = false}) async {
    token = null;
    profile = null;
    sessionExpired = expired;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('$_k.token');
    await prefs.remove('$_k.profile');
    _rebuildApi();
    notifyListeners();
  }

  /// Signs in from a FEAR QR code: {"fear":1,"app":..,"servers":[..],"code":..}.
  /// Tries each server address in the code (Wi-Fi first, then the public
  /// link), then trades the one-time code for a session. A code without
  /// "code" only points the app at the server. Returns an error message, or
  /// null on success.
  Future<String?> enrollFromQr(String raw) async {
    Map<String, dynamic> p;
    try {
      p = jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return 'That is not a FEAR QR code.';
    }
    if (p['fear'] != 1 || p['servers'] is! List) return 'That is not a FEAR QR code.';
    if (p['app'] != app) {
      return p['app'] == 'gov' ? 'This QR code is for the FEAR Command app.' : 'This QR code is for the public FEAR app.';
    }
    loading = true;
    connectError = null;
    notifyListeners();
    // Every address in the code at once (Wi-Fi and the public internet link):
    // on mobile data the Wi-Fi one never answers, so waiting on it first
    // would only waste time. The first in the code's order that answers wins.
    final candidates = [for (final s in (p['servers'] as List).cast<String>()) ServerLocator.normalize(s)];
    String? found;
    for (var attempt = 0; attempt < 3 && found == null; attempt++) {
      if (attempt > 0) await Future.delayed(const Duration(seconds: 3)); // a brand-new public link can take a moment
      final ok = await Future.wait([for (final u in candidates) ServerLocator.probe(u, timeout: const Duration(seconds: 6))]);
      for (var i = 0; i < candidates.length; i++) {
        if (ok[i]) {
          found = candidates[i];
          break;
        }
      }
    }
    // The phone may not be on the laptop's Wi-Fi (mobile data, a USB cable):
    // then try the server this app already reaches - the code itself proves
    // it's the right server, or the redeem fails with a clear message.
    if (found == null) {
      for (final url in [?baseUrl, ...known, 'http://127.0.0.1:${ServerLocator.defaultPort}']) {
        if (await ServerLocator.probe(url, timeout: const Duration(seconds: 3))) {
          found = url;
          break;
        }
      }
    }
    if (found == null) {
      loading = false;
      connectError = 'Couldn\'t reach the FEAR server from this phone (tried its Wi-Fi address and its internet link). Check the phone has internet, and that the server laptop is on and online - then scan a fresh QR code.';
      notifyListeners();
      return connectError;
    }
    baseUrl = found;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('$_k.baseUrl', found);
    await _remember([found, ...(p['servers'] as List).cast<String>().map(ServerLocator.normalize)]);
    ProjectMap.instance.load(found, force: true);
    _learnServers(found);
    _rebuildApi();
    String? err;
    if (p['code'] is String) {
      try {
        final r = await api.post('/v2/enroll', {'code': p['code']}) as Map;
        final prof = Map<String, dynamic>.from((r['user'] ?? r['me']) as Map);
        loading = false;
        await signIn(r['token'] as String, prof);
        return null;
      } on ApiException catch (e) {
        err = e.message;
      }
    }
    loading = false;
    notifyListeners();
    return err;
  }

  Future<void> forgetServer() async {
    baseUrl = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('$_k.baseUrl');
    _rebuildApi();
    notifyListeners();
  }
}
