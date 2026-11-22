import 'dart:async';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'driver_profile.dart';

/// The emergency / government driver's screen. Emergency privileges belong
/// to the vehicle and the organization: the server decides whether this
/// vehicle may hold signal priority; the app only shows what it decided.
class DriverHome extends StatefulWidget {
  const DriverHome({super.key, required this.session});

  final Session session;

  @override
  State<DriverHome> createState() => _DriverHomeState();
}

class _DriverHomeState extends State<DriverHome> with TickerProviderStateMixin {
  late final RealtimeFeed feed = RealtimeFeed(baseUrl: widget.session.baseUrl!, token: widget.session.token!, app: 'gov', onUnreachable: widget.session.relocate);
  final location = LocationService(
    backgroundTitle: 'FEAR - on duty',
    backgroundText: 'Sharing this vehicle\'s position with Command while you are on duty.',
  );
  final _map = MapController();
  late final SmoothFix _smooth = SmoothFix(this)..addListener(_onSmooth);
  final nav = NavSession();
  String? _navKey;
  bool _navStale = false;

  Map<String, dynamic>? _me;
  String? _error;
  bool _follow = true;
  bool _busy = false;
  bool _sending = false;
  DateTime? _lastSent;
  String? _sendError;
  String? _lastTaskId;
  bool _onDutyLocal = false;

  ApiClient get api => widget.session.api;
  Map<String, dynamic>? get vehicle => _me?['vehicle'] as Map<String, dynamic>?;
  Map<String, dynamic>? get st => (feed.tick?['driver'] as Map?)?.cast<String, dynamic>() ?? _me?['state'] as Map<String, dynamic>?;
  Map<String, dynamic>? get task => (st?['task'] as Map?)?.cast<String, dynamic>();
  bool get onDuty => st?['onDuty'] == true;

  @override
  void initState() {
    super.initState();
    feed.addListener(_onTick);
    location.addListener(_onFix);
    nav.addListener(_onNav);
    nav.onOffRoute = () => _navStale = true; // the server re-plans when we leave the route; take its next route
    feed.start();
    _load();
  }

  void _onNav() {
    if (mounted) setState(() {});
  }

  /// Keeps turn-by-turn guidance on the task's current route: restarts it
  /// for a new destination (scene, then hospital) or after a re-plan.
  void _syncNav() {
    final t = task;
    final route = st?['route'] as Map?;
    final moving = t != null && (t['status'] == 'en_route' || t['status'] == 'transporting');
    if (!moving || route == null || (route['points'] as List?)?.isEmpty != false) {
      if (nav.active) nav.stop();
      _navKey = null;
      return;
    }
    final key = '${t['unitId']}|${t['destLat']}|${t['destLon']}';
    if (key != _navKey || _navStale) {
      _navKey = key;
      _navStale = false;
      nav.start(Map<String, dynamic>.from(route));
    }
  }

  @override
  void dispose() {
    feed.removeListener(_onTick);
    location.removeListener(_onFix);
    nav.removeListener(_onNav);
    nav.dispose();
    _smooth.dispose();
    feed.dispose();
    location.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final me = Map<String, dynamic>.from(await api.get('/gov/driver/me') as Map);
      setState(() {
        _me = me;
        _error = null;
      });
      final state = me['state'] as Map?;
      if (state?['onDuty'] == true && !_onDutyLocal) {
        _onDutyLocal = true;
        await location.start();
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    }
  }

  void _onTick() {
    final t = task;
    if (t != null && t['status'] == 'assigned' && t['unitId'] != _lastTaskId) {
      _lastTaskId = t['unitId'] as String;
      _alertNewTask();
    }
    if (t == null) _lastTaskId = null;
    _syncNav();
    if (mounted) setState(() {});
  }

  Future<void> _alertNewTask() async {
    for (var i = 0; i < 3; i++) {
      HapticFeedback.heavyImpact();
      SystemSound.play(SystemSoundType.alert);
      await Future.delayed(const Duration(milliseconds: 400));
    }
  }

