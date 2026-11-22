import 'dart:async';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'command_state.dart';

/// One incident: verification, dispatch (nearest units by road time), unit
/// progress, the caller's contact (audited), notes, timeline and closing.
class IncidentPanel extends StatefulWidget {
  const IncidentPanel({super.key, required this.state, required this.incidentId, this.onClose});

  final CommandState state;
  final String incidentId;
  final VoidCallback? onClose;

  @override
  State<IncidentPanel> createState() => _IncidentPanelState();
}

class _IncidentPanelState extends State<IncidentPanel> {
  Map<String, dynamic>? _d;
  String? _error;
  final Map<String, List<Map<String, dynamic>>?> _suggest = {};
  final Set<String> _loadingSuggest = {};
  final _note = TextEditingController();
  Timer? _timer;

  CommandState get s => widget.state;

  @override
  void initState() {
    super.initState();
    _load();
    s.feed.versionChanged.addListener(_load);
    _timer = Timer.periodic(const Duration(seconds: 10), (_) => _load());
  }

  @override
  void didUpdateWidget(IncidentPanel old) {
    super.didUpdateWidget(old);
    if (old.incidentId != widget.incidentId) {
      _d = null;
      _suggest.clear();
      _load();
    }
  }

  @override
  void dispose() {
    s.feed.versionChanged.removeListener(_load);
    _timer?.cancel();
    _note.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = await s.api.get('/gov/incidents/${widget.incidentId}');
      if (mounted) setState(() => _d = Map<String, dynamic>.from(d as Map));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _findUnits(String category) async {
    setState(() => _loadingSuggest.add(category));
    final r = await guarded(context, () => s.api.get('/gov/incidents/${widget.incidentId}/suggest', query: {'category': category}));
    if (!mounted) return;
    setState(() {
      _loadingSuggest.remove(category);
      if (r != null) _suggest[category] = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    });
  }

  Future<void> _dispatch(String vehicleId, String category) async {
    final ok = await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/dispatch', {'vehicle_id': vehicleId}),
        success: '$vehicleId dispatched - waiting for the driver to accept');
    if (ok != null) {
      _suggest.remove(category);
      await _load();
    }
  }

