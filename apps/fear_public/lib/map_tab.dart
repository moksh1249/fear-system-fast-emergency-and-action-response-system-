import 'dart:async';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'public_state.dart';
import 'responder.dart';
import 'sos.dart';
import 'voice.dart';

/// The home screen: the city map (drawn like the red-lights viewer, with live
/// traffic lights), Google-Maps-style directions from any place to any place
/// and turn-by-turn navigation, SOS, reports, and the "make way" alert for
/// emergency vehicles.
class MapTab extends StatefulWidget {
  const MapTab({super.key, required this.state});

  final PublicState state;

  @override
  State<MapTab> createState() => _MapTabState();
}

/// One end of a route: the person's own position, or a place / map point.
const _myLocation = <String, dynamic>{'me': true, 'name': 'Your location'};

class _MapTabState extends State<MapTab> with TickerProviderStateMixin {
  final _map = MapController();
  final nav = NavSession();
  late final SmoothFix _smooth = SmoothFix(this)..addListener(_onSmooth);
  bool _follow = true;
  bool _centeredOnce = false;
  bool _planning = false; // the From / To card is open
  Map<String, dynamic> _from = _myLocation;
  Map<String, dynamic>? _dest;
  Map<String, dynamic>? _route; // preview or active route
  String? _picking; // 'from' / 'to' while choosing a point on the map
  bool _showSteps = false;
  DateTime? _lastReroute;
  Timer? _arriveTimer;

  PublicState get s => widget.state;

  @override
  void initState() {
    super.initState();
    s.location.addListener(_onFix);
    nav.addListener(_onNav);
    nav.onOffRoute = _reroute;
  }

  @override
  void dispose() {
    s.location.removeListener(_onFix);
    nav.removeListener(_onNav);
    nav.dispose();
    _smooth.dispose();
    _arriveTimer?.cancel();
    super.dispose();
  }

  void _onNav() {
    if (nav.arrived && _arriveTimer == null) {
      _arriveTimer = Timer(const Duration(seconds: 12), _endNav);
    }
    if (mounted) setState(() {});
  }

  void _onFix() {
    final f = s.location.fix;
    if (f == null) return;
    if (nav.active) nav.update(f);
    _smooth.push(f.latLng, f.heading);
    if (!_centeredOnce) {
      _centeredOnce = true;
      try {
        _map.move(f.latLng, 16);
      } catch (_) {}
    }
  }

  /// Every frame of the glide between fixes: a following camera moves (and,
  /// navigating, turns) with the smoothed position instead of jumping.
  void _onSmooth() {
    final p = _smooth.position;
    if (p == null || !_follow || !_centeredOnce) return;
    try {
      final h = _smooth.heading;
      if (nav.active && h != null) {
        _map.moveAndRotate(p, 17.5, -h);
      } else {
        _map.move(p, _map.camera.zoom);
      }
    } catch (_) {}
  }

  void _recenter() {
    setState(() => _follow = true);
    final p = _smooth.position ?? s.location.fix?.latLng;
    if (p == null) return;
    try {
      final h = _smooth.heading;
      if (nav.active && h != null) {
        _map.moveAndRotate(p, 17.5, -h);
      } else {
        _map.move(p, _map.camera.zoom < 15 ? 16 : _map.camera.zoom);
      }
    } catch (_) {}
  }

  LatLng _center() {
    try {
      return _map.camera.center;
    } catch (_) {
      return fearHome;
    }
  }

  bool _isMe(Map<String, dynamic>? spot) => spot?['me'] == true;

  LatLng? _pointOf(Map<String, dynamic>? spot) => spot == null ? null : (_isMe(spot) ? s.location.fix?.latLng : latLngOf(spot));

