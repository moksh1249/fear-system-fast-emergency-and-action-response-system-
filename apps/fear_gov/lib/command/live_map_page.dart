import 'dart:math' as math;

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'alerts_page.dart';
import 'command_state.dart';
import 'incident_panel.dart';

/// Live operational map: authorized vehicles (by vehicle identity only),
/// open incidents, emergency corridors, signals held green, public alerts.
class LiveMapPage extends StatefulWidget {
  const LiveMapPage({super.key, required this.state});

  final CommandState state;

  @override
  State<LiveMapPage> createState() => _LiveMapPageState();
}

class _LiveMapPageState extends State<LiveMapPage> {
  final _map = MapController();
  bool _showOffDuty = true;
  bool _showTraffic = true;
  bool? _keyOpen; // the map key; collapsed by default on narrow screens

  CommandState get s => widget.state;

  void _focus(LatLng p, {double? zoom}) {
    try {
      _map.move(p, zoom ?? (_map.camera.zoom < 15 ? 16 : _map.camera.zoom));
    } catch (_) {}
  }

  Future<void> _longPress(LatLng p) async {
    final kinds = List<String>.from(s.perms['incidentKinds'] as List);
    final canIncident = s.isCommand && kinds.isNotEmpty;
    final canAlert = s.can('manageAlerts');
    if (!canIncident && !canAlert) return;
    final choice = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(title: Text('${p.latitude.toStringAsFixed(5)}, ${p.longitude.toStringAsFixed(5)}')),
          if (canIncident) ListTile(leading: const Icon(Icons.add_alert), title: const Text('Create incident here'), onTap: () => Navigator.pop(ctx, 'incident')),
          if (canAlert) ListTile(leading: const Icon(Icons.campaign), title: const Text('Publish public alert here'), onTap: () => Navigator.pop(ctx, 'alert')),
        ]),
      ),
    );
    if (!mounted) return;
    if (choice == 'incident') {
      final id = await createIncidentDialog(context, s, p);
      if (id != null) s.selectIncident(id);
    } else if (choice == 'alert') {
      await createAlertDialog(context, s, p);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final wide = MediaQuery.sizeOf(context).width >= 1100;
        final map = _mapView();
        final panel = _panel();
        if (wide) {
          return Row(children: [
            Expanded(child: map),
            const VerticalDivider(width: 1),
            SizedBox(width: 420, child: panel),
          ]);
        }
        return Column(children: [
          Expanded(flex: 5, child: map),
          const Divider(height: 1),
          Expanded(flex: 4, child: panel),
        ]);
      },
    );
  }

  Widget _mapView() {
    final units = s.units.where((u) => u['lat'] != null && (_showOffDuty || u['onDuty'] == true)).toList();
    final preempted = ((s.engine['preempted'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final openIncidents = s.incidents.where((i) => ['reported', 'open', 'dispatched', 'on_scene'].contains(i['status'])).toList();
    return Stack(children: [
      FearMap(
        controller: _map,
        zoomButtons: true,
        minZoom: 10,
        controlsPadding: const EdgeInsets.fromLTRB(0, 64, 12, 0),
        onLongPress: _longPress,
        onTap: (_) {
          s.selectIncident(null);
          s.selectVehicle(null);
        },
        children: [
          CircleLayer(circles: [
            for (final a in s.alerts)
              CircleMarker(
                point: latLngOf(a)!,
                radius: (a['radiusM'] as num).toDouble(),
                useRadiusInMeter: true,
                color: FearColors.warn.withValues(alpha: 0.15),
                borderColor: FearColors.warn,
                borderStrokeWidth: 2,
              ),
          ]),
          if (_showTraffic && s.traffic != null) _TrafficLayer(vehicles: (s.traffic!['vehicles'] as List?) ?? const []),
          PolylineLayer(polylines: [
            for (final c in s.corridors)
              if ((c['points'] as List?)?.isNotEmpty == true) ...emergencyRoutePolylines(toLatLngs(c['points'] as List)),
          ]),
          // Markers shrink as the map zooms out, so many vehicles never hide the city.
          Builder(builder: (context) {
            final sz = vehicleMarkerSize(MapCamera.of(context).zoom);
            return MarkerLayer(markers: [
              for (final p in preempted)
                Marker(
                    point: latLngOf(p)!,
                    width: sz * 1.4,
                    height: sz * 1.4,
                    child: Tooltip(message: 'Held green for an emergency vehicle', child: FittedBox(child: const PreemptedSignalIcon()))),
              for (final i in openIncidents)
                Marker(
                  point: latLngOf(i)!,
                  width: sz * 1.7,
                  height: sz * 1.7,
                  child: GestureDetector(
                    onTap: () => s.selectIncident(i['id'] as String),
                    child: IncidentMarkerIcon(
                        kind: i['kind'] as String, size: sz + 4, selected: s.selectedIncidentId == i['id'], pending: i['status'] == 'reported'),
                  ),
                ),
              for (final u in units)
                Marker(
                  key: ValueKey('unit-${u['vehicleId']}'),
                  point: latLngOf(u)!,
                  width: sz * 1.9,
                  height: sz * 1.9,
                  child: GestureDetector(
                    onTap: () => s.selectVehicle(u['vehicleId'] as String),
                    child: Tooltip(
                      message: '${u['vehicleId']} · ${statusLabel(u['status'] as String?)}',
                      child: VehicleMarkerIcon(
                        size: sz,
                        category: u['category'] as String,
                        heading: (u['heading'] as num?)?.toDouble(),
                        emergency: u['emergency'] == true,
                        stale: u['stale'] == true || u['onDuty'] != true,
                        selected: s.selectedVehicleId == u['vehicleId'],
                        demo: u['demo'] == true,
                      ),
                    ),
                  ),
                ),
            ]);
          }),
        ],
      ),
      Positioned(
        left: 12,
        top: 12,
        child: _Legend(
          open: _keyOpen ?? MediaQuery.sizeOf(context).width >= 900,
          onToggle: () => setState(() => _keyOpen = !(_keyOpen ?? MediaQuery.sizeOf(context).width >= 900)),
          state: s,
          preempted: preempted.length,
          showOffDuty: _showOffDuty,
          onToggleOffDuty: (v) => setState(() => _showOffDuty = v),
          showTraffic: _showTraffic,
          onToggleTraffic: (v) => setState(() => _showTraffic = v),
        ),
      ),
      Positioned(
        right: 12,
        top: 12,
        child: FloatingActionButton.small(
          heroTag: 'home',
          tooltip: 'Back to the city',
          onPressed: () => _focus(fearHome, zoom: 14),
          child: const Icon(Icons.center_focus_strong),
        ),
      ),
    ]);
  }

  Widget _panel() {
    if (s.selectedIncidentId != null) {
      return IncidentPanel(state: s, incidentId: s.selectedIncidentId!, onClose: () => s.selectIncident(null));
    }
    if (s.selectedVehicleId != null && s.unit(s.selectedVehicleId) != null) {
      return UnitPanel(state: s, unit: s.unit(s.selectedVehicleId)!, onFocus: _focus);
    }
    return _Overview(state: s, onFocus: _focus);
  }
}

/// The traffic picture: every vehicle the engine is moving, drawn as its
/// own shape and colour by type (car, bus, truck, two-wheeler, emergency) at
/// its real size and heading - so they shrink with the city when zoomed out
/// - with a speed-coloured edge (red crawling, amber slow, green flowing).
/// FEAR units keep their own markers. One pass - thousands stay cheap.
class _TrafficLayer extends StatelessWidget {
  const _TrafficLayer({required this.vehicles});

  final List vehicles;

  @override
  Widget build(BuildContext context) {
    final camera = MapCamera.of(context);
    return MobileLayerTransformer(
      child: CustomPaint(size: camera.size, painter: _TrafficPainter(vehicles, camera)),
    );
  }
}

class _TrafficPainter extends CustomPainter {
  _TrafficPainter(this.vehicles, this.camera);

  final List vehicles;
  final MapCamera camera;

  // class -> (length m, width m, min length px, colour)
  static const _shape = {
    'c': (4.5, 1.9, 6.0, Color(0xFF4361EE)),
    'b': (12.0, 2.6, 10.0, Color(0xFF2A9D8F)),
    't': (8.5, 2.5, 8.0, Color(0xFF8D6E63)),
    'm': (2.2, 0.9, 4.5, Color(0xFF9B5DE5)),
    'e': (6.0, 2.3, 8.0, Color(0xFFE63946)),
  };
  static final _speedEdge = [
    Paint()..color = const Color(0xFFD62828),
    Paint()..color = const Color(0xFFF77F00),
    Paint()..color = const Color(0xFF06A77D),
  ];

  @override
  void paint(Canvas canvas, Size size) {
    // px per metre at this zoom and latitude (Web Mercator)
    final lat = camera.center.latitude * math.pi / 180;
    final k = math.pow(2, camera.zoom) / (156543.03392 * math.cos(lat));
    final fills = {for (final e in _shape.entries) e.key: Paint()..color = e.value.$4};
    for (final v in vehicles) {
      final l = v as List;
      if (l.length > 5 && l[5] == 1) continue; // a FEAR unit - it has its own marker
      final p = camera.getOffsetFromOrigin(LatLng((l[0] as num).toDouble(), (l[1] as num).toDouble()));
      if (p.dx < -20 || p.dy < -20 || p.dx > size.width + 20 || p.dy > size.height + 20) continue;
      final cls = _shape.containsKey(l[4]) ? l[4] as String : 'c';
      final sh = _shape[cls]!;
      final len = math.max(sh.$3, sh.$1 * k);
      final wid = math.max(sh.$3 * sh.$2 / sh.$1 * 1.15, sh.$2 * k);
      final kmh = (l[3] as num).toDouble();
      canvas.save();
      canvas.translate(p.dx, p.dy);
      canvas.rotate((l[2] as num).toDouble() * math.pi / 180);
      final body = RRect.fromRectAndRadius(Rect.fromCenter(center: Offset.zero, width: wid, height: len), Radius.circular(wid * 0.3));
      canvas.drawRRect(body.inflate(math.max(0.8, wid * 0.12)), _speedEdge[kmh < 10 ? 0 : kmh < 25 ? 1 : 2]);
      canvas.drawRRect(body, fills[cls]!);
      if (len >= 12) {
        // windscreen at the front, so the heading reads at a glance
        canvas.drawRect(Rect.fromLTWH(-wid * 0.35, -len / 2 + len * 0.12, wid * 0.7, len * 0.14), Paint()..color = Colors.white70);
      }
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_TrafficPainter old) => true;
}

class _Legend extends StatelessWidget {
  const _Legend({
    required this.open,
    required this.onToggle,
    required this.state,
    required this.preempted,
    required this.showOffDuty,
    required this.onToggleOffDuty,
    required this.showTraffic,
    required this.onToggleTraffic,
  });

  final bool open;
  final VoidCallback onToggle;
  final CommandState state;
  final int preempted;
  final bool showOffDuty;
  final ValueChanged<bool> onToggleOffDuty;
  final bool showTraffic;
  final ValueChanged<bool> onToggleTraffic;

  @override
  Widget build(BuildContext context) {
    final units = state.units;
    final onDuty = units.where((u) => u['onDuty'] == true).length;
    final emergency = units.where((u) => u['emergency'] == true).length;
    final open = state.incidents.where((i) => ['reported', 'open', 'dispatched', 'on_scene'].contains(i['status'])).length;
    return Card(
      color: Theme.of(context).colorScheme.surface.withValues(alpha: 0.92),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          InkWell(
            onTap: onToggle,
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(this.open ? Icons.expand_less : Icons.expand_more, size: 18),
              const SizedBox(width: 4),
              Text(this.open ? 'Map key' : 'Map key · $open open · ${state.traffic?['count'] ?? 0} vehicles',
                  style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
            ]),
          ),
          if (this.open) ...[
          if (state.isCommand) _row(Icons.crisis_alert, '$open open incidents'),
          _row(Icons.local_shipping, '$onDuty of ${units.length} units on duty'),
          _row(Icons.emergency_share, '$emergency with signal priority'),
          _row(Icons.traffic, '$preempted junctions held green'),
          if (state.traffic != null) ...[
            _row(Icons.directions_car, _trafficText(state.traffic!)),
            Row(mainAxisSize: MainAxisSize.min, children: [
              Checkbox(value: showTraffic, onChanged: (v) => onToggleTraffic(v ?? true), visualDensity: VisualDensity.compact),
              const Text('Show traffic', style: TextStyle(fontSize: 12)),
            ]),
            Padding(
              padding: const EdgeInsets.only(left: 8, bottom: 2),
              child: Wrap(spacing: 8, runSpacing: 2, children: [
                for (final t in const [
                  ('Car', Color(0xFF4361EE)),
                  ('Bus', Color(0xFF2A9D8F)),
                  ('Truck', Color(0xFF8D6E63)),
                  ('2-wheeler', Color(0xFF9B5DE5)),
                  ('Emergency', Color(0xFFE63946)),
                ])
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(width: 7, height: 12, decoration: BoxDecoration(color: t.$2, borderRadius: BorderRadius.circular(2))),
                    const SizedBox(width: 3),
                    Text(t.$1, style: const TextStyle(fontSize: 11)),
                  ]),
              ]),
            ),
            const Padding(
              padding: EdgeInsets.only(left: 8, bottom: 2),
              child: Text('Edge: red crawling · amber slow · green flowing', style: TextStyle(fontSize: 11)),
            ),
            const Padding(
              padding: EdgeInsets.only(left: 8, bottom: 4),
              child: Text('Light timers: 12 s left · ≤12 at most (auto) · +12 waiting · ⚡ held', style: TextStyle(fontSize: 11)),
            ),
          ],
          Row(mainAxisSize: MainAxisSize.min, children: [
            Checkbox(value: showOffDuty, onChanged: (v) => onToggleOffDuty(v ?? true), visualDensity: VisualDensity.compact),
            const Text('Show off-duty', style: TextStyle(fontSize: 12)),
          ]),
          ],
        ]),
      ),
    );
  }

  static String _trafficText(Map<String, dynamic> t) {
    if (t['connected'] == false) return 'Traffic engine off - no vehicles';
    final n = t['count'] ?? 0;
    final avg = t['avgKmh'];
    final slow = t['slowShare'];
    return '$n vehicle${n == 1 ? '' : 's'} ${t['live'] == true ? 'sending GPS' : 'in the simulation'}'
        '${avg != null ? ' · avg ${avg.round()} km/h' : ''}${slow != null ? ' · ${((slow as num) * 100).round()}% slow' : ''}';
  }

  Widget _row(IconData i, String t) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(mainAxisSize: MainAxisSize.min, children: [Icon(i, size: 16), const SizedBox(width: 6), Text(t, style: const TextStyle(fontSize: 12))]),
      );
}

