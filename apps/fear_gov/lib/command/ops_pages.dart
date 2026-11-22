import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'command_state.dart';
import 'phone_qr.dart';
import 'incident_panel.dart';
import 'live_map_page.dart';

class IncidentsPage extends StatefulWidget {
  const IncidentsPage({super.key, required this.state});

  final CommandState state;

  @override
  State<IncidentsPage> createState() => _IncidentsPageState();
}

class _IncidentsPageState extends State<IncidentsPage> {
  String _filter = 'open';
  List<Map<String, dynamic>>? _history;

  Future<void> _loadHistory() async {
    final r = await guarded(context, () => widget.state.api.get('/gov/incidents', query: {'status': 'closed'}));
    if (r != null && mounted) setState(() => _history = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList());
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.state;
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final list = _filter == 'open' ? s.incidents : (_history ?? const <Map<String, dynamic>>[]);
        final wide = MediaQuery.sizeOf(context).width >= 1100;
        final listView = Column(children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'open', label: Text('Open'), icon: Icon(Icons.crisis_alert)),
                ButtonSegment(value: 'closed', label: Text('Closed'), icon: Icon(Icons.history)),
              ],
              selected: {_filter},
              onSelectionChanged: (v) {
                setState(() => _filter = v.first);
                if (_filter == 'closed') _loadHistory();
              },
            ),
          ),
          Expanded(
            child: list.isEmpty
                ? Center(child: Text(_filter == 'open' ? 'No open incidents.' : 'No closed incidents yet.'))
                : ListView.separated(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    itemCount: list.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 6),
                    itemBuilder: (_, i) => IncidentTile(state: s, incident: list[i], onTap: () => s.selectIncident(list[i]['id'] as String)),
                  ),
          ),
        ]);
        final selected = s.selectedIncidentId;
        if (wide) {
          return Row(children: [
            SizedBox(width: 460, child: listView),
            const VerticalDivider(width: 1),
            Expanded(
              child: selected == null
                  ? const Center(child: Text('Select an incident'))
                  : IncidentPanel(state: s, incidentId: selected),
            ),
          ]);
        }
        if (selected != null) return IncidentPanel(state: s, incidentId: selected, onClose: () => s.selectIncident(null));
        return listView;
      },
    );
  }
}

class UnitsPage extends StatefulWidget {
  const UnitsPage({super.key, required this.state});

  final CommandState state;

  @override
  State<UnitsPage> createState() => _UnitsPageState();
}

class _UnitsPageState extends State<UnitsPage> {
  String _category = 'all';

  @override
  Widget build(BuildContext context) {
    final s = widget.state;
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final cats = {for (final u in s.units) u['category'] as String}.toList()..sort();
        // Units an admin may remove: FEAR's admin any; an org admin sees only
        // their own organization and those below it, all removable.
        final canRemove = s.role == 'super_admin' || s.role == 'org_admin';
        final units = s.units.where((u) => _category == 'all' || u['category'] == _category).toList()
          ..sort((a, b) => '${a['category']}${a['vehicleId']}'.compareTo('${b['category']}${b['vehicleId']}'));
        return ListView(padding: const EdgeInsets.all(16), children: [
          Wrap(spacing: 8, children: [
            ChoiceChip(label: const Text('All'), selected: _category == 'all', onSelected: (_) => setState(() => _category = 'all')),
            for (final c in cats)
              ChoiceChip(
                avatar: Icon(FearIcons.category(c), size: 16, color: FearColors.category(c)),
                label: Text(s.label('vehicleCategories', c)),
                selected: _category == c,
                onSelected: (_) => setState(() => _category = c),
              ),
          ]),
          const SizedBox(height: 12),
          if (units.isEmpty) const Text('No vehicles visible to your account.'),
          Card(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: DataTable(columns: [
                DataColumn(label: Text('Vehicle')),
                DataColumn(label: Text('Category')),
                DataColumn(label: Text('Plate')),
                DataColumn(label: Text('Organization')),
                DataColumn(label: Text('Status')),
                DataColumn(label: Text('Priority')),
                DataColumn(label: Text('Speed')),
                DataColumn(label: Text('Last fix')),
                if (canRemove) DataColumn(label: Text('Remove')),
              ], rows: [
                for (final u in units)
                  DataRow(cells: [
                    DataCell(Row(children: [
                      Text('${u['vehicleId']}'),
                      if (u['demo'] == true) ...[const SizedBox(width: 6), const DemoBadge(text: 'DEMO')],
                    ])),
                    DataCell(Row(children: [
                      Icon(FearIcons.category(u['category'] as String), size: 16, color: FearColors.category(u['category'] as String)),
                      const SizedBox(width: 6),
                      Text(s.label('vehicleCategories', u['category'] as String)),
                    ])),
                    DataCell(Text('${u['plate']}')),
                    DataCell(Text(s.orgNames[u['orgId']] ?? '')),
                    DataCell(StatusPill(u['status'] as String?, dense: true)),
                    DataCell(u['emergency'] == true ? const Icon(Icons.traffic, color: Color(0xFF69F0AE), size: 18) : const Text('-')),
                    DataCell(Text(u['speedKmh'] == null ? '-' : '${(u['speedKmh'] as num).round()} km/h')),
                    DataCell(Text(u['updatedAt'] == null ? 'never' : fmtAgo(u['updatedAt'] as String?))),
                    if (canRemove)
                      DataCell(IconButton(
                        tooltip: 'Remove this vehicle',
                        icon: Icon(Icons.delete_forever, color: Theme.of(context).colorScheme.error),
                        onPressed: () async {
                          if (!await confirmRemove(context, '${u['vehicleId']} · ${u['plate']}')) return;
                          if (!context.mounted) return;
                          await guarded(context, () => s.api.delete('/gov/vehicles/${u['vehicleId']}'), success: 'Vehicle removed');
                        },
                      )),
                  ]),
              ]),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            s.isCommand
                ? 'Command sees vehicle identities only. Commercial fleets are never tracked individually here.'
                : 'Your organization\'s vehicles.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ]);
      },
    );
  }
}

class SignalsPage extends StatelessWidget {
  const SignalsPage({super.key, required this.state});