  Future<void> _callerContact() async {
    final reason = await _askReason(context, 'Open caller contact',
        'The caller\'s phone number is shared only with the authority handling this incident, and only while it is open. Every opening is recorded in the audit log.');
    if (reason == null || !mounted) return;
    final c = await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/caller-contact', {'reason': reason}));
    if (c == null || !mounted) return;
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Caller contact'),
        content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          KeyValue('Name', (c as Map)['name'] as String? ?? 'Not given'),
          KeyValue('Phone', c['phone'] as String?),
          const SizedBox(height: 8),
          const Text('This access has been audited.', style: TextStyle(fontSize: 12)),
        ]),
        actions: [
          TextButton(onPressed: () => launchUrl(Uri.parse('tel:${c['phone']}')), child: const Text('Call')),
          FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
        ],
      ),
    );
  }

  Future<void> _verify(bool accept) async {
    var alert = false;
    var radius = 400.0;
    final noteCtl = TextEditingController();
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text(accept ? 'Verify report' : 'Reject report'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: noteCtl, decoration: const InputDecoration(labelText: 'Note (optional)')),
            if (accept) ...[
              const SizedBox(height: 12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: alert,
                onChanged: (v) => set(() => alert = v),
                title: const Text('Warn the public nearby'),
                subtitle: Text('Alert radius ${radius.round()} m'),
              ),
              if (alert) Slider(value: radius, min: 100, max: 2000, divisions: 19, onChanged: (v) => set(() => radius = v)),
            ],
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(accept ? 'Verify' : 'Reject')),
          ],
        ),
      ),
    );
    if (go != true || !mounted) return;
    await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/verify',
        {'accept': accept, 'note': noteCtl.text.trim().isEmpty ? null : noteCtl.text.trim(), 'alert': alert, 'alert_radius_m': radius}));
    await _load();
  }

  /// Sends what triage and the responder's interview found the scene needs:
  /// the nearest free units by road time (only services this seat dispatches).
  Future<void> _dispatchRecommended() async {
    final r = await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/dispatch-recommended'));
    if (r != null && mounted) {
      final sent = List<String>.from((r as Map)['sent'] as List? ?? const []);
      final notes = List<String>.from(r['notes'] as List? ?? const []);
      showSnack(context, sent.isEmpty ? 'Nothing sent: ${notes.join('; ')}' : 'Dispatched ${sent.join(', ')}${notes.isEmpty ? '' : ' · ${notes.join('; ')}'}');
    }
    await _load();
  }

  /// "I'm handling this" - the AI dispatch agent stands down on it.
  Future<void> _ack() async {
    await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/ack'), success: 'Acknowledged - the AI agent stands down on this incident');
    await _load();
  }

  Future<void> _close() async {
    final note = await _askText(context, 'Close incident', 'Closing releases every unit still assigned and ends the caller\'s contact sharing.', 'Closing note (optional)');
    if (note == null || !mounted) return;
    await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/close', {'note': note.isEmpty ? null : note}), success: 'Incident closed');
    await _load();
  }

  Future<void> _addNote(bool public) async {
    final text = _note.text.trim();
    if (text.isEmpty) return;
    final ok = await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/note', {'text': text, 'public': public}));
    if (ok != null) {
      _note.clear();
      await _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _d;
    if (d == null) {
      return Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator());
    }
    final theme = Theme.of(context);
    final kind = d['kind'] as String;
    final color = FearColors.incident(kind);
    final status = d['status'] as String;
    final units = (d['units'] as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    final needs = Map<String, dynamic>.from(d['needs'] as Map? ?? {});
    final open = ['reported', 'open', 'dispatched', 'on_scene'].contains(status);
    final dispatchCats = List<String>.from(d['dispatchCategories'] as List);

    return ListView(padding: const EdgeInsets.all(16), children: [
      Row(children: [
        CircleAvatar(backgroundColor: color, child: Icon(FearIcons.incident(kind), color: Colors.white)),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${d['kindLabel']}', style: theme.textTheme.titleLarge),
            Text('${d['id']} · ${titleCase(d['source'] as String)} · ${fmtClock(d['createdAt'] as String?)} (${fmtAgo(d['createdAt'] as String?)})',
                style: theme.textTheme.bodySmall),
          ]),
        ),
        if (widget.onClose != null) IconButton(onPressed: widget.onClose, icon: const Icon(Icons.close)),
      ]),
      const SizedBox(height: 10),
      Wrap(spacing: 8, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
        StatusPill(status),
        SeverityChip(score: d['severityScore'] as int?),
        if (d['voice'] != null) const Chip(avatar: Icon(Icons.mic, size: 16), label: Text('Voice report'), visualDensity: VisualDensity.compact),
        if (d['demo'] == true) const DemoBadge(text: 'DEMO'),
      ]),
      const SizedBox(height: 10),
      Text('${d['place'] ?? ''}', style: theme.textTheme.bodyMedium),
      if ((d['description'] as String?)?.isNotEmpty == true) ...[
        const SizedBox(height: 6),
        Text('"${d['description']}"', style: theme.textTheme.bodyLarge?.copyWith(fontStyle: FontStyle.italic)),
      ],
      if ((d['voice'] as Map?)?['original'] != null)
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text('As spoken (${(d['voice'] as Map)['language']}): "${(d['voice'] as Map)['original']}"', style: theme.textTheme.bodySmall),
        ),
      if (d['triage'] != null) _TriageCard(triage: Map<String, dynamic>.from(d['triage'] as Map), state: s),
      if (d['interview'] != null) _InterviewCard(interview: Map<String, dynamic>.from(d['interview'] as Map)),
      if (open && status != 'reported' && dispatchCats.isNotEmpty && ((d['triage'] as Map?)?['needs'] as Map?)?.isNotEmpty == true)
        Padding(
          padding: const EdgeInsets.only(top: 10),
          child: FilledButton.icon(
            onPressed: _dispatchRecommended,
            icon: const Icon(Icons.bolt),
            label: Text('Dispatch recommended: ${((d['triage'] as Map)['needs'] as Map).entries.map((e) => '${e.value} ${s.label('vehicleCategories', e.key as String)}').join(', ')}'),
          ),
        ),
      if (open) AiCard(incident: d, mode: s.ai?['mode'] as String?),
      const SizedBox(height: 12),
      Wrap(spacing: 8, runSpacing: 8, children: [
        if (open && d['respondedAt'] == null)
          FilledButton.tonalIcon(onPressed: _ack, icon: const Icon(Icons.back_hand), label: const Text('Acknowledge')),
        if (d['canVerify'] == true) ...[
          FilledButton.icon(onPressed: () => _verify(true), icon: const Icon(Icons.verified), label: const Text('Verify')),
          OutlinedButton.icon(onPressed: () => _verify(false), icon: const Icon(Icons.block), label: const Text('Reject')),
        ],
        if (d['canViewCallerContact'] == true)
          OutlinedButton.icon(onPressed: _callerContact, icon: const Icon(Icons.contact_phone), label: const Text('Caller contact')),
        if (d['canClose'] == true)
          OutlinedButton.icon(onPressed: _close, icon: const Icon(Icons.task_alt), label: const Text('Close incident')),
      ]),
      if (needs.isNotEmpty) ...[
        const SizedBox(height: 12),
        Text('Requested: ${needs.entries.map((e) => '${s.label('vehicleCategories', e.key)} × ${e.value}').join(', ')}', style: theme.textTheme.bodySmall),
      ],
      const Divider(height: 28),
      Text('Responding units', style: theme.textTheme.titleMedium),
      const SizedBox(height: 6),
      if (units.isEmpty) const Text('No unit dispatched yet.'),
      for (final u in units) _unitTile(u),
      if (open && status != 'reported' && dispatchCats.isNotEmpty) ...[
        const Divider(height: 28),
        Text('Dispatch', style: theme.textTheme.titleMedium),
        for (final cat in dispatchCats) _dispatchBlock(cat),
      ],
      if (open && status != 'reported' && dispatchCats.isEmpty && s.role == 'operator')
        Padding(
          padding: const EdgeInsets.only(top: 12),
          child: Text('Your authority monitors this incident; dispatch is done by the department that owns the units.', style: theme.textTheme.bodySmall),
        ),
      const Divider(height: 28),
      Text('Timeline', style: theme.textTheme.titleMedium),
      const SizedBox(height: 6),
      for (final e in (d['events'] as List).reversed)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          leading: Icon((e as Map)['public'] == 1 ? Icons.public : Icons.lock_outline, size: 16),
          title: Text('${e['text']}'),
          subtitle: Text('${fmtClock(e['at'] as String?)} · ${e['actor']}'),
        ),
      if (open) ...[
        const SizedBox(height: 8),
        TextField(controller: _note, decoration: const InputDecoration(labelText: 'Add a note', isDense: true)),
        const SizedBox(height: 6),
        Row(children: [
          TextButton(onPressed: () => _addNote(false), child: const Text('Internal note')),
          TextButton(onPressed: () => _addNote(true), child: const Text('Update caller')),
        ]),
      ],
    ]);
  }

  Widget _unitTile(Map<String, dynamic> u) {
    final live = s.unit(u['vehicleId'] as String?);
    final eta = live?['etaSec'] ?? u['etaSec'];
    final cat = u['category'] as String;
    final active = ['assigned', 'en_route', 'on_scene', 'transporting'].contains(u['status']);
    return Card(
      child: ListTile(
        leading: CircleAvatar(backgroundColor: FearColors.category(cat), child: Icon(FearIcons.category(cat), color: Colors.white, size: 20)),
        title: Row(children: [
          Flexible(child: Text('${u['vehicleId']}', overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 8),
          StatusPill(u['status'] as String?, dense: true),
          if (live?['emergency'] == true) ...[
            const SizedBox(width: 6),
            const Tooltip(message: 'Signal priority active', child: Icon(Icons.traffic, size: 16, color: Color(0xFF69F0AE))),
          ],
        ]),
        subtitle: Text([
          '${u['plate']} · ${u['orgName']}',
          if (u['destKind'] == 'hospital') 'To ${u['destName']}',
          if (active && eta != null) 'ETA ${fmtDuration(eta as num)}',
          if (live?['stale'] == true && active) 'GPS signal lost',
        ].join('\n')),
        isThreeLine: true,
        onTap: () => s.selectVehicle(u['vehicleId'] as String),
        trailing: u['canRecall'] == true
            ? IconButton(
                tooltip: 'Recall',
                icon: const Icon(Icons.undo),
                onPressed: () async {
                  if (await confirm(context, 'Recall ${u['vehicleId']}?', 'The unit is released from this incident and its signal priority ends.', ok: 'Recall')) {
                    if (!mounted) return;
                    await guarded(context, () => s.api.post('/gov/incidents/${widget.incidentId}/units/${u['unitId']}/recall'));
                    await _load();
                  }
                },
              )
            : null,
      ),
    );
  }

  Widget _dispatchBlock(String cat) {
    final list = _suggest[cat];
    final label = s.label('vehicleCategories', cat);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        OutlinedButton.icon(
          onPressed: _loadingSuggest.contains(cat) ? null : () => _findUnits(cat),
          icon: _loadingSuggest.contains(cat)
              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
              : Icon(FearIcons.category(cat), color: FearColors.category(cat)),
          label: Text('Find nearest $label'),
        ),
        if (list != null && list.isEmpty)
          const Padding(padding: EdgeInsets.all(8), child: Text('No available unit on duty right now.')),
        if (list != null)
          for (final c in list)
            ListTile(
              dense: true,
              leading: Icon(FearIcons.category(cat), color: FearColors.category(cat)),
              title: Row(children: [
                Text('${c['vehicleId']}'),
                if (c['demo'] == true) ...[const SizedBox(width: 6), const DemoBadge(text: 'DEMO GPS')],
              ]),
              subtitle: Text('${c['plate']} · ${s.orgNames[c['orgId']] ?? ''}\n'
                  '${c['etaSec'] != null ? '${fmtDuration(c['etaSec'] as num)} by road (${fmtDistance(c['roadM'] as num?)})' : 'no road route'} · ${fmtDistance(c['straightM'] as num?)} away'),
              isThreeLine: true,
              trailing: FilledButton(onPressed: () => _dispatch(c['vehicleId'] as String, cat), child: const Text('Dispatch')),
            ),
      ]),
    );
  }
}

