import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// An error the FEAR backend (or the network) returned, with a message fit
/// to show the user as-is.
class ApiException implements Exception {
  ApiException(this.message, {this.status});

  final String message;
  final int? status;

  bool get unauthorized => status == 401;

  @override
  String toString() => message;
}

/// Thin JSON client for the FEAR backend. Every call returns decoded JSON or
/// throws [ApiException].
class ApiClient {
  ApiClient(this.baseUrl, {this.token, this.onUnauthorized});

  final String baseUrl;
  String? token;

  /// Called when a signed-in request comes back 401 (session expired or revoked).
  void Function()? onUnauthorized;

  static const _timeout = Duration(seconds: 20);

  Uri _uri(String path, [Map<String, Object?>? query]) {
    final q = <String, String>{};
    query?.forEach((k, v) {
      if (v != null) q[k] = '$v';
    });
    return Uri.parse('$baseUrl$path').replace(queryParameters: q.isEmpty ? null : q);
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<dynamic> get(String path, {Map<String, Object?>? query}) =>
      _send(() => http.get(_uri(path, query), headers: _headers));

  Future<dynamic> post(String path, [Object? body]) =>
      _send(() => http.post(_uri(path), headers: _headers, body: jsonEncode(body ?? {})));

  Future<dynamic> patch(String path, [Object? body]) =>
      _send(() => http.patch(_uri(path), headers: _headers, body: jsonEncode(body ?? {})));

  Future<dynamic> put(String path, [Object? body]) =>
      _send(() => http.put(_uri(path), headers: _headers, body: jsonEncode(body ?? {})));

  Future<dynamic> delete(String path) => _send(() => http.delete(_uri(path), headers: _headers));

  /// A raw body (e.g. a recorded voice clip) instead of JSON.
  Future<dynamic> postBytes(String path, List<int> bytes, {required String contentType, Map<String, Object?>? query}) =>
      _send(() => http.post(_uri(path, query), headers: {..._headers, 'Content-Type': contentType}, body: bytes));

  Future<dynamic> _send(Future<http.Response> Function() request) async {
    http.Response res;
    try {
      res = await request().timeout(_timeout);
    } on TimeoutException {
      throw ApiException('The FEAR server took too long to answer.');
    } catch (_) {
      throw ApiException('Can\'t reach the FEAR server. Check the connection.');
    }
    dynamic data;
    if (res.body.isNotEmpty) {
      try {
        data = jsonDecode(utf8.decode(res.bodyBytes));
      } catch (_) {
        data = null;
      }
    }
    if (res.statusCode >= 200 && res.statusCode < 300) return data;
    if (res.statusCode == 401 && token != null) onUnauthorized?.call();
    throw ApiException(_detail(data) ?? 'Request failed (${res.statusCode}).', status: res.statusCode);
  }

  static String? _detail(dynamic data) {
    if (data is Map && data['detail'] != null) {
      final d = data['detail'];
      if (d is String) return _sentence(d);
      if (d is List && d.isNotEmpty && d.first is Map) {
        final first = d.first as Map;
        final loc = (first['loc'] as List?)?.where((e) => e != 'body').join('.') ?? '';
        return _sentence('${loc.isEmpty ? '' : '$loc: '}${first['msg']}');
      }
    }
    if (data is Map && data['error'] is String) return _sentence(data['error'] as String);
    return null;
  }

  static String _sentence(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);
}