  Future<Map<String, dynamic>?> _fetchRoute(LatLng from, LatLng to) async {
    final r = await guarded(context, () => s.api.post('/public/route', {
          'from_lat': from.latitude,
          'from_lon': from.longitude,
          'to_lat': to.latitude,
          'to_lon': to.longitude,
        }));
    if (r == null) return null;
    final route = Map<String, dynamic>.from(r as Map);
    if (route['found'] != true) {
      if (mounted) showSnack(context, '${route['error'] ?? 'No route found'}', error: true);
      return null;
    }
    return route;
  }

  /// Plans the route between the current From and To and shows it.
  Future<void> _preview() async {
    if (_dest == null) return;
    final a = _pointOf(_from), b = _pointOf(_dest);
    if (a == null || b == null) {
      showSnack(context, 'Waiting for your location - or choose a starting point.', error: true);
      return;
    }
    final route = await _fetchRoute(a, b);
    if (route == null || !mounted) return;
    setState(() {
      _route = route;
      _follow = false;
      _showSteps = false;
    });
    final pts = toLatLngs(route['points'] as List);
    try {
      _map.rotate(0);
      _map.fitCamera(CameraFit.coordinates(coordinates: pts, padding: const EdgeInsets.fromLTRB(40, 200, 40, 320)));
    } catch (_) {}
  }

  Future<void> _choose(String role) async {
    final picked = await showModalBottomSheet<Map<String, dynamic>>(
      context: context,
      isScrollControlled: true,
      builder: (_) => _SearchSheet(state: s, role: role, near: s.location.fix?.latLng ?? _center()),
    );
    if (picked == null || !mounted) return;
    if (picked['pick'] == true) {
      setState(() {
        _planning = true;
        _picking = role;
        _follow = false;
      });
      return;
    }
    _set(role, picked);
  }

  void _set(String role, Map<String, dynamic> spot) {
    setState(() {
      _planning = true;
      if (role == 'from') {
        _from = spot;
      } else {
        _dest = spot;
      }
      _route = null;
    });
    _preview();
  }

  void _swap() {
    final dest = _dest;
    if (dest == null) return;
    setState(() {
      _dest = _from;
      _from = dest;
      _route = null;
    });
    _preview();
  }

  Future<void> _onMapTap(LatLng p) async {
    final role = _picking;
    if (role == null) return;
    setState(() => _picking = null);
    final r = await guarded(context, () => s.api.get('/public/places/at', query: {'lat': p.latitude, 'lon': p.longitude}));
    final spot = <String, dynamic>{'name': 'Dropped pin', 'lat': p.latitude, 'lon': p.longitude};
    if (r is Map) {
      spot['name'] = r['name'] ?? 'Dropped pin';
      spot['detail'] = r['detail'];
    }
    if (mounted) _set(role, spot);
  }

  void _startNav() {
    if (_route == null || !_isMe(_from)) return;
    nav.start(_route!);
    setState(() {
      _follow = true;
      _planning = false;
    });
    _recenter();
  }

  void _closePlanner() {
    _arriveTimer?.cancel();
    _arriveTimer = null;
    if (nav.active) nav.stop();
    s.location.stopFollowing();
    setState(() {
      _route = null;
      _dest = null;
      _from = _myLocation;
      _planning = false;
      _picking = null;
    });
    try {
      _map.rotate(0);
    } catch (_) {}
  }

  void _endNav() => _closePlanner();

  Future<void> _reroute() async {
    final f = s.location.fix;
    final to = _pointOf(_dest);
    if (f == null || to == null) return;
    if (_lastReroute != null && DateTime.now().difference(_lastReroute!) < const Duration(seconds: 8)) return;
    _lastReroute = DateTime.now();
    final route = await _fetchRoute(f.latLng, to);
    if (route == null || !mounted || !nav.active) return;
    setState(() => _route = route);
    nav.start(route);
  }