  void _onFix() {
    final f = location.fix;
    if (f != null && nav.active) nav.update(f);
    if (f != null) _smooth.push(f.latLng, f.heading);
    if (mounted) setState(() {});
    if (f == null || !_onDutyLocal || _sending) return;
    if (_lastSent != null && DateTime.now().difference(_lastSent!) < const Duration(milliseconds: 900)) return;
    _send(f);
  }

  /// Every frame of the glide between fixes: the camera follows the
  /// smoothed position (and, navigating, turns with the smoothed heading).
  void _onSmooth() {
    final p = _smooth.position;
    if (p == null || !_follow || !onDuty) return;
    try {
      final h = _smooth.heading;
      if (nav.active && h != null) {
        _map.moveAndRotate(p, 17.5, -h);
      } else {
        _map.move(p, _map.camera.zoom);
      }
    } catch (_) {}
  }

  Future<void> _send(Fix f) async {
    _sending = true;
    try {
      await api.post('/gov/driver/location', {
        'lat': f.lat,
        'lon': f.lon,
        'heading_deg': f.heading,
        'speed_kmh': f.speedKmh,
        'accuracy_m': f.accuracyM,
        'demo': f.demo,
      });
      _lastSent = DateTime.now();
      _sendError = null;
    } on ApiException catch (e) {
      _sendError = e.message;
    } finally {
      _sending = false;
    }
  }