class _Overview extends StatelessWidget {
  const _Overview({required this.state, required this.onFocus});

  final CommandState state;
  final void Function(LatLng p, {double? zoom}) onFocus;

  @override
  Widget build(BuildContext context) {
    final s = state;
    final open = s.incidents.where((i) => ['reported', 'open', 'dispatched', 'on_scene'].contains(i['status'])).toList()
      ..sort((a, b) {
        int rank(Map i) => switch (i['status']) { 'open' => 0, 'reported' => 1, 'dispatched' => 2, _ => 3 };
        final r = rank(a).compareTo(rank(b));
        if (r != 0) return r;
        final sv = ((b['severityScore'] as int?) ?? 0).compareTo((a['severityScore'] as int?) ?? 0);
        return sv != 0 ? sv : (b['createdAt'] as String).compareTo(a['createdAt'] as String);
      });
    final busy = s.units.where((u) => u['task'] != null).toList();
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (s.isCommand && s.ai != null) ...[AiAgentCard(state: s), const SizedBox(height: 12)],
      if (s.isCommand) ...[
        Text('Open incidents', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        if (open.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('Nothing open. Long-press the map to log an incident.')),
        for (final i in open) IncidentTile(state: s, incident: i, onTap: () {
          s.selectIncident(i['id'] as String);
          onFocus(latLngOf(i)!);
        }),
        const Divider(height: 28),
      ],
      Text('Units on task', style: Theme.of(context).textTheme.titleMedium),
      if (busy.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('No unit is on a task.')),
      for (final u in busy)
        ListTile(
          dense: true,
          leading: Icon(FearIcons.category(u['category'] as String), color: FearColors.category(u['category'] as String)),
          title: Text('${u['vehicleId']}'),
          subtitle: Text('${statusLabel(u['status'] as String?)}${u['etaSec'] != null ? ' · ETA ${fmtDuration(u['etaSec'] as num)}' : ''}'),
          trailing: u['emergency'] == true ? const Icon(Icons.traffic, color: Color(0xFF69F0AE)) : null,
          onTap: () {
            s.selectVehicle(u['vehicleId'] as String);
            if (latLngOf(u) != null) onFocus(latLngOf(u)!);
          },
        ),
    ]);
  }
}

