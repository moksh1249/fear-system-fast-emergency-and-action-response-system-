import 'dart:async';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'login.dart';
import 'public_state.dart';
import 'responder.dart';
import 'voice.dart';

class SosButton extends StatelessWidget {
  const SosButton({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 64,
      height: 64,
      child: FloatingActionButton(
        heroTag: 'sos',
        backgroundColor: FearColors.brand,
        foregroundColor: Colors.white,
        shape: const CircleBorder(),
        onPressed: onPressed,
        child: const Text('SOS', style: TextStyle(fontWeight: FontWeight.w900, fontSize: 18)),
      ),
    );
  }
}

const _sosKinds = [
  ('medical', 'Medical', 'Injury, illness, someone collapsed'),
  ('accident', 'Road accident', 'Crash with injuries or blocked road'),
  ('fire', 'Fire', 'Fire, smoke, gas leak'),
  ('crime', 'Police', 'Crime, threat, violence'),
];

/// SOS: pick what happened, a short countdown to cancel an accidental press,
/// then send - with the caller's location and (by default) contact number,
/// shared only with the authority that handles it until it closes.
Future<void> startSos(BuildContext context, PublicState s) async {
  final existing = s.openSos.firstOrNull;
  if (existing != null) {
    await openSosTracking(context, s, existing['id'] as String);
    return;
  }
  final fix = s.location.fix;
  if (fix == null) {
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('No location yet'),
        content: const Text('FEAR needs your location to send help. Call 112 now - or allow location and try again.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Close')),
          FilledButton.icon(onPressed: () => callEmergency(ctx), icon: const Icon(Icons.call), label: const Text('Call 112')),
        ],
      ),
    );
    return;
  }
  // Talk to the AI responder, or fill the form below.
  final mode = await askReportMode(context, sos: true);
  if (mode == null || !context.mounted) return;
  if (mode == 'voice') {
    final r = await openResponder(context, s, purpose: 'sos', at: fix.latLng, demo: fix.demo);
    if (!context.mounted) return;
    if (r != 'form') {
      await s.refreshLists();
      if (r != null && context.mounted) await openSosTracking(context, s, r);
      return;
    }
  }
  if (!context.mounted) return;
  var shareContact = true;
  final note = TextEditingController();
  VoiceResult? voice;
  final kind = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, MediaQuery.viewInsetsOf(ctx).bottom + 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('What is the emergency?', style: Theme.of(ctx).textTheme.titleLarge),
          if (fix.demo) const Padding(padding: EdgeInsets.only(top: 6), child: Align(alignment: Alignment.centerLeft, child: DemoBadge(text: 'DEMO LOCATION - sent as a demo SOS'))),
          const SizedBox(height: 12),
          for (final k in _sosKinds)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Material(
                color: FearColors.incident(k.$1).withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(12),
                child: ListTile(
                  leading: Icon(FearIcons.incident(k.$1), color: FearColors.incident(k.$1), size: 32),
                  title: Text(k.$2, style: const TextStyle(fontWeight: FontWeight.w700)),
                  subtitle: Text(k.$3),
                  onTap: () => Navigator.pop(ctx, k.$1),
                ),
              ),
            ),
          TextField(
            controller: note,
            maxLines: 3,
            minLines: 1,
            decoration: InputDecoration(
              labelText: 'Anything responders should know? (optional)',
              isDense: true,
              suffixIcon: IconButton(
                tooltip: 'Say it instead',
                icon: const Icon(Icons.mic),
                onPressed: () async {
                  final v = await describeByVoice(ctx, s, kind: 'accident', title: 'Tell responders what happened');
                  if (v != null) {
                    set(() {
                      voice = v;
                      note.text = v.text;
                    });
                  }
                },
              ),
            ),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            value: shareContact,
            onChanged: (v) => set(() => shareContact = v),
            title: const Text('Share my phone number with responders'),
            subtitle: const Text('Only the service handling this emergency, only until it closes.'),
          ),
        ]),
      ),
    ),
  );
  if (kind == null || !context.mounted) return;
  final go = await showDialog<bool>(context: context, barrierDismissible: false, builder: (_) => const _Countdown());
  if (go != true || !context.mounted) return;
  final f = s.location.fix ?? fix;
  final r = await guarded(context, () => s.api.post('/public/sos', {
        'kind': kind,
        'lat': f.lat,
        'lon': f.lon,
        'note': note.text.trim().isEmpty ? null : note.text.trim(),
        'share_contact': shareContact,
        'demo': f.demo,
        if (voice != null) 'voice': voice!.voiceMeta,
      }));
  if (r == null || !context.mounted) return;
  HapticFeedback.heavyImpact();
  await s.refreshLists();
  if (!context.mounted) return;
  await openSosTracking(context, s, (r as Map)['id'] as String);
}