  Future<void> _setDuty(bool on) async {
    setState(() => _busy = true);
    final r = await guarded(context, () => api.post('/gov/driver/duty', {'on_duty': on}));
    if (r != null) {
      _onDutyLocal = on;
      if (on) {
        await location.start();
      } else {
        location.stop();
      }
      await _load();
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _status(String status, {String? hospitalId}) async {
    setState(() => _busy = true);
    await guarded(context, () => api.post('/gov/driver/task/${task!['unitId']}/status', {'status': status, 'hospital_id': hospitalId}));
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _transport() async {
    final hospitals = await guarded(context, () => api.get('/gov/driver/hospitals'));
    if (hospitals == null || !mounted) return;
    final picked = await showModalBottomSheet<Map>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          const ListTile(title: Text('Take the patient to'), subtitle: Text('Nearest receiving hospitals')),
          for (final h in hospitals as List)
            ListTile(
              leading: const Icon(Icons.local_hospital, color: FearColors.brand),
              title: Text('${(h as Map)['name']}'),
              subtitle: Text(fmtDistance(h['distanceM'] as num?)),
              onTap: () => Navigator.pop(ctx, h),
            ),
        ]),
      ),
    );
    if (picked != null) await _status('transporting', hospitalId: picked['id'] as String);
  }

  Future<void> _demoMenu() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(
            leading: const Icon(Icons.gps_fixed),
            title: const Text('Real GPS'),
            trailing: !location.demoMode ? const Icon(Icons.check) : null,
            onTap: () => Navigator.pop(ctx, 'real'),
          ),
          ListTile(
            leading: const Icon(Icons.edit_location_alt, color: FearColors.demo),
            title: const Text('Demo location'),
            subtitle: const Text('Long-press the map to place the vehicle; drive the route at a set speed. Command sees it marked DEMO.'),
            trailing: location.demoMode ? const Icon(Icons.check) : null,
            onTap: () => Navigator.pop(ctx, 'demo'),
          ),
        ]),
      ),
    );
    if (choice == null) return;
    await location.setDemoMode(choice == 'demo', at: choice == 'demo' ? (location.fix?.latLng ?? _camCenter()) : null);
    if (choice == 'demo' && !onDuty) location.start();
  }

  LatLng _camCenter() {
    try {
      return _map.camera.center;
    } catch (_) {
      return fearHome;
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = vehicle;
    return Scaffold(
      appBar: AppBar(
        title: Text(v == null ? 'FEAR Driver' : '${v['id']}'),
        actions: [
          if (location.demoMode) const Padding(padding: EdgeInsets.only(right: 8), child: Center(child: DemoBadge(text: 'DEMO'))),
          Icon(Icons.circle, size: 10, color: feed.online ? FearColors.ok : Colors.redAccent),
          IconButton(tooltip: 'Location source', onPressed: _demoMenu, icon: Icon(location.demoMode ? Icons.edit_location_alt : Icons.gps_fixed)),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (v == 'me') await DriverProfilePage.open(context, api);
              if (v == 'out') {
                if (onDuty && task == null) await _setDuty(false);
                await widget.session.signOut();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'me', child: ListTile(leading: Icon(Icons.person_outline), title: Text('Me'))),
              PopupMenuItem(value: 'out', child: ListTile(leading: Icon(Icons.logout), title: Text('Sign out'))),
            ],
          ),
        ],
      ),
      body: _me == null
          ? Center(child: _error != null ? Padding(padding: const EdgeInsets.all(24), child: Text(_error!)) : const CircularProgressIndicator())
          : v == null
              ? _noVehicle()
              : Column(children: [
                  Expanded(flex: 11, child: _mapView()),
                  Expanded(flex: 10, child: _panel()),
                ]),
    );
  }

  Widget _noVehicle() => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const Icon(Icons.no_crash, size: 64),
            const SizedBox(height: 16),
            Text('No vehicle assigned', style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            const Text('Your organization\'s administrator assigns you to a vehicle in FEAR Command. Emergency features unlock only for an assigned, verified vehicle.', textAlign: TextAlign.center),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: _load, child: const Text('Check again')),
          ]),
        ),
      );

  Widget _mapView() {
    final f = location.fix;
    final route = toLatLngs((st?['route'] as Map?)?['points'] as List?);
    final t = task;
    final signals = ((st?['signalsAhead'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final cat = vehicle!['category'] as String;
    return Stack(children: [
      FearMap(
        controller: _map,
        compass: !nav.active,
        initialCenter: f?.latLng ?? latLngOf(st) ?? fearHome,
        initialZoom: 16,
        onPositionChanged: (_, gesture) {
          if (gesture && _follow) setState(() => _follow = false);
        },
        onLongPress: location.demoMode ? (p) => location.setDemoPosition(p) : null,
        children: [
          if (route.length > 1)
            PolylineLayer(polylines: [
              if (st?['emergency'] == true)
                ...emergencyRoutePolylines(route, width: 8)
              else
                Polyline(points: route, strokeWidth: 7, color: const Color(0xFF1976D2), borderStrokeWidth: 2, borderColor: Colors.white),
            ]),
          MarkerLayer(markers: [
            for (final sg in signals) Marker(point: latLngOf(sg)!, width: 40, height: 40, child: const PreemptedSignalIcon()),
            if (t != null && t['destKind'] == 'hospital')
              Marker(point: LatLng((t['destLat'] as num).toDouble(), (t['destLon'] as num).toDouble()), width: 40, height: 40,
                  child: const Icon(Icons.local_hospital, color: FearColors.brand, size: 34)),
            if (t != null)
              Marker(point: LatLng((t['incidentLat'] as num).toDouble(), (t['incidentLon'] as num).toDouble()), width: 48, height: 48,
                  child: IncidentMarkerIcon(kind: t['kind'] as String)),
          ]),
          if (f != null)
            ListenableBuilder(
              listenable: _smooth,
              builder: (context, _) => MarkerLayer(markers: [
                Marker(
                    point: _smooth.position ?? f.latLng,
                    width: 60,
                    height: 60,
                    child: VehicleMarkerIcon(
                        category: cat, heading: _smooth.heading, animate: false, emergency: st?['emergency'] == true, demo: f.demo)),
              ]),
            ),
        ],
      ),
      Positioned(
        right: 12,
        bottom: 12,
        child: FloatingActionButton.small(
          heroTag: 'follow',
          onPressed: () {
            setState(() => _follow = true);
            if (f != null) _map.move(f.latLng, 17);
          },
          child: Icon(_follow ? Icons.gps_fixed : Icons.gps_not_fixed),
        ),
      ),
      if (location.demoMode && location.fix == null)
        const Positioned(left: 12, right: 12, top: 12, child: Card(child: Padding(padding: EdgeInsets.all(12), child: Text('Demo location: long-press the map to place the vehicle.')))),
      if (nav.active) Positioned(left: 10, right: 10, top: 10, child: NavBanner(nav: nav, color: const Color(0xFF8E1B1B))),
      if (onDuty && (st?['engine'] as Map?)?['connected'] == true && (st?['engine'] as Map?)?['simMode'] != 'realistic')
        Positioned(
          left: 10,
          right: 10,
          bottom: 10,
          child: Card(
            color: Theme.of(context).colorScheme.tertiaryContainer,
            child: const ListTile(
              dense: true,
              leading: Icon(Icons.science_outlined),
              title: Text('Command is running a simulation - live tracking and signal priority are paused.'),
            ),
          ),
        ),
    ]);
  }

  Widget _panel() {
    final v = vehicle!;
    final s = st;
    final t = task;
    final emergencyCapable = v['emergencyCapable'] == true;
    final signals = ((s?['signalsAhead'] as List?) ?? const []);
    return ListView(padding: const EdgeInsets.fromLTRB(16, 12, 16, 24), children: [
      LocationNotice(location: location, onUseDemo: () => location.setDemoMode(true, at: _camCenter())),
      if (location.fix != null && !location.fix!.demo && ProjectMap.instance.ready && !ProjectMap.instance.covers(location.fix!.latLng)) ...[
        const SizedBox(height: 8),
        OutOfCoverageNotice(onShowMap: () {
          setState(() => _follow = false);
          _map.move(ProjectMap.instance.centre, 15);
        }),
      ],
      if (location.status != LocationStatus.ok && location.status != LocationStatus.off) const SizedBox(height: 8),
      Row(children: [
        Icon(FearIcons.category(v['category'] as String), color: FearColors.category(v['category'] as String)),
        const SizedBox(width: 8),
        Expanded(
          child: Text('${v['categoryLabel']} · ${v['plate']}\n${v['orgName']}', style: Theme.of(context).textTheme.bodyMedium),
        ),
        StatusPill(s?['status'] as String? ?? 'off_duty'),
      ]),
      if (v['orgVerified'] != true)
        const Padding(padding: EdgeInsets.only(top: 8), child: Text('Your organization is awaiting FEAR verification - emergency priority is unavailable until then.')),
      const SizedBox(height: 12),
      SizedBox(
        height: 48,
        child: onDuty
            ? OutlinedButton.icon(
                onPressed: _busy || t != null ? null : () => _setDuty(false),
                icon: const Icon(Icons.power_settings_new),
                label: Text(t != null ? 'On a task' : 'Go off duty'),
              )
            : FilledButton.icon(
                onPressed: _busy ? null : () => _setDuty(true),
                icon: const Icon(Icons.play_circle),
                label: const Text('Go on duty'),
              ),
      ),
      if (onDuty)
        Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Text(
            _sendError != null
                ? 'Position not sent: $_sendError'
                : _lastSent == null
                    ? 'Waiting for a position fix...'
                    : 'Broadcasting your ${location.fix?.demo == true ? 'demo' : 'GPS'} position to Command${st?['emergency'] == true ? ' with signal priority' : ''} · ${fmtAgo(_lastSent!.toUtc().toIso8601String())}',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: _sendError != null ? Theme.of(context).colorScheme.error : null),
          ),
        ),
      if (emergencyCapable && s?['emergency'] == true) ...[
        const SizedBox(height: 12),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: const Color(0xFF1B5E20), borderRadius: BorderRadius.circular(10)),
          child: Row(children: [
            const Icon(Icons.traffic, color: Color(0xFF69F0AE)),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                signals.isEmpty ? 'Signal priority active - junctions ahead will turn green as you approach' : '${signals.length} junction(s) ahead held GREEN for you',
                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600),
              ),
            ),
          ]),
        ),
      ],
      if (s?['engine'] is Map && (s!['engine'] as Map)['connected'] != true && onDuty)
        const Padding(padding: EdgeInsets.only(top: 8), child: Text('Traffic engine offline - signal priority unavailable right now.')),
      const SizedBox(height: 16),
      if (t == null && onDuty) const Text('Available - waiting for an assignment from Command.'),
      if (t != null) _taskCard(t),
      if (location.demoMode && onDuty) ...[
        const Divider(height: 32),
        _demoControls(),
      ],
    ]);
  }

  Widget _taskCard(Map<String, dynamic> t) {
    final status = t['status'] as String;
    final eta = st?['etaSec'];
    final dist = (st?['route'] as Map?)?['distanceM'];
    final isAmb = vehicle!['category'] == 'ambulance';
    return Card(
      color: status == 'assigned' ? Theme.of(context).colorScheme.errorContainer : null,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Icon(FearIcons.incident(t['kind'] as String), color: FearColors.incident(t['kind'] as String)),
            const SizedBox(width: 8),
            Expanded(child: Text(status == 'assigned' ? 'NEW ASSIGNMENT · ${t['kindLabel']}' : '${t['kindLabel']}', style: Theme.of(context).textTheme.titleMedium)),
            StatusPill(status, dense: true),
          ]),
          const SizedBox(height: 6),
          Text('${t['place'] ?? ''}'),
          if ((t['description'] as String?)?.isNotEmpty == true) Text('"${t['description']}"', style: const TextStyle(fontStyle: FontStyle.italic)),
          const SizedBox(height: 6),
          Text(
            t['destKind'] == 'hospital'
                ? 'To ${t['destName']} · ${fmtDuration(eta as num?)} · ${fmtDistance(dist as num?)}'
                : 'To scene · ${fmtDuration(eta as num?)} · ${fmtDistance(dist as num?)}',
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: switch (status) {
            'assigned' => [
                FilledButton.icon(onPressed: _busy ? null : () => _status('en_route'), icon: const Icon(Icons.check), label: const Text('Accept & go')),
                OutlinedButton(onPressed: _busy ? null : () => _status('declined'), child: const Text('Decline')),
              ],
            'en_route' => [FilledButton.icon(onPressed: _busy ? null : () => _status('on_scene'), icon: const Icon(Icons.place), label: const Text('Arrived on scene'))],
            'on_scene' => [
                if (isAmb) FilledButton.icon(onPressed: _busy ? null : _transport, icon: const Icon(Icons.local_hospital), label: const Text('Transport patient')),
                OutlinedButton.icon(onPressed: _busy ? null : () => _status('completed'), icon: const Icon(Icons.task_alt), label: const Text('Clear scene')),
              ],
            'transporting' => [FilledButton.icon(onPressed: _busy ? null : () => _status('completed'), icon: const Icon(Icons.task_alt), label: const Text('Handed over'))],
            _ => <Widget>[],
          }),
          if (status == 'en_route' || status == 'transporting') ...[
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Request signal priority'),
              subtitle: const Text('Signals on your route turn green ahead of you'),
              value: st?['priorityRequested'] != false,
              onChanged: (on) => guarded(context, () => api.post('/gov/driver/priority', {'enabled': on})),
            ),
          ],
        ]),
      ),
    );
  }

  Widget _demoControls() {
    final route = toLatLngs((st?['route'] as Map?)?['points'] as List?);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Row(children: [DemoBadge(), SizedBox(width: 8), Expanded(child: Text('Long-press the map to move the vehicle.'))]),
      const SizedBox(height: 8),
      Row(children: [
        const Text('Speed'),
        Expanded(
          child: Slider(value: location.followSpeedKmh, min: 10, max: 80, divisions: 14, label: '${location.followSpeedKmh.round()} km/h', onChanged: location.setFollowSpeed),
        ),
        Text('${location.followSpeedKmh.round()} km/h'),
      ]),
      if (location.following)
        OutlinedButton.icon(onPressed: location.stopFollowing, icon: const Icon(Icons.stop), label: const Text('Stop driving'))
      else
        FilledButton.tonalIcon(
          onPressed: route.length > 1 ? () => location.followRoute(route, speedKmh: location.followSpeedKmh) : null,
          icon: const Icon(Icons.route),
          label: Text(route.length > 1 ? 'Drive the route' : 'No route yet'),
        ),
    ]);
  }
}
