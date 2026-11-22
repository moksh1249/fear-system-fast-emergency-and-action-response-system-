import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'command_state.dart';

/// Road closures, diversions and advisories pushed to public-app users
/// inside the alert's circle (and shown on their routes).
class AlertsPage extends StatelessWidget {
  const AlertsPage({super.key, required this.state});

  final CommandState state;

  @override
  Widget build(BuildContext context) {
    final s = state;
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) => ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          Expanded(child: Text('Active public alerts', style: Theme.of(context).textTheme.titleMedium)),
          FilledButton.icon(
            onPressed: () => createAlertDialog(context, s, fearHome, pickOnMap: true),
            icon: const Icon(Icons.add),
            label: const Text('New alert'),
          ),
        ]),
        const SizedBox(height: 4),
        Text('Tip: long-press the live map to publish an alert at an exact spot.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 12),
        if (s.alerts.isEmpty) const Text('No active alerts.'),
        for (final a in s.alerts)
          Card(
            child: ListTile(
              leading: Icon(switch (a['kind']) { 'closure' => Icons.block, 'diversion' => Icons.alt_route, 'incident' => Icons.crisis_alert, _ => Icons.info }, color: FearColors.warn),
              title: Text('${a['title']}'),
              subtitle: Text('${a['body'] ?? ''}\n${titleCase(a['kind'] as String)} · radius ${fmtDistance(a['radiusM'] as num)} · until ${fmtClock(a['expiresAt'] as String?)}'),
              isThreeLine: true,
              trailing: TextButton(
                onPressed: () async {
                  if (await confirm(context, 'End this alert?', 'Public-app users stop seeing it immediately.', ok: 'End alert')) {
                    if (!context.mounted) return;
                    await guarded(context, () => s.api.post('/gov/alerts/${a['id']}/end'));
                    await s.refresh();
                  }
                },
                child: const Text('End'),
              ),
            ),
          ),
      ]),
    );
  }
}

Future<void> createAlertDialog(BuildContext context, CommandState s, LatLng at, {bool pickOnMap = false}) async {
  var kind = 'closure';
  var radius = 400.0;
  var minutes = 120;
  var point = at;
  final title = TextEditingController();
  final body = TextEditingController();
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => AlertDialog(
        title: const Text('Publish public alert'),
        content: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'closure', label: Text('Closure')),
                  ButtonSegment(value: 'diversion', label: Text('Diversion')),
                  ButtonSegment(value: 'advisory', label: Text('Advisory')),
                ],
                selected: {kind},
                onSelectionChanged: (v) => set(() => kind = v.first),
              ),
              const SizedBox(height: 12),
              TextField(controller: title, decoration: const InputDecoration(labelText: 'Title', hintText: 'Road closed near Navyug Market')),
              const SizedBox(height: 12),
              TextField(controller: body, maxLines: 2, decoration: const InputDecoration(labelText: 'Details / suggested diversion')),
              const SizedBox(height: 12),
              if (pickOnMap)
                SizedBox(
                  height: 220,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(8),
                    child: FearMap(
                      initialCenter: point,
                      initialZoom: 14,
                      onTap: (p) => set(() => point = p),
                      children: [
                        CircleLayer(circles: [
                          CircleMarker(point: point, radius: radius, useRadiusInMeter: true, color: FearColors.warn.withValues(alpha: 0.2), borderColor: FearColors.warn, borderStrokeWidth: 2),
                        ]),
                      ],
                    ),
                  ),
                ),
              if (pickOnMap) const Padding(padding: EdgeInsets.only(top: 4), child: Text('Tap the map to place the alert', style: TextStyle(fontSize: 12))),
              Row(children: [
                const Text('Radius'),
                Expanded(child: Slider(value: radius, min: 100, max: 3000, divisions: 29, label: fmtDistance(radius), onChanged: (v) => set(() => radius = v))),
                Text(fmtDistance(radius)),
              ]),
              Row(children: [
                const Text('Active for'),
                const SizedBox(width: 12),
                DropdownButton<int>(
                  value: minutes,
                  items: const [
                    DropdownMenuItem(value: 30, child: Text('30 minutes')),
                    DropdownMenuItem(value: 120, child: Text('2 hours')),
                    DropdownMenuItem(value: 480, child: Text('8 hours')),
                    DropdownMenuItem(value: 1440, child: Text('1 day')),
                    DropdownMenuItem(value: 10080, child: Text('1 week')),
                  ],
                  onChanged: (v) => set(() => minutes = v!),
                ),
              ]),
            ]),
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => title.text.trim().length >= 3 ? Navigator.pop(ctx, true) : null, child: const Text('Publish')),
        ],
      ),
    ),
  );
  if (ok != true || !context.mounted) return;
  await guarded(context, () => s.api.post('/gov/alerts', {
        'kind': kind,
        'title': title.text.trim(),
        'body': body.text.trim().isEmpty ? null : body.text.trim(),
        'lat': point.latitude,
        'lon': point.longitude,
        'radius_m': radius,
        'minutes': minutes,
      }), success: 'Alert published');
  await s.refresh();
}