class _Countdown extends StatefulWidget {
  const _Countdown();

  @override
  State<_Countdown> createState() => _CountdownState();
}

class _CountdownState extends State<_Countdown> {
  int _left = 5;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    HapticFeedback.mediumImpact();
    _t = Timer.periodic(const Duration(seconds: 1), (t) {
      if (_left <= 1) {
        t.cancel();
        Navigator.pop(context, true);
      } else {
        HapticFeedback.selectionClick();
        setState(() => _left--);
      }
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Sending SOS'),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(
          width: 96,
          height: 96,
          child: Stack(alignment: Alignment.center, children: [
            CircularProgressIndicator(value: _left / 5, strokeWidth: 8, color: FearColors.brand),
            Text('$_left', style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w800)),
          ]),
        ),
        const SizedBox(height: 16),
        const Text('Help will be requested at your location.'),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(context, true), style: FilledButton.styleFrom(backgroundColor: FearColors.brand), child: const Text('Send now')),
      ],
    );
  }
}

Future<void> openSosTracking(BuildContext context, PublicState s, String id) =>
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => IncidentTrackingScreen(state: s, incidentId: id)));

/// Following one of my incidents: who is coming, how far, what happened.
class IncidentTrackingScreen extends StatefulWidget {
  const IncidentTrackingScreen({super.key, required this.state, required this.incidentId});

  final PublicState state;
  final String incidentId;

  @override
  State<IncidentTrackingScreen> createState() => _IncidentTrackingScreenState();
}

class _IncidentTrackingScreenState extends State<IncidentTrackingScreen> {
  Map<String, dynamic>? _fetched;
  final _map = MapController();
  Timer? _poll;

  PublicState get s => widget.state;