class IncidentTile extends StatelessWidget {
  const IncidentTile({super.key, required this.state, required this.incident, required this.onTap});

  final CommandState state;
  final Map<String, dynamic> incident;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final i = incident;
    final units = Map<String, dynamic>.from(i['units'] as Map? ?? {});
    final active = units.entries.where((e) => ['assigned', 'en_route', 'on_scene', 'transporting'].contains(e.key)).fold<int>(0, (a, e) => a + (e.value as num).toInt());
    return Card(
      child: ListTile(
        onTap: onTap,
        selected: state.selectedIncidentId == i['id'],
        leading: CircleAvatar(backgroundColor: FearColors.incident(i['kind'] as String), child: Icon(FearIcons.incident(i['kind'] as String), color: Colors.white, size: 20)),
        title: Row(children: [
          Flexible(child: Text('${i['kindLabel']}', overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 8),
          StatusPill(i['status'] as String?, dense: true),
          const SizedBox(width: 6),
          SeverityChip(score: i['severityScore'] as int?, dense: true),
          if (i['voice'] != null) const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.mic, size: 14)),
        ]),
        subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${i['place']}\n${titleCase(i['source'] as String)} · ${fmtAgo(i['createdAt'] as String?)}${active > 0 ? ' · $active unit(s) active' : ''}'),
          if (active == 0) AiLine(incident: i, mode: state.ai?['mode'] as String?),
        ]),
        isThreeLine: true,
        trailing: i['demo'] == true ? const DemoBadge(text: 'DEMO') : null,
      ),
    );
  }
}

