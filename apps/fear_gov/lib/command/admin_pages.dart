import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'command_state.dart';

/// RTO desk: citizens' vehicle registrations waiting for a VAHAN-style check
/// (manual in this deployment - see the backend's providers.py).
class VerificationPage extends StatefulWidget {
  const VerificationPage({super.key, required this.state});

  final CommandState state;

  @override
  State<VerificationPage> createState() => _VerificationPageState();
}

class _VerificationPageState extends State<VerificationPage> {
  String _status = 'pending';
  List<Map<String, dynamic>>? _rows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await guarded(context, () => widget.state.api.get('/gov/verification/citizen-vehicles', query: {'status': _status}));
    if (r != null && mounted) setState(() => _rows = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList());
  }

  Future<void> _review(Map<String, dynamic> v, String decision) async {
    final note = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(decision == 'verified' ? 'Verify ${v['plate']}' : 'Reject ${v['plate']}'),
        content: TextField(controller: note, decoration: const InputDecoration(labelText: 'Note to the owner (optional)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: Text(decision == 'verified' ? 'Verify' : 'Reject')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    await guarded(context, () => widget.state.api.post('/gov/verification/citizen-vehicles/${v['id']}',
        {'decision': decision, 'note': note.text.trim().isEmpty ? null : note.text.trim()}));
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final rows = _rows;
    return ListView(padding: const EdgeInsets.all(16), children: [
      SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'pending', label: Text('Pending')),
          ButtonSegment(value: 'verified', label: Text('Verified')),
          ButtonSegment(value: 'rejected', label: Text('Rejected')),
        ],
        selected: {_status},
        onSelectionChanged: (v) {
          setState(() => _status = v.first);
          _load();
        },
      ),
      const SizedBox(height: 8),
      Text('Check each registration against VAHAN records before verifying.', style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 12),
      if (rows == null) const Center(child: CircularProgressIndicator()),
      if (rows != null && rows.isEmpty) const Text('Nothing here.'),
      for (final v in rows ?? const <Map<String, dynamic>>[])
        Card(
          child: ListTile(
            leading: const Icon(Icons.directions_car),
            title: Text('${v['plate']}', style: const TextStyle(fontWeight: FontWeight.w600, letterSpacing: 1)),
            subtitle: Text('${titleCase(v['vehicle_type'] as String)}${v['make_model'] != null ? ' · ${v['make_model']}' : ''}\n'
                'Owner: ${v['owner_name'] ?? 'not given'} · submitted ${fmtAgo(v['created_at'] as String?)}'
                '${v['review_note'] != null ? '\nNote: ${v['review_note']}' : ''}'),
            isThreeLine: true,
            trailing: _status == 'pending'
                ? Wrap(spacing: 6, children: [
                    OutlinedButton(onPressed: () => _review(v, 'rejected'), child: const Text('Reject')),
                    FilledButton(onPressed: () => _review(v, 'verified'), child: const Text('Verify')),
                  ])
                : StatusPill(_status == 'verified' ? 'available' : 'rejected', label: titleCase(_status), dense: true),
          ),
        ),
    ]);
  }
}

class AuditPage extends StatefulWidget {
  const AuditPage({super.key, required this.state});

  final CommandState state;

  @override
  State<AuditPage> createState() => _AuditPageState();
}

class _AuditPageState extends State<AuditPage> {
  List<Map<String, dynamic>>? _rows;
  String _filter = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await guarded(context, () => widget.state.api.get('/gov/audit'));
    if (r != null && mounted) setState(() => _rows = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList());
  }

  static const _sensitive = {'driver.identity_reveal', 'incident.caller_contact', 'drivers.list'};

  @override
  Widget build(BuildContext context) {
    final rows = (_rows ?? const <Map<String, dynamic>>[])
        .where((r) => _filter.isEmpty || '${r['action']} ${r['actor_username']} ${r['target_id']} ${r['reason']}'.toLowerCase().contains(_filter.toLowerCase()))
        .toList();
    return Column(children: [
      Padding(
        padding: const EdgeInsets.all(12),
        child: Row(children: [
          Expanded(
            child: TextField(
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Filter by action, user, target or reason', isDense: true),
              onChanged: (v) => setState(() => _filter = v),
            ),
          ),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ]),
      ),
      Expanded(
        child: _rows == null
            ? const Center(child: CircularProgressIndicator())
            : ListView.builder(
                itemCount: rows.length,
                itemBuilder: (_, i) {
                  final r = rows[i];
                  final sensitive = _sensitive.contains(r['action']);
                  return ListTile(
                    dense: true,
                    leading: Icon(sensitive ? Icons.privacy_tip : Icons.history, color: sensitive ? FearColors.warn : null),
                    title: Text('${r['action']}${r['target_id'] != null ? ' · ${r['target_type']} ${r['target_id']}' : ''}'),
                    subtitle: Text('${fmtClock(r['at'] as String?)} ${fmtAgo(r['at'] as String?)} · ${r['actor_username'] ?? r['actor_id']}'
                        '${r['reason'] != null ? '\nReason: ${r['reason']}' : ''}'),
                    isThreeLine: r['reason'] != null,
                  );
                },
              ),
      ),
    ]);
  }
}

/// Dev mode only: the SMS codes the backend would have sent.
class OutboxPage extends StatefulWidget {
  const OutboxPage({super.key, required this.state});

  final CommandState state;

  @override
  State<OutboxPage> createState() => _OutboxPageState();
}

class _OutboxPageState extends State<OutboxPage> {
  List<Map<String, dynamic>>? _rows;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final r = await guarded(context, () => widget.state.api.get('/gov/dev/outbox'));
    if (r != null && mounted) setState(() => _rows = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList());
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          const Expanded(child: Text('Development stand-in for the SMS gateway: login codes appear here instead of being texted.')),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ]),
        const SizedBox(height: 12),
        if (_rows == null) const Center(child: CircularProgressIndicator()),
        for (final r in _rows ?? const <Map<String, dynamic>>[])
          Card(
            child: ListTile(
              leading: const Icon(Icons.sms),
              title: Text('${r['recipient']}'),
              subtitle: Text('${r['body']}'),
              trailing: Text(fmtAgo(r['created_at'] as String?)),
            ),
          ),
      ]),
    );
  }
}