Future<String?> _askReason(BuildContext context, String title, String body) async {
  final ctl = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(body),
        const SizedBox(height: 12),
        TextField(controller: ctl, autofocus: true, decoration: const InputDecoration(labelText: 'Reason (at least 10 characters)')),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => ctl.text.trim().length >= 10 ? Navigator.pop(ctx, ctl.text.trim()) : null, child: const Text('Continue')),
      ],
    ),
  );
}

Future<String?> askReason(BuildContext context, String title, String body) => _askReason(context, title, body);

Future<String?> _askText(BuildContext context, String title, String body, String label) async {
  final ctl = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(body),
        const SizedBox(height: 12),
        TextField(controller: ctl, decoration: InputDecoration(labelText: label)),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(ctx, ctl.text.trim()), child: const Text('Confirm')),
      ],
    ),
  );
}


/// What triage found: the summary, key terms, people affected, likely needs.
class _TriageCard extends StatelessWidget {
  const _TriageCard({required this.triage, required this.state});

  final Map<String, dynamic> triage;
  final CommandState state;

  @override
  Widget build(BuildContext context) {
    final t = triage;
    final terms = List<String>.from((t['terms'] as List?) ?? const []);
    final needs = Map<String, dynamic>.from((t['needs'] as Map?) ?? const {});
    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(t['method'] == 'ai+rules' ? 'Triage (AI + key terms)' : 'Triage (key terms)', style: Theme.of(context).textTheme.labelLarge),
          if (t['summary'] != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('${t['summary']}')),
          if (terms.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Wrap(spacing: 6, runSpacing: 4, children: [
                for (final term in terms) Chip(label: Text(term, style: const TextStyle(fontSize: 12)), visualDensity: VisualDensity.compact),
              ]),
            ),
          if (t['injured'] != null) KeyValue('People affected', '${t['injured']}'),
          if (needs.isNotEmpty)
            KeyValue('Likely needs', needs.entries.map((e) => '${e.value} × ${state.label('vehicleCategories', e.key)}').join(', ')),
        ]),
      ),
    );
  }
}