/// A vehicle as Command sees it: vehicle identity, status and position.
/// The driver's identity is a separate, audited request.
class UnitPanel extends StatelessWidget {
  const UnitPanel({super.key, required this.state, required this.unit, required this.onFocus});

  final CommandState state;
  final Map<String, dynamic> unit;
  final void Function(LatLng p, {double? zoom}) onFocus;

  @override
  Widget build(BuildContext context) {
    final u = unit;
    final cat = u['category'] as String;
    final task = u['task'] as Map?;
    final canReveal = state.role == 'org_admin' || state.dispatchCategories.contains(cat);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [
        CircleAvatar(backgroundColor: FearColors.category(cat), child: Icon(FearIcons.category(cat), color: Colors.white)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${u['vehicleId']}', style: Theme.of(context).textTheme.titleLarge),
            Text(state.label('vehicleCategories', cat)),
          ]),
        ),
        IconButton(onPressed: () => state.selectVehicle(null), icon: const Icon(Icons.close)),
      ]),
      const SizedBox(height: 10),
      Wrap(spacing: 8, children: [
        StatusPill(u['status'] as String?),
        if (u['emergency'] == true) const StatusPill('en_route', label: 'Signal priority'),
        if (u['authorized'] != true && u['onDuty'] == true) const StatusPill('rejected', label: 'Not authorized for priority'),
        if (u['demo'] == true) const DemoBadge(text: 'DEMO GPS'),
      ]),
      const SizedBox(height: 12),
      KeyValue('Plate', u['plate'] as String?),
      KeyValue('Organization', state.orgNames[u['orgId']] ?? u['orgId'] as String?),
      KeyValue('Speed', u['speedKmh'] == null ? null : '${(u['speedKmh'] as num).round()} km/h'),
      KeyValue('Last fix', u['updatedAt'] == null ? 'never' : '${fmtAgo(u['updatedAt'] as String?)}${u['stale'] == true ? ' (signal lost)' : ''}'),
      if (task != null) ...[
        KeyValue('Task', '${statusLabel(task['status'] as String?)} - ${task['incidentId']}'),
        if (task['destKind'] == 'hospital') KeyValue('Heading to', task['destName'] as String?),
        if (u['etaSec'] != null) KeyValue('ETA', fmtDuration(u['etaSec'] as num)),
      ],
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        if (latLngOf(u) != null) OutlinedButton.icon(onPressed: () => onFocus(latLngOf(u)!), icon: const Icon(Icons.my_location), label: const Text('Show on map')),
        if (task != null && state.isCommand)
          OutlinedButton.icon(onPressed: () => state.selectIncident(task['incidentId'] as String), icon: const Icon(Icons.crisis_alert), label: const Text('Open incident')),
        if (canReveal)
          OutlinedButton.icon(
            onPressed: () async {
              final reason = await askReason(context, 'Driver identity',
                  'Command works with vehicle identities. Revealing who is driving is an exceptional, audited request visible to the vehicle\'s organization.');
              if (reason == null || !context.mounted) return;
              final d = await guarded(context, () => state.api.post('/gov/units/${u['vehicleId']}/driver', {'reason': reason}));
              if (d == null || !context.mounted) return;
              await showDialog(
                context: context,
                builder: (ctx) => AlertDialog(
                  title: const Text('Current driver'),
                  content: Column(mainAxisSize: MainAxisSize.min, children: [
                    KeyValue('Name', (d as Map)['fullName'] as String?),
                    KeyValue('Phone', d['phone'] as String?),
                    KeyValue('Licence', d['licenceNo'] as String?),
                  ]),
                  actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close'))],
                ),
              );
            },
            icon: const Icon(Icons.badge),
            label: const Text('Driver identity'),
          ),
      ]),
    ]);
  }
}