  Future<void> _longPress(LatLng p) async {
    if (s.location.demoMode && !nav.active && _picking == null && !_planning) {
      s.location.setDemoPosition(p);
      return;
    }
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.trip_origin), title: const Text('Directions from here'), onTap: () => Navigator.pop(ctx, 'from')),
          ListTile(leading: const Icon(Icons.directions), title: const Text('Directions to here'), onTap: () => Navigator.pop(ctx, 'to')),
          ListTile(leading: const Icon(Icons.report_outlined), title: const Text('Report a problem here'), onTap: () => Navigator.pop(ctx, 'report')),
          if (s.location.demoMode)
            ListTile(leading: const Icon(Icons.edit_location_alt, color: FearColors.demo), title: const Text('Put my demo location here'), onTap: () => Navigator.pop(ctx, 'demo')),
        ]),
      ),
    );
    if (!mounted || choice == null) return;
    if (choice == 'from' || choice == 'to') {
      setState(() => _picking = choice);
      await _onMapTap(p);
    } else if (choice == 'report') {
      await showReportSheet(context, s, at: p);
    } else if (choice == 'demo') {
      s.location.setDemoPosition(p);
    }
  }

  Future<void> _locationMenu() async {
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.gps_fixed), title: const Text('My real location (GPS)'), trailing: !s.location.demoMode ? const Icon(Icons.check) : null, onTap: () => Navigator.pop(ctx, 'real')),
          ListTile(
            leading: const Icon(Icons.edit_location_alt, color: FearColors.demo),
            title: const Text('Demo location'),
            subtitle: const Text('For trying FEAR outside its coverage area: long-press the map to place yourself. Anything you send is marked as demo.'),
            trailing: s.location.demoMode ? const Icon(Icons.check) : null,
            onTap: () => Navigator.pop(ctx, 'demo'),
          ),
        ]),
      ),
    );
    if (choice == null) return;
    await s.location.setDemoMode(choice == 'demo', at: choice == 'demo' ? _center() : null);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final f = s.location.fix;
        final sos = s.openSos.firstOrNull;
        final approaching = s.approaching;
        final routePts = toLatLngs(_route?['points'] as List?);
        final navigating = nav.active;
        final simMode = s.feed.tick?['engine'] is Map && (s.feed.tick!['engine'] as Map)['simMode'] == 'simulation';
        final fromPt = _isMe(_from) ? null : latLngOf(_from);
        final destPt = _isMe(_dest) ? null : latLngOf(_dest);
        return Stack(children: [
          FearMap(
            controller: _map,
            initialZoom: 15,
            // turned with two fingers, a compass appears under the search bar - tap it to face north
            compass: !navigating,
            controlsPadding: EdgeInsets.fromLTRB(0, MediaQuery.paddingOf(context).top + (_planning ? 136 : 88), 16, 0),
            onTap: _onMapTap,
            onLongPress: _longPress,
            onPositionChanged: (_, gesture) {
              if (gesture && _follow) setState(() => _follow = false);
            },
            children: [
              CircleLayer(circles: [
                for (final a in s.alerts)
                  CircleMarker(point: latLngOf(a)!, radius: (a['radiusM'] as num).toDouble(), useRadiusInMeter: true,
                      color: FearColors.warn.withValues(alpha: 0.15), borderColor: FearColors.warn, borderStrokeWidth: 2),
              ]),
              PolylineLayer(polylines: [
                for (final n in s.nearby)
                  if ((n['ahead'] as List?) != null && (n['ahead'] as List).length > 1) ...emergencyRoutePolylines(toLatLngs(n['ahead'] as List), width: 5),
                if (routePts.length > 1)
                  Polyline(points: routePts, strokeWidth: navigating ? 9 : 7, color: const Color(0xFF1A73E8), borderStrokeWidth: 2.5, borderColor: const Color(0xFF0D47A1)),
              ]),
              Builder(builder: (context) {
                final sz = vehicleMarkerSize(MapCamera.of(context).zoom);
                return MarkerLayer(markers: [
                if (fromPt != null)
                  Marker(point: fromPt, width: 22, height: 22, child: Container(
                    decoration: BoxDecoration(color: Colors.white, shape: BoxShape.circle, border: Border.all(color: const Color(0xFF1A73E8), width: 5)),
                  )),
                if (destPt != null) Marker(point: destPt, width: 44, height: 44, alignment: Alignment.topCenter, child: const Icon(Icons.location_on, color: Color(0xFFC62828), size: 44)),
                if (sos != null) Marker(point: latLngOf(sos)!, width: 48, height: 48, child: IncidentMarkerIcon(kind: sos['kind'] as String)),
                if (sos != null)
                  for (final u in (sos['units'] as List))
                    if ((u as Map)['lat'] != null)
                      Marker(key: ValueKey('u${u['vehicleId'] ?? u['id']}'), point: latLngOf(u)!, width: sz * 1.9, height: sz * 1.9,
                          child: VehicleMarkerIcon(size: sz, category: u['category'] as String, heading: (u['heading'] as num?)?.toDouble(), emergency: true)),
                for (final n in s.nearby)
                  Marker(key: ValueKey('n${n['id'] ?? n['vehicleId']}'), point: latLngOf(n)!, width: sz * 1.9, height: sz * 1.9,
                      child: VehicleMarkerIcon(size: sz, category: n['category'] as String, heading: (n['heading'] as num?)?.toDouble(), emergency: true)),
              ]);
              }),
              if (f != null)
                ListenableBuilder(
                  listenable: _smooth,
                  builder: (context, _) => MarkerLayer(markers: [
                    Marker(
                      point: _smooth.position ?? f.latLng,
                      width: 44,
                      height: 44,
                      child: MeMarkerIcon(demo: f.demo, heading: _smooth.heading, animate: false),
                    ),
                  ]),
                ),
            ],
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(children: [
                if (navigating)
                  NavBanner(nav: nav)
                else if (_planning)
                  _plannerCard()
                else
                  Card(
                    elevation: 3,
                    child: ListTile(
                      leading: const Icon(Icons.search),
                      title: const Text('Search here'),
                      onTap: () => _choose('to'),
                      trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                        if (s.location.demoMode) const DemoBadge(text: 'DEMO'),
                        IconButton(tooltip: 'Directions', onPressed: () => setState(() => _planning = true), icon: const Icon(Icons.directions, color: Color(0xFF1A73E8))),
                        IconButton(tooltip: 'Location source', onPressed: _locationMenu, icon: Icon(s.location.demoMode ? Icons.edit_location_alt : Icons.gps_fixed)),
                      ]),
                    ),
                  ),
                if (_picking != null) ...[
                  const SizedBox(height: 8),
                  Material(
                    color: const Color(0xFF1A73E8),
                    borderRadius: BorderRadius.circular(12),
                    child: ListTile(
                      leading: const Icon(Icons.touch_app, color: Colors.white),
                      title: Text(_picking == 'from' ? 'Tap the map where you start' : 'Tap the map where you are going',
                          style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
                      trailing: TextButton(
                        onPressed: () => setState(() => _picking = null),
                        child: const Text('Cancel', style: TextStyle(color: Colors.white)),
                      ),
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                if (approaching != null) _MakeWayBanner(vehicle: approaching),
                if (sos != null && !navigating) ...[
                  const SizedBox(height: 8),
                  _SosBanner(sos: sos, onTap: () => openSosTracking(context, s, sos['id'] as String)),
                ],
                if (simMode && !navigating)
                  const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: Card(child: ListTile(dense: true, leading: Icon(Icons.science_outlined), title: Text('Command is running a traffic simulation - live traffic is paused.'))),
                  ),
                if (f != null && !f.demo && ProjectMap.instance.ready && !ProjectMap.instance.covers(f.latLng)) ...[
                  const SizedBox(height: 8),
                  OutOfCoverageNotice(onShowMap: () {
                    setState(() => _follow = false);
                    _map.move(ProjectMap.instance.centre, 15);
                  }),
                ],
                const SizedBox(height: 8),
                LocationNotice(location: s.location, onUseDemo: () => s.location.setDemoMode(true, at: _center())),
                if (s.location.demoMode && f == null)
                  const Card(child: Padding(padding: EdgeInsets.all(12), child: Text('Demo location: long-press the map to place yourself.'))),
              ]),
            ),
          ),
          if (navigating)
            Positioned(left: 12, right: 12, bottom: 12, child: SafeArea(child: NavBottomBar(nav: nav, onEnd: _endNav, title: _dest?['name'] as String?)))
          else if (_route != null)
            Positioned(left: 12, right: 12, bottom: 144, child: _previewCard()),
          if (!navigating && _route == null)
            Positioned(
              left: 16,
              bottom: 16,
              child: FloatingActionButton.extended(
                heroTag: 'report',
                onPressed: () => showReportSheet(context, s),
                icon: const Icon(Icons.report_outlined),
                label: const Text('Report'),
              ),
            ),
          Positioned(
            right: 16,
            bottom: navigating ? 110 : 88,
            child: FloatingActionButton.small(
              heroTag: 'me',
              onPressed: _recenter,
              child: Icon(_follow ? Icons.my_location : Icons.location_searching),
            ),
          ),
          if (!navigating) Positioned(right: 16, bottom: 16, child: SosButton(onPressed: () => startSos(context, s))),
          if (navigating) Positioned(right: 16, bottom: 162, child: SizedBox(width: 48, height: 48, child: SosButton(onPressed: () => startSos(context, s)))),
        ]);
      },
    );
  }

  /// Google-Maps-style From / To: either end can be your location, a place
  /// found by search, or a point picked on the map.
  Widget _plannerCard() {
    Widget field(String role, Map<String, dynamic>? spot) {
      final me = _isMe(spot);
      final empty = spot == null;
      return InkWell(
        onTap: () => _choose(role),
        borderRadius: BorderRadius.circular(8),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          decoration: BoxDecoration(color: const Color(0xFFF1F3F4), borderRadius: BorderRadius.circular(8)),
          child: Row(children: [
            Icon(role == 'from' ? (me ? Icons.my_location : Icons.trip_origin) : Icons.location_on,
                size: 18, color: role == 'from' ? const Color(0xFF1A73E8) : const Color(0xFFC62828)),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                empty ? (role == 'from' ? 'Choose starting point' : 'Choose destination') : '${spot['name']}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: empty ? Colors.black45 : (me ? const Color(0xFF1A73E8) : Colors.black87), fontWeight: me ? FontWeight.w600 : null),
              ),
            ),
          ]),
        ),
      );
    }

    return Card(
      elevation: 4,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 8, 4, 8),
        child: Row(children: [
          IconButton(tooltip: 'Close', onPressed: _closePlanner, icon: const Icon(Icons.arrow_back)),
          Expanded(
            child: Column(children: [
              field('from', _from),
              const SizedBox(height: 6),
              field('to', _dest),
            ]),
          ),
          IconButton(tooltip: 'Swap start and destination', onPressed: _dest == null ? null : _swap, icon: const Icon(Icons.swap_vert)),
        ]),
      ),
    );
  }

  Widget _previewCard() {
    final r = _route!;
    final warnings = (r['warnings'] as List?) ?? const [];
    final steps = ((r['steps'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final fromMe = _isMe(_from);
    return Card(
      elevation: 6,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${fmtDuration(r['durationSec'] as num?)}  (${fmtDistance(r['distanceM'] as num?)})',
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Color(0xFF0B6E4F))),
                Text('${fromMe ? '' : 'from ${_from['name']} '}to ${_dest?['name'] ?? 'destination'} · '
                    '${steps.length > 2 ? '${steps.length - 2} turns' : 'straight there'}', maxLines: 2, overflow: TextOverflow.ellipsis),
              ]),
            ),
            IconButton(onPressed: _closePlanner, icon: const Icon(Icons.close)),
          ]),
          if (warnings.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final w in warnings)
              Row(children: [
                const Icon(Icons.warning_amber, size: 18, color: FearColors.warn),
                const SizedBox(width: 6),
                Expanded(child: Text('${(w as Map)['title']}${w['body'] != null ? ' - ${w['body']}' : ''}', style: const TextStyle(fontSize: 13))),
              ]),
          ],
          if (_showSteps)
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 220),
              child: ListView(shrinkWrap: true, children: [
                for (final st in steps)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(maneuverIcon(st['type'] as String?, st['modifier'] as String?), color: const Color(0xFF1A73E8)),
                    title: Text('${st['instruction']}'),
                    trailing: (st['distanceM'] as num? ?? 0) > 0 ? Text(fmtDistance(st['distanceM'] as num)) : null,
                  ),
              ]),
            ),
          const SizedBox(height: 10),
          Row(children: [
            if (fromMe)
              Expanded(
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(backgroundColor: const Color(0xFF1A73E8), padding: const EdgeInsets.symmetric(vertical: 12)),
                  onPressed: _startNav,
                  icon: const Icon(Icons.navigation),
                  label: const Text('Start'),
                ),
              )
            else
              Expanded(
                child: FilledButton.tonalIcon(
                  onPressed: () => _set('from', _myLocation),
                  icon: const Icon(Icons.my_location),
                  label: const Text('From my location'),
                ),
              ),
            const SizedBox(width: 8),
            OutlinedButton.icon(
              onPressed: () => setState(() => _showSteps = !_showSteps),
              icon: Icon(_showSteps ? Icons.expand_more : Icons.list),
              label: Text(_showSteps ? 'Hide' : 'Steps'),
            ),
            if (s.location.demoMode && fromMe) ...[
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: () {
                  s.location.followRoute(toLatLngs(r['points'] as List), speedKmh: 30);
                  _startNav();
                },
                child: const Text('Demo drive'),
              ),
            ],
          ]),
        ]),
      ),
    );
  }
}