/// The AI dispatch agent on one incident: what it did, or when it will act.
class AiCard extends StatelessWidget {
  const AiCard({super.key, required this.incident, this.mode});

  final Map<String, dynamic> incident;
  final String? mode;

  @override
  Widget build(BuildContext context) {
    final ai = (incident['ai'] as Map?)?.cast<String, dynamic>();
    final due = incident['aiDueAt'] as String?;
    final hasUnits = ((incident['units'] as List?) ?? const []).isNotEmpty;
    Widget body;
    if (ai != null && ai['status'] != null) {
      final vehicles = List<String>.from((ai['vehicles'] as List?) ?? const []);
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('AI agent: ${'${ai['status']}'.replaceAll('_', ' ')}${vehicles.isNotEmpty ? ' - ${vehicles.join(', ')}' : ''}',
            style: const TextStyle(fontWeight: FontWeight.w700)),
        if (ai['reason'] != null) Text('${ai['reason']}'),
        if (ai['note'] != null) Text('${ai['note']}', style: Theme.of(context).textTheme.bodySmall),
      ]);
    } else if (due != null && incident['respondedAt'] == null && !hasUnits) {
      body = Row(children: [
        Text('AI ${mode == 'advise' ? 'advice' : 'dispatch'} in '),
        CountdownText(until: due, style: const TextStyle(fontWeight: FontWeight.w800)),
        const Flexible(child: Text(' - acknowledge to handle it yourself')),
      ]);
    } else {
      return const SizedBox.shrink();
    }
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: emergencyRouteColor.withValues(alpha: 0.08),
        border: const Border(left: BorderSide(color: emergencyRouteColor, width: 4)),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        const Icon(Icons.smart_toy_outlined, color: emergencyRouteColor),
        const SizedBox(width: 10),
        Expanded(child: body),
      ]),
    );
  }
}

