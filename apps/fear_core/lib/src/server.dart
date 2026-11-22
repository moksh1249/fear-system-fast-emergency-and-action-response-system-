import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'discovery_stub.dart' if (dart.library.io) 'discovery_io.dart' as discovery;

/// Where the FEAR backend is.
///
/// On the web the dashboard is served by the backend itself, so the page's
/// own origin is the answer. On a phone, in order: the last address that
/// worked, the USB link (`adb reverse tcp:8080 tcp:8080` makes the laptop
/// answer on the phone's own 127.0.0.1), then a UDP broadcast that the
/// backend's lan_discovery.py answers on the local Wi-Fi.
class ServerLocator {
  static const defaultPort = 8080;

  /// FEAR's permanent public address (a named Cloudflare Tunnel - see
  /// setup_permanent_link.py). Built in, so a freshly installed app finds the
  /// server on any network and after any restart without a QR code. Override
  /// at build time with --dart-define=FEAR_SERVER=https://...
  static const publicServer = String.fromEnvironment('FEAR_SERVER', defaultValue: 'https://app.fearsystem.me');

  static String? webOrigin() {
    if (!kIsWeb) return null;
    final base = Uri.base;
    return '${base.scheme}://${base.host}${base.hasPort ? ':${base.port}' : ''}';
  }

  /// True if [baseUrl] answers /health as fear_backend.
  static Future<bool> probe(String baseUrl, {Duration timeout = const Duration(seconds: 3)}) async {
    try {
      final res = await http.get(Uri.parse('$baseUrl/health')).timeout(timeout);
      return res.statusCode == 200 && res.body.contains('fear_backend');
    } catch (_) {
      return false;
    }
  }

  /// Finds a reachable backend, trying [saved] first. Null if nothing answers.
  static Future<String?> locate({String? saved, List<String> known = const []}) async {
    final web = webOrigin();
    if (web != null) return web;
    if (saved != null && await probe(saved)) return saved;
    // every other address this phone has reached the server on (Wi-Fi IPs,
    // public links), most recent first
    for (final k in known) {
      if (k != saved && await probe(k, timeout: const Duration(seconds: 3))) return k;
    }
    const usb = 'http://127.0.0.1:$defaultPort';
    if (usb != saved && await probe(usb, timeout: const Duration(seconds: 2))) return usb;
    if (publicServer.isNotEmpty && publicServer != saved && !known.contains(publicServer) &&
        await probe(publicServer, timeout: const Duration(seconds: 8))) {
      return publicServer;
    }
    final found = await discovery.discoverOnLan();
    if (found != null && await probe(found)) return found;
    return null;
  }

  /// Normalizes what a user typed ("192.168.1.5", "192.168.1.5:8080",
  /// "http://...") into a base URL.
  static String normalize(String input) {
    var s = input.trim();
    if (s.endsWith('/')) s = s.substring(0, s.length - 1);
    if (!s.startsWith('http://') && !s.startsWith('https://')) s = 'http://$s';
    final uri = Uri.parse(s);
    // Bare LAN addresses get the backend's port; https links (the public
    // tunnel) and named hosts are used exactly as given.
    final isIp = RegExp(r'^\d+\.\d+\.\d+\.\d+$').hasMatch(uri.host) || uri.host == 'localhost';
    if (!uri.hasPort && uri.scheme == 'http' && isIp) s = '$s:$defaultPort';
    return s;
  }
}
