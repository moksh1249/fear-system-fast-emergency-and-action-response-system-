import 'dart:async';
import 'dart:convert';
import 'dart:io';

/// Broadcasts fear_backend's discovery request (see the backend's
/// lan_discovery.py for the wire format) and returns the base URL of the
/// first server that answers, taking the reply's source address as the host.
Future<String?> discoverOnLan({Duration timeout = const Duration(seconds: 3)}) async {
  const discoveryPort = 8081;
  RawDatagramSocket? socket;
  try {
    socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    socket.broadcastEnabled = true;
    final request = utf8.encode(jsonEncode({'t': 'fear_discover', 'v': 1, 'service': 'fear_backend'}));
    final completer = Completer<String?>();
    final sub = socket.listen((event) {
      if (event != RawSocketEvent.read || completer.isCompleted) return;
      final dg = socket!.receive();
      if (dg == null) return;
      try {
        final msg = jsonDecode(utf8.decode(dg.data)) as Map<String, dynamic>;
        if (msg['t'] == 'fear_here' && msg['service'] == 'fear_backend') {
          final port = (msg['port'] as num?)?.toInt() ?? 8080;
          completer.complete('http://${dg.address.address}:$port');
        }
      } catch (_) {}
    });
    for (var i = 0; i < 3 && !completer.isCompleted; i++) {
      socket.send(request, InternetAddress('255.255.255.255'), discoveryPort);
      await Future.any([completer.future, Future.delayed(timeout ~/ 3)]);
    }
    final result = completer.isCompleted ? await completer.future : null;
    await sub.cancel();
    return result;
  } catch (_) {
    return null;
  } finally {
    socket?.close();
  }
}