/// One line for incident lists.
class AiLine extends StatelessWidget {
  const AiLine({super.key, required this.incident, this.mode});

  final Map<String, dynamic> incident;
  final String? mode;

  @override
  Widget build(BuildContext context) {
    final ai = (incident['ai'] as Map?)?.cast<String, dynamic>();
    final due = incident['aiDueAt'] as String?;
    const style = TextStyle(fontSize: 12, color: emergencyRouteColor);
    if (ai != null && ai['status'] == 'dispatched') return Text('AI agent dispatched ${(ai['vehicles'] as List?)?.join(', ') ?? ''}', style: style);
    if (ai != null && ai['status'] == 'advised') return Text('AI agent recommends ${(ai['vehicles'] as List?)?.join(', ') ?? ''}', style: style);
    if (ai != null && ai['note'] != null) return Text('AI agent: ${ai['note']}', style: style.copyWith(color: FearColors.warn));
    if (due != null && incident['respondedAt'] == null) {
      return Row(children: [
        Text('AI ${mode == 'advise' ? 'advice' : 'dispatch'} in ', style: style),
        CountdownText(until: due, style: style.copyWith(fontWeight: FontWeight.w800)),
      ]);
    }
    return const SizedBox.shrink();
  }
}

/// mm:ss until an ISO time, ticking every second.
class CountdownText extends StatefulWidget {
  const CountdownText({super.key, required this.until, this.style});

  final String until;
  final TextStyle? style;

  @override
  State<CountdownText> createState() => _CountdownTextState();
}

class _CountdownTextState extends State<CountdownText> {
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _t = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = DateTime.tryParse(widget.until);
    final s = t == null ? 0 : t.difference(DateTime.now()).inSeconds;
    return Text(s <= 0 ? 'now' : '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}', style: widget.style);
  }
}