  final CommandState state;

  @override
  Widget build(BuildContext context) {
    final s = state;
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final e = s.engine;
        final connected = e['connected'] == true;
        final canControl = s.can('controlSignals');
        final preempted = (e['preempted'] as List?) ?? const [];
        final emergencyUnits = s.units.where((u) => u['emergency'] == true).toList();
        return ListView(padding: const EdgeInsets.all(16), children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(Icons.memory, color: connected ? FearColors.ok : Colors.grey),
                  const SizedBox(width: 8),
                  Text('Traffic engine', style: Theme.of(context).textTheme.titleMedium),
                  const Spacer(),
                  StatusPill(connected ? 'available' : 'off_duty', label: connected ? 'Connected' : 'Offline'),
                ]),
                const SizedBox(height: 8),
                KeyValue('Vehicle source', e['simMode'] == null ? '-' : (e['simMode'] == 'realistic' ? 'Realistic - real GPS vehicles only' : 'Simulation - synthetic traffic')),
                KeyValue('Signal control', switch (e['signalMode']) {
                  'emergency' => 'Fixed-time, emergency preemption',
                  'density' => 'Adaptive (queue density) + emergency preemption',
                  'default' => 'Fixed-time only (no preemption)',
                  _ => '-',
                }),
                KeyValue('Live GPS vehicles', '${e['liveVehicles'] ?? 0}'),
                const SizedBox(height: 12),
                if (!connected)
                  FilledButton.icon(
                    onPressed: () => guarded(context, () => s.api.post('/gov/engine/start'), success: 'Starting the traffic engine in realistic mode...'),
                    icon: const Icon(Icons.play_arrow),
                    label: const Text('Start in realistic mode'),
                  ),
                if (connected && canControl) ...[
                  Text('Signal control', style: Theme.of(context).textTheme.labelLarge),
                  const SizedBox(height: 6),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'emergency', label: Text('Emergency priority')),
                      ButtonSegment(value: 'density', label: Text('Adaptive')),
                      ButtonSegment(value: 'default', label: Text('Fixed-time')),
                    ],
                    selected: {e['signalMode'] as String? ?? 'emergency'},
                    onSelectionChanged: (v) => guarded(context, () => s.api.post('/gov/engine/signal-mode', {'mode': v.first})),
                  ),
                  if (e['signalMode'] == 'default')
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text('Fixed-time mode ignores emergency vehicles - corridors won\'t open.', style: TextStyle(color: Theme.of(context).colorScheme.error)),
                    ),
                  const SizedBox(height: 12),
                  Text('Vehicle source', style: Theme.of(context).textTheme.labelLarge),
                  const SizedBox(height: 6),
                  SegmentedButton<String>(
                    segments: const [
                      ButtonSegment(value: 'realistic', label: Text('Realistic (GPS)')),
                      ButtonSegment(value: 'simulation', label: Text('Simulation')),
                    ],
                    selected: {e['simMode'] as String? ?? 'realistic'},
                    onSelectionChanged: (v) => guarded(context, () => s.api.post('/gov/engine/sim-mode', {'mode': v.first})),
                  ),
                ],
                if (connected && !canControl)
                  Text('Signal control belongs to City Traffic Command.', style: Theme.of(context).textTheme.bodySmall),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          Text('Emergency corridors', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          if (emergencyUnits.isEmpty) const Text('No vehicle holds signal priority right now.'),
          for (final u in emergencyUnits)
            ListTile(
              leading: Icon(FearIcons.category(u['category'] as String), color: FearColors.category(u['category'] as String)),
              title: Text('${u['vehicleId']}'),
              subtitle: Text('${statusLabel(u['status'] as String?)} · ${u['speedKmh'] == null ? '-' : '${(u['speedKmh'] as num).round()} km/h'}'
                  '${u['etaSec'] != null ? ' · ETA ${fmtDuration(u['etaSec'] as num)}' : ''}'),
            ),
          const SizedBox(height: 12),
          Text('Junctions held green now: ${preempted.length}', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Text(
            'FEAR requests priority; the junction controller keeps its safety rules - a clearing yellow before the hold, '
            'conflicting movements kept red, and the hold released a few seconds after the vehicle passes.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ]);
      },
    );
  }
}