class _MakeWayBanner extends StatelessWidget {
  const _MakeWayBanner({required this.vehicle});

  final Map<String, dynamic> vehicle;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: FearColors.category(vehicle['category'] as String),
      borderRadius: BorderRadius.circular(12),
      elevation: 6,
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(children: [
          Icon(FearIcons.category(vehicle['category'] as String), color: Colors.white, size: 32),
          const SizedBox(width: 12),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${vehicle['categoryLabel']} approaching · ${fmtDistance(vehicle['distanceM'] as num?)}',
                  style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w800, fontSize: 16)),
              const Text('Keep left and make way. Do not block the junction.', style: TextStyle(color: Colors.white)),
            ]),
          ),
        ]),
      ),
    );
  }
}

class _SosBanner extends StatelessWidget {
  const _SosBanner({required this.sos, required this.onTap});

  final Map<String, dynamic> sos;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final units = (sos['units'] as List).where((u) => ['en_route', 'assigned', 'on_scene', 'transporting'].contains((u as Map)['status'])).toList();
    final etas = units.map((u) => (u as Map)['etaSec']).whereType<num>().toList()..sort();
    final text = units.isEmpty
        ? 'SOS received - finding the nearest help'
        : etas.isNotEmpty
            ? 'Help on the way · ${fmtDuration(etas.first)}'
            : 'Help on the way';
    return Material(
      color: FearColors.brand,
      borderRadius: BorderRadius.circular(12),
      child: ListTile(
        onTap: onTap,
        leading: const Icon(Icons.sos, color: Colors.white),
        title: Text(text, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w700)),
        subtitle: Text('${sos['kindLabel']} · tap to track', style: const TextStyle(color: Colors.white70)),
        trailing: const Icon(Icons.chevron_right, color: Colors.white),
      ),
    );
  }
}