/// The agent's switch (ICCC seat / FEAR's admin) and what it is doing.
class AiAgentCard extends StatelessWidget {
  const AiAgentCard({super.key, required this.state});

  final CommandState state;

  @override
  Widget build(BuildContext context) {
    final a = state.ai!;
    final enabled = a['enabled'] == true;
    final mode = enabled ? a['mode'] as String : 'off';
    final win = ((a['windowSec'] as num?) ?? 120).toInt();
    final text = !enabled
        ? 'Off - emergencies wait for a person.'
        : mode == 'advise'
            ? 'Advise only - recommends units when an emergency waits ${win ~/ 60} min without a response.'
            : 'Dispatches automatically when an emergency waits ${win ~/ 60} min with no response and no unit.';
    return Card(
      color: emergencyRouteColor.withValues(alpha: 0.06),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            const Icon(Icons.smart_toy_outlined, color: emergencyRouteColor),
            const SizedBox(width: 8),
            Text('AI dispatch agent', style: Theme.of(context).textTheme.titleSmall),
            const Spacer(),
            if (a['model'] == null) const Text('rules only', style: TextStyle(fontSize: 11)),
          ]),
          const SizedBox(height: 4),
          Text(text, style: const TextStyle(fontSize: 13)),
          if (a['canConfigure'] == true) ...[
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'dispatch', label: Text('Auto'), icon: Icon(Icons.bolt)),
                ButtonSegment(value: 'advise', label: Text('Advise'), icon: Icon(Icons.lightbulb_outline)),
                ButtonSegment(value: 'off', label: Text('Off'), icon: Icon(Icons.power_settings_new)),
              ],
              selected: {mode},
              onSelectionChanged: (v) async {
                final m = v.first;
                if (m == 'off' &&
                    !await confirm(context, 'Turn the AI agent off?', 'Emergencies nobody responds to will then wait for a person.', ok: 'Turn off')) {
                  return;
                }
                if (!context.mounted) return;
                await guarded(context, () => m == 'off' ? state.setAi(enabled: false) : state.setAi(enabled: true, mode: m));
              },
            ),
          ],
        ]),
      ),
    );
  }
}


/// The AI responder's spoken interview with the caller: the facts it found
/// and every question and answer (with the words as spoken).
class _InterviewCard extends StatelessWidget {
  const _InterviewCard({required this.interview});

  final Map<String, dynamic> interview;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final f = Map<String, dynamic>.from((interview['facts'] as Map?) ?? const {});
    final turns = ((interview['turns'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();
    String yn(Object? v) => v == 'yes' ? 'yes' : v == 'no' ? 'no' : 'not said';
    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: ExpansionTile(
        initiallyExpanded: true,
        leading: const Icon(Icons.record_voice_over),
        title: Text('Responder interview${interview['done'] == true ? '' : ' (in progress)'}'),
        subtitle: Text('Language ${interview['lang'] ?? '-'} · ${turns.where((t) => t['a'] != null).length} answers'),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(spacing: 8, runSpacing: 6, children: [
            Chip(label: Text('Hurt: ${f['injured'] ?? 'not said'}')),
            Chip(label: Text('Unconscious / not breathing / heavy bleeding: ${yn(f['critical'])}')),
            Chip(label: Text('Trapped / fire / fuel: ${yn(f['hazard'])}')),
            if ((f['vehicles'] as List?)?.isNotEmpty == true) Chip(label: Text('Vehicles: ${(f['vehicles'] as List).join(', ')}')),
            if (f['landmark'] != null) Chip(label: Text('Landmark: ${f['landmark']}')),
            Chip(label: Text('Caller safe: ${yn(f['callerSafe'])}')),
          ]),
          const SizedBox(height: 8),
          for (final t in turns) ...[
            Text('Q: ${t['qEn'] ?? t['q']}', style: theme.textTheme.bodySmall),
            Padding(
              padding: const EdgeInsets.only(left: 12, bottom: 6),
              child: Text(t['a'] != null ? 'A: ${t['a']}${t['aOrig'] != null ? '\n   (as spoken: ${t['aOrig']})' : ''}' : 'A: -'),
            ),
          ],
        ],
      ),
    );
  }
}