class AnalyticsPage extends StatefulWidget {
  const AnalyticsPage({super.key, required this.state});

  final CommandState state;

  @override
  State<AnalyticsPage> createState() => _AnalyticsPageState();
}

class _AnalyticsPageState extends State<AnalyticsPage> {
  int _days = 7;
  Map<String, dynamic>? _d;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await guarded(context, () => widget.state.api.get('/gov/analytics', query: {'days': _days}));
    if (r != null && mounted) setState(() => _d = Map<String, dynamic>.from(r as Map));
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    final s = widget.state;
    if (d == null) return const Center(child: CircularProgressIndicator());
    final inc = Map<String, dynamic>.from(d['incidents'] as Map);
    final byKind = Map<String, dynamic>.from(inc['byKind'] as Map);
    final bySource = Map<String, dynamic>.from(inc['bySource'] as Map);
    final response = Map<String, dynamic>.from(d['response'] as Map);
    final fleet = Map<String, dynamic>.from(d['fleet'] as Map);
    Widget stat(String label, String value, IconData icon) => SizedBox(
          width: 200,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Icon(icon),
                const SizedBox(height: 8),
                Text(value, style: Theme.of(context).textTheme.headlineSmall),
                Text(label, style: Theme.of(context).textTheme.bodySmall),
              ]),
            ),
          ),
        );
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          Text('Last', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(width: 8),
          DropdownButton<int>(
            value: _days,
            items: const [
              DropdownMenuItem(value: 1, child: Text('24 hours')),
              DropdownMenuItem(value: 7, child: Text('7 days')),
              DropdownMenuItem(value: 30, child: Text('30 days')),
            ],
            onChanged: (v) {
              setState(() => _days = v!);
              _load();
            },
          ),
          const Spacer(),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ]),
        const SizedBox(height: 8),
        Wrap(spacing: 12, runSpacing: 12, children: [
          stat('Incidents', '${inc['total']}', Icons.crisis_alert),
          stat('SOS calls', '${bySource['sos'] ?? 0}', Icons.sos),
          stat('Public reports', '${bySource['report'] ?? 0}', Icons.campaign),
          stat('Junctions held green now', '${(d['engine'] as Map)['preemptedJunctions']}', Icons.traffic),
        ]),
        const SizedBox(height: 20),
        Text('Incidents by kind', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (byKind.isEmpty) const Text('None in this period.'),
        for (final e in byKind.entries) _bar(context, s.label('incidentKinds', e.key), (e.value as num).toInt(), inc['total'] as int, FearColors.incident(e.key)),
        const SizedBox(height: 20),
        Text('Response times', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        if (response.isEmpty) const Text('No dispatches in this period.'),
        for (final e in response.entries)
          ListTile(
            leading: Icon(FearIcons.category(e.key), color: FearColors.category(e.key)),
            title: Text(s.label('vehicleCategories', e.key)),
            subtitle: Text('${(e.value as Map)['dispatched']} dispatched · accept ${fmtDuration(e.value['avgAcceptSec'] as num?)} · '
                'reach scene ${fmtDuration(e.value['avgToSceneSec'] as num?)}'
                '${e.value['avgTransportSec'] != null ? ' · transport ${fmtDuration(e.value['avgTransportSec'] as num?)}' : ''}'),
          ),
        const SizedBox(height: 20),
        Text('Fleet (aggregated)', style: Theme.of(context).textTheme.titleMedium),
        for (final e in fleet.entries)
          ListTile(
            dense: true,
            leading: Icon(FearIcons.category(e.key), color: FearColors.category(e.key)),
            title: Text(s.label('vehicleCategories', e.key)),
            trailing: Text('${(e.value as Map)['onDuty']} on duty / ${e.value['registered']} · ${e.value['busy']} busy · ${e.value['emergency']} priority'),
          ),
      ]),
    );
  }

  Widget _bar(BuildContext context, String label, int n, int total, Color c) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(children: [
          SizedBox(width: 160, child: Text(label)),
          Expanded(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(value: total == 0 ? 0 : n / total, minHeight: 14, color: c, backgroundColor: c.withValues(alpha: 0.15)),
            ),
          ),
          SizedBox(width: 40, child: Text('  $n')),
        ]),
      );
}