/// Choosing one end of a route (or just a place to look at): autocomplete
/// ranked by distance from [near] - the person, or where the map is looking -
/// and, before anything is typed, the roads and places right around there.
class _SearchSheet extends StatefulWidget {
  const _SearchSheet({required this.state, required this.role, required this.near});

  final PublicState state;
  final String role; // 'from' or 'to'
  final LatLng near;

  @override
  State<_SearchSheet> createState() => _SearchSheetState();
}

class _SearchSheetState extends State<_SearchSheet> {
  final _text = TextEditingController();
  List<Map<String, dynamic>> _results = [];
  Timer? _debounce;
  bool _loading = false;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _query('');
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _text.dispose();
    super.dispose();
  }

  void _onChanged(String q) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 200), () => _query(q));
  }

  Future<void> _query(String q) async {
    final seq = ++_seq;
    setState(() => _loading = true);
    try {
      final r = await widget.state.api.get('/public/places', query: {'q': q, 'lat': widget.near.latitude, 'lon': widget.near.longitude});
      if (mounted && seq == _seq) setState(() => _results = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList());
    } catch (_) {
    } finally {
      if (mounted && seq == _seq) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final typed = _text.text.trim().isNotEmpty;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.8,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              controller: _text,
              autofocus: true,
              onChanged: _onChanged,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                prefixIcon: Icon(widget.role == 'from' ? Icons.trip_origin : Icons.search),
                hintText: widget.role == 'from' ? 'Starting point: road, place, area...' : 'Where to? Road, hospital, market...',
                suffixIcon: typed
                    ? IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _text.clear();
                          _query('');
                        })
                    : null,
              ),
            ),
          ),
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          Expanded(
            child: ListView(children: [
              if (!typed) ...[
                if (widget.role == 'from')
                  ListTile(
                    leading: const Icon(Icons.my_location, color: Color(0xFF1A73E8)),
                    title: const Text('Your location'),
                    onTap: () => Navigator.pop(context, {'me': true, 'name': 'Your location'}),
                  ),
                ListTile(
                  leading: const Icon(Icons.pin_drop_outlined),
                  title: const Text('Choose on map'),
                  onTap: () => Navigator.pop(context, {'pick': true}),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Wrap(spacing: 8, children: [
                    for (final q in const ['Hospital', 'Police', 'Fuel', 'Bank', 'School'])
                      ActionChip(
                          label: Text(q),
                          onPressed: () {
                            _text.text = q;
                            _query(q);
                          }),
                  ]),
                ),
                if (_results.isNotEmpty)
                  const Padding(
                    padding: EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Text('Nearby', style: TextStyle(fontWeight: FontWeight.w700, color: Colors.black54)),
                  ),
              ],
              for (final p in _results)
                ListTile(
                  leading: Icon(switch (p['kind']) {
                    'hospital' || 'clinic' || 'doctors' => Icons.local_hospital,
                    'police' => Icons.local_police,
                    'fire_station' => Icons.fire_truck,
                    'fuel' => Icons.local_gas_station,
                    'bank' || 'atm' => Icons.account_balance,
                    'area' => Icons.location_city,
                    'road' => Icons.add_road,
                    'school' || 'college' => Icons.school,
                    'restaurant' || 'fast_food' || 'food_court' || 'cafe' => Icons.restaurant,
                    _ => Icons.place,
                  }),
                  title: _Highlighted(text: '${p['name']}', query: _text.text),
                  subtitle: Text('${p['kindLabel']}${p['distanceM'] != null ? ' · ${fmtDistance(p['distanceM'] as num)}' : ''}'),
                  onTap: () => Navigator.pop(context, p),
                ),
              if (typed && !_loading && _results.isEmpty)
                const Padding(padding: EdgeInsets.all(24), child: Text('Nothing found here. Try another name, or choose on the map.', textAlign: TextAlign.center)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// [text] with the typed words in bold, like any maps autocomplete.
class _Highlighted extends StatelessWidget {
  const _Highlighted({required this.text, required this.query});

  final String text;
  final String query;

  @override
  Widget build(BuildContext context) {
    final words = query.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return Text(text);
    final lower = text.toLowerCase();
    final bold = List<bool>.filled(text.length, false);
    for (final w in words) {
      var i = lower.indexOf(w);
      while (i >= 0) {
        for (var j = i; j < i + w.length; j++) {
          bold[j] = true;
        }
        i = lower.indexOf(w, i + w.length);
      }
    }
    final spans = <TextSpan>[];
    var start = 0;
    for (var i = 1; i <= text.length; i++) {
      if (i == text.length || bold[i] != bold[start]) {
        spans.add(TextSpan(text: text.substring(start, i), style: bold[start] ? const TextStyle(fontWeight: FontWeight.w800) : null));
        start = i;
      }
    }
    return Text.rich(TextSpan(style: DefaultTextStyle.of(context).style, children: spans));
  }
}

Future<void> showReportSheet(BuildContext context, PublicState s, {LatLng? at}) async {
  final kinds = Map<String, dynamic>.from(s.meta['reportKinds'] as Map? ?? {'accident': 'Road accident', 'hazard': 'Road hazard', 'road_blocked': 'Blocked road', 'congestion': 'Congestion'});
  final point = at ?? s.location.fix?.latLng;
  if (point == null) {
    showSnack(context, 'Waiting for your location - or long-press the map where the problem is.', error: true);
    return;
  }
  // Talk to the AI responder, or fill the form below.
  final mode = await askReportMode(context, sos: false);
  if (mode == null || !context.mounted) return;
  if (mode == 'voice') {
    final r = await openResponder(context, s, purpose: 'report', at: point, demo: s.location.fix?.demo ?? false);
    if (r != 'form' || !context.mounted) return;
  }
  String? kind;
  final note = TextEditingController();
  VoiceResult? voice;
  final ok = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.viewInsetsOf(ctx).bottom + 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Report a problem', style: Theme.of(ctx).textTheme.titleLarge),
          Text(at == null ? 'At your current location' : 'At the point you picked', style: Theme.of(ctx).textTheme.bodySmall),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in kinds.entries)
              ChoiceChip(
                avatar: Icon(FearIcons.incident(e.key), size: 18),
                label: Text('${e.value}'),
                selected: kind == e.key,
                onSelected: (_) => set(() => kind = e.key),
              ),
          ]),
          const SizedBox(height: 12),
          TextField(controller: note, maxLines: 3, minLines: 2, decoration: const InputDecoration(labelText: 'What\'s happening? (optional)')),
          const SizedBox(height: 8),
          Row(children: [
            OutlinedButton.icon(
              onPressed: () async {
                final v = await describeByVoice(ctx, s, kind: kind ?? 'accident');
                if (v == null) return;
                set(() {
                  voice = v;
                  note.text = v.text;
                  final k = v.kindSuggestion;
                  if (k != null && kinds.containsKey(k)) kind = k;
                });
              },
              icon: const Icon(Icons.mic),
              label: Text(voice == null ? 'Speak instead' : 'Speak again'),
            ),
            const SizedBox(width: 10),
            if (voice?.triage['severity'] != null) SeverityChip(score: voice!.triage['severity'] as int?),
          ]),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: FilledButton(onPressed: kind == null ? null : () => Navigator.pop(ctx, true), child: const Text('Send report')),
          ),
          const SizedBox(height: 4),
          Text('Command verifies reports before warning other drivers. For an emergency use SOS.', style: Theme.of(ctx).textTheme.bodySmall),
        ]),
      ),
    ),
  );
  if (ok != true || kind == null || !context.mounted) return;
  await guarded(context, () => s.api.post('/public/reports', {
        'kind': kind,
        'lat': point.latitude,
        'lon': point.longitude,
        'note': note.text.trim().isEmpty ? null : note.text.trim(),
        'demo': s.location.fix?.demo ?? false,
        if (voice != null) 'voice': voice!.voiceMeta,
      }), success: 'Thanks - your report reached Command.');
  await s.refreshLists();
}