Future<String?> createIncidentDialog(BuildContext context, CommandState s, LatLng p) async {
  final kinds = List<String>.from(s.perms['incidentKinds'] as List);
  var kind = kinds.first;
  var severity = 'normal';
  final desc = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => AlertDialog(
        title: const Text('New incident'),
        content: SizedBox(
          width: 380,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            DropdownButtonFormField<String>(
              initialValue: kind,
              decoration: const InputDecoration(labelText: 'Kind'),
              items: [for (final k in kinds) DropdownMenuItem(value: k, child: Text(s.label('incidentKinds', k)))],
              onChanged: (v) => set(() => kind = v!),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: severity,
              decoration: const InputDecoration(labelText: 'Severity'),
              items: const [
                DropdownMenuItem(value: 'low', child: Text('Low')),
                DropdownMenuItem(value: 'normal', child: Text('Normal')),
                DropdownMenuItem(value: 'high', child: Text('High')),
                DropdownMenuItem(value: 'critical', child: Text('Critical')),
              ],
              onChanged: (v) => set(() => severity = v!),
            ),
            const SizedBox(height: 12),
            TextField(controller: desc, maxLines: 3, decoration: const InputDecoration(labelText: 'Details')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
        ],
      ),
    ),
  );
  if (ok != true || !context.mounted) return null;
  final r = await guarded(context, () => s.api.post('/gov/incidents', {
        'kind': kind,
        'lat': p.latitude,
        'lon': p.longitude,
        'severity': severity,
        'description': desc.text.trim().isEmpty ? null : desc.text.trim(),
      }));
  return r == null ? null : (r as Map)['id'] as String;
}
