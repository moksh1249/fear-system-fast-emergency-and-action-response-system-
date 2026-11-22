import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import 'project_map.dart';

/// The backend's /v2/ws feed: authenticates, then receives one `tick` a
/// second. Reconnects on its own; [tick] holds the latest one.
class RealtimeFeed extends ChangeNotifier {
  RealtimeFeed({required this.baseUrl, required this.token, required this.app, this.onUnreachable});

  final String baseUrl;
  final String token;
  final String app; // 'gov' | 'public'

  /// Called once the server has been unreachable for a while (about 30 s of
  /// failed reconnects) - the session then looks for it on its other
  /// addresses. Never signs anyone out.
  final VoidCallback? onUnreachable;
  int _failedTries = 0;

  Map<String, dynamic>? tick;
  bool online = false;
  int? lastVersion;

  /// Fires when the server's change counter moves - refetch lists then.
  final ValueNotifier<int> versionChanged = ValueNotifier(0);

  WebSocketChannel? _ch;
  StreamSubscription? _sub;
  Timer? _retry;
  bool _closed = false;
  Duration _backoff = const Duration(seconds: 1);
  Map<String, dynamic>? _lastPos;

  void start() {
    _closed = false;
    _connect();
  }

  void _connect() {
    if (_closed) return;
    final wsUrl = baseUrl.replaceFirst(RegExp('^http'), 'ws');
    try {
      _ch = WebSocketChannel.connect(Uri.parse('$wsUrl/v2/ws'));
    } catch (_) {
      _scheduleRetry();
      return;
    }
    _ch!.sink.add(jsonEncode({'type': 'auth', 'app': app, 'token': token}));
    if (_lastPos != null) _ch!.sink.add(jsonEncode(_lastPos));
    _sub = _ch!.stream.listen(
      (raw) {
        final msg = jsonDecode(raw as String) as Map<String, dynamic>;
        if (msg['type'] == 'hello') {
          online = true;
          _failedTries = 0;
          _backoff = const Duration(seconds: 1);
          notifyListeners();
        } else if (msg['type'] == 'tick') {
          tick = msg;
          ProjectMap.instance.onTick(msg, baseUrl);
          final v = (msg['version'] as num?)?.toInt();
          if (v != null && v != lastVersion) {
            lastVersion = v;
            versionChanged.value++;
          }
          notifyListeners();
        }
      },
      onDone: _onDrop,
      onError: (_) => _onDrop(),
      cancelOnError: true,
    );
  }

  void _onDrop() {
    online = false;
    notifyListeners();
    _scheduleRetry();
  }

  void _scheduleRetry() {
    _retry?.cancel();
    if (_closed) return;
    _failedTries++;
    if (_failedTries == 6) onUnreachable?.call();
    _retry = Timer(_backoff, _connect);
    _backoff = Duration(milliseconds: (_backoff.inMilliseconds * 1.6).clamp(1000, 15000).toInt());
  }

  /// Public app: the position nearby-emergency alerts are computed for. Sent
  /// over this socket only; the server keeps it for this connection alone.
  void sendPosition(double lat, double lon) {
    _lastPos = {'type': 'pos', 'lat': lat, 'lon': lon};
    try {
      _ch?.sink.add(jsonEncode(_lastPos));
    } catch (_) {}
  }

  @override
  void dispose() {
    _closed = true;
    _retry?.cancel();
    _sub?.cancel();
    _ch?.sink.close();
    versionChanged.dispose();
    super.dispose();
  }
}