  @override
  void initState() {
    super.initState();
    _fetch();
    _poll = Timer.periodic(const Duration(seconds: 15), (_) => _fetch());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _fetch() async {
    try {
      final r = await s.api.get('/public/incidents/${widget.incidentId}');
      if (mounted) setState(() => _fetched = Map<String, dynamic>.from(r as Map));
    } catch (_) {}
  }

  Map<String, dynamic>? get _incident => s.openSos.where((i) => i['id'] == widget.incidentId).firstOrNull ?? _fetched;

  /// More about the emergency while help is coming - Command's triage (and
  /// the AI dispatch agent) re-rate the incident with it.
  Future<void> _addDetails(BuildContext context) async {
    final how = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.mic), title: const Text('Speak'), subtitle: const Text('Any language'), onTap: () => Navigator.pop(ctx, 'voice')),
          ListTile(leading: const Icon(Icons.keyboard), title: const Text('Type'), onTap: () => Navigator.pop(ctx, 'text')),
        ]),
      ),
    );
    if (how == null || !context.mounted) return;
    String? text;
    Map<String, dynamic>? meta;
    if (how == 'voice') {
      final v = await describeByVoice(context, s, kind: '${_incident?['kind'] ?? 'accident'}', title: 'Tell responders more');
      text = v?.text;
      meta = v?.voiceMeta;
    } else {
      final f = await formDialog(context, 'Tell responders more', const [FormSpec('note', 'What should they know?', lines: 4)], ok: 'Send');
      text = f?['note'];
    }
    if (text == null || text.isEmpty || !context.mounted) return;
    final r = await guarded(context, () => s.api.post('/public/sos/${widget.incidentId}/details', {'note': text, 'voice': ?meta}),
        success: 'Sent to Command');
    if (r != null && mounted) setState(() => _fetched = Map<String, dynamic>.from(r as Map));
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final inc = _incident;
        if (inc == null) return Scaffold(appBar: AppBar(), body: const Center(child: CircularProgressIndicator()));
        final status = inc['status'] as String;
        final open = ['reported', 'open', 'dispatched', 'on_scene'].contains(status);
        final units = (inc['units'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
        final coming = units.where((u) => u['status'] == 'en_route').toList();
        final etas = coming.map((u) => u['etaSec']).whereType<num>().toList()..sort();
        final headline = switch (status) {
          'reported' => 'Report sent - Command is verifying it',
          'open' => inc['source'] == 'sos' ? 'SOS received - finding the nearest help' : 'Verified by Command',
          'dispatched' => etas.isNotEmpty ? 'Help is ${fmtDuration(etas.first)} away' : 'Help has been dispatched',
          'on_scene' => 'Responders are with you',
          'closed' => 'Closed',
          'rejected' => 'Not verified by Command',
          'cancelled' => 'You cancelled this SOS',
          _ => statusLabel(status),
        };
        final me = s.location.fix;
        return Scaffold(
          appBar: AppBar(title: Text('${inc['kindLabel']}'), actions: [
            if (inc['source'] == 'sos') IconButton(tooltip: 'Call 112', onPressed: () => callEmergency(context), icon: const Icon(Icons.call)),
          ]),
          body: Column(children: [
            Container(
              width: double.infinity,
              color: open ? FearColors.brand : Colors.grey.shade700,
              padding: const EdgeInsets.all(16),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(headline, style: const TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
                const SizedBox(height: 4),
                Text('${inc['place'] ?? ''} · ${fmtClock(inc['createdAt'] as String?)}', style: const TextStyle(color: Colors.white70)),
              ]),
            ),
            SizedBox(
              height: 260,
              child: FearMap(
                controller: _map,
                initialCenter: latLngOf(inc)!,
                initialZoom: 15,
                children: [
                  MarkerLayer(markers: [
                    Marker(point: latLngOf(inc)!, width: 48, height: 48, child: IncidentMarkerIcon(kind: inc['kind'] as String)),
                    for (final u in units)
                      if (u['lat'] != null)
                        Marker(point: latLngOf(u)!, width: 56, height: 56,
                            child: VehicleMarkerIcon(category: u['category'] as String, heading: (u['heading'] as num?)?.toDouble(), emergency: u['status'] == 'en_route' || u['status'] == 'transporting')),
                    if (me != null) Marker(point: me.latLng, width: 36, height: 36, child: MeMarkerIcon(demo: me.demo)),
                  ]),
                ],
              ),
            ),
            Expanded(
              child: ListView(padding: const EdgeInsets.all(16), children: [
                if (units.isNotEmpty) ...[
                  Text('Responders', style: Theme.of(context).textTheme.titleMedium),
                  for (final u in units)
                    ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: CircleAvatar(backgroundColor: FearColors.category(u['category'] as String), child: Icon(FearIcons.category(u['category'] as String), color: Colors.white)),
                      title: Text('${u['categoryLabel']} ${u['vehicleId']}'),
                      subtitle: Text('${u['statusLabel']}${u['etaSec'] != null && u['status'] == 'en_route' ? ' · ${fmtDuration(u['etaSec'] as num)} away' : ''}'
                          '${u['destName'] != null ? ' · to ${u['destName']}' : ''}'),
                    ),
                  const Divider(),
                ],
                Text('Updates', style: Theme.of(context).textTheme.titleMedium),
                for (final e in (inc['events'] as List).reversed)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.circle, size: 10),
                    title: Text('${(e as Map)['text']}'),
                    subtitle: Text(fmtClock(e['at'] as String?)),
                  ),
                const SizedBox(height: 16),
                if (inc['source'] == 'sos' && open) ...[
                  FilledButton.tonalIcon(
                    onPressed: () => _addDetails(context),
                    icon: const Icon(Icons.mic),
                    label: const Text('Tell responders more (voice or text)'),
                  ),
                  const SizedBox(height: 8),
                ],
                if (inc['source'] == 'sos' && (status == 'open' || status == 'dispatched'))
                  OutlinedButton.icon(
                    style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                    onPressed: () async {
                      if (!await confirm(context, 'Cancel SOS?', 'Only cancel if you no longer need help. Responders will be stood down.', ok: 'Cancel SOS', danger: true)) return;
                      if (!context.mounted) return;
                      await guarded(context, () => s.api.post('/public/sos/${widget.incidentId}/cancel'), success: 'SOS cancelled');
                      await _fetch();
                    },
                    icon: const Icon(Icons.cancel),
                    label: const Text('I no longer need help'),
                  ),
              ]),
            ),
          ]),
        );
      },
    );
  }
}
