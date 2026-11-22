import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:geolocator/geolocator.dart';
import 'package:latlong2/latlong.dart';

/// One position fix. [demo] marks positions that did not come from the GPS
/// receiver; the backend stores the flag and Command shows it.
class Fix {
  const Fix({required this.lat, required this.lon, this.heading, this.speedKmh, this.accuracyM, required this.demo, required this.at});

  final double lat;
  final double lon;
  final double? heading;
  final double? speedKmh;
  final double? accuracyM;
  final bool demo;
  final DateTime at;

  LatLng get latLng => LatLng(lat, lon);
}

enum LocationStatus { off, starting, ok, permissionDenied, serviceDisabled, error }

/// Real GPS by default; a demo position (placed on the map, or driven along a
/// route at a set speed) when [demoMode] is on - for showing the system from
/// outside the mapped area. Demo mode is always visible in the UI.
class LocationService extends ChangeNotifier {
  LocationService({this.backgroundTitle, this.backgroundText});

  /// When set (driver app), Android keeps reporting with the screen off,
  /// under a persistent notification with this text.
  final String? backgroundTitle;
  final String? backgroundText;

  Fix? fix;
  LocationStatus status = LocationStatus.off;
  String? message;
  bool demoMode = false;

  /// Android stopped showing the permission prompt - only Settings can grant it now.
  bool blocked = false;

  StreamSubscription<Position>? _gps;
  Timer? _demoTimer;
  LatLng? _demoPos;
  double? _demoHeading;
  List<LatLng>? _route;
  int _routeIdx = 0;
  double _speedKmh = 40;
  bool _running = false;

  static const _distance = Distance(roundResult: false);

  bool get following => _route != null;
  double get followSpeedKmh => _speedKmh;

  Future<void> start() async {
    _running = true;
    if (demoMode) {
      _startDemo();
    } else {
      await _startGps();
    }
  }

  /// Asks for the location permission again (or opens the phone's settings
  /// when it can no longer be asked for, or location is switched off).
  Future<void> requestAgain() async {
    if (status == LocationStatus.serviceDisabled) {
      await Geolocator.openLocationSettings();
    } else if (blocked) {
      await Geolocator.openAppSettings();
    }
    _gps?.cancel();
    _gps = null;
    if (demoMode) await setDemoMode(false);
    _running = true;
    await _startGps();
  }

  void stop() {
    _running = false;
    _gps?.cancel();
    _gps = null;
    _demoTimer?.cancel();
    _demoTimer = null;
    status = LocationStatus.off;
    notifyListeners();
  }

  Future<void> setDemoMode(bool on, {LatLng? at}) async {
    if (on == demoMode && at == null) return;
    demoMode = on;
    _gps?.cancel();
    _gps = null;
    _demoTimer?.cancel();
    _route = null;
    if (on) {
      _demoPos = at ?? _demoPos ?? fix?.latLng;
      if (_running) _startDemo();
    } else {
      fix = null;
      if (_running) await _startGps();
    }
    notifyListeners();
  }

  /// Demo mode: put the device here.
  void setDemoPosition(LatLng p) {
    _demoPos = p;
    _route = null;
    _emitDemo(speedKmh: 0);
  }

  /// Demo mode: drive along [points] at [speedKmh], one fix a second.
  void followRoute(List<LatLng> points, {double speedKmh = 40}) {
    if (points.length < 2) return;
    _route = points;
    _routeIdx = 0;
    _speedKmh = speedKmh;
    _demoPos = points.first;
    notifyListeners();
  }

  void setFollowSpeed(double kmh) {
    _speedKmh = kmh;
    notifyListeners();
  }

  void stopFollowing() {
    _route = null;
    _emitDemo(speedKmh: 0);
  }

  Future<void> _startGps() async {
    status = LocationStatus.starting;
    message = null;
    notifyListeners();
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        status = LocationStatus.serviceDisabled;
        message = 'Location is turned off on this device.';
        notifyListeners();
        return;
      }
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        blocked = perm == LocationPermission.deniedForever;
        status = LocationStatus.permissionDenied;
        message = perm == LocationPermission.deniedForever
            ? 'Location permission is blocked - allow it in the phone\'s settings.'
            : 'Location permission was not given.';
        notifyListeners();
        return;
      }
      final LocationSettings settings;
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
        settings = AndroidSettings(
          accuracy: LocationAccuracy.best,
          distanceFilter: 0,
          intervalDuration: const Duration(seconds: 1),
          foregroundNotificationConfig: backgroundTitle == null
              ? null
              : ForegroundNotificationConfig(
                  notificationTitle: backgroundTitle!,
                  notificationText: backgroundText ?? '',
                  notificationChannelName: 'FEAR duty tracking',
                  enableWakeLock: true,
                  setOngoing: true,
                ),
        );
      } else {
        settings = const LocationSettings(accuracy: LocationAccuracy.best, distanceFilter: 0);
      }
      _gps = Geolocator.getPositionStream(locationSettings: settings).listen((p) {
        fix = Fix(
          lat: p.latitude,
          lon: p.longitude,
          heading: p.heading >= 0 && p.speed > 0.5 ? p.heading : fix?.heading,
          speedKmh: p.speed >= 0 ? p.speed * 3.6 : null,
          accuracyM: p.accuracy,
          demo: false,
          at: DateTime.now(),
        );
        status = LocationStatus.ok;
        notifyListeners();
      }, onError: (Object e) {
        status = LocationStatus.error;
        message = 'GPS error: $e';
        notifyListeners();
      });
    } catch (e) {
      status = LocationStatus.error;
      message = 'GPS unavailable: $e';
      notifyListeners();
    }
  }

  void _startDemo() {
    _demoTimer?.cancel();
    status = _demoPos == null ? LocationStatus.starting : LocationStatus.ok;
    message = _demoPos == null ? 'Demo location: long-press the map to place yourself.' : null;
    _emitDemo(speedKmh: 0);
    _demoTimer = Timer.periodic(const Duration(seconds: 1), (_) => _tickDemo());
  }

  void _tickDemo() {
    final route = _route;
    if (route == null || _demoPos == null) {
      _emitDemo(speedKmh: 0);
      return;
    }
    var remaining = _speedKmh / 3.6; // metres this second
    var pos = _demoPos!;
    while (remaining > 0 && _routeIdx < route.length - 1) {
      final next = route[_routeIdx + 1];
      final d = _distance.as(LengthUnit.Meter, pos, next);
      _demoHeading = _distance.bearing(pos, next);
      if (d <= remaining) {
        pos = next;
        remaining -= d;
        _routeIdx++;
      } else {
        pos = _distance.offset(pos, remaining, _demoHeading!);
        remaining = 0;
      }
    }
    _demoPos = pos;
    if (_routeIdx >= route.length - 1) {
      _route = null;
      _emitDemo(speedKmh: 0);
    } else {
      _emitDemo(speedKmh: _speedKmh);
    }
  }

  void _emitDemo({required double speedKmh}) {
    final p = _demoPos;
    if (p == null) {
      notifyListeners();
      return;
    }
    final h = _demoHeading;
    fix = Fix(
      lat: p.latitude,
      lon: p.longitude,
      heading: h == null ? null : (h + 360) % 360,
      speedKmh: speedKmh,
      accuracyM: 0,
      demo: true,
      at: DateTime.now(),
    );
    status = LocationStatus.ok;
    message = null;
    notifyListeners();
  }

  @override
  void dispose() {
    stop();
    super.dispose();
  }
}
