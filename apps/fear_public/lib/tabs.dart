import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'login.dart';
import 'public_state.dart';
import 'sos.dart';

/// Command's public alerts around me (closures, diversions, advisories,
/// verified incidents).
class AlertsTab extends StatelessWidget {
  const AlertsTab({super.key, required this.state});

  final PublicState state;

  @override
  Widget build(BuildContext context) {
    final alerts = state.alerts;
    return Scaffold(
      appBar: AppBar(title: const Text('Alerts near you')),
      body: RefreshIndicator(
        onRefresh: state.refreshLists,
        child: ListView(padding: const EdgeInsets.all(16), children: [
          if (state.nearby.isNotEmpty) ...[
            Text('Emergency vehicles nearby', style: Theme.of(context).textTheme.titleMedium),
            for (final n in state.nearby)
              ListTile(
                leading: Icon(FearIcons.category(n['category'] as String), color: FearColors.category(n['category'] as String)),
                title: Text('${n['categoryLabel']} responding'),
                subtitle: Text('${fmtDistance(n['distanceM'] as num?)} away${n['approaching'] == true ? ' · heading your way - make way' : ''}'),
              ),
            const Divider(height: 24),
          ],
          if (alerts.isEmpty)
            const Padding(padding: EdgeInsets.all(24), child: Text('No alerts around you right now.', textAlign: TextAlign.center)),
          for (final a in alerts)
            Card(
              color: a['inside'] == true ? FearColors.warn.withValues(alpha: 0.18) : null,
              child: ListTile(
                leading: Icon(
                  switch (a['kind']) { 'closure' => Icons.block, 'diversion' => Icons.alt_route, 'incident' => Icons.crisis_alert, _ => Icons.info_outline },
                  color: FearColors.warn,
                ),
                title: Text('${a['title']}'),
                subtitle: Text([
                  if (a['body'] != null) '${a['body']}',
                  a['inside'] == true ? 'You are inside this area' : '${fmtDistance(a['distanceM'] as num?)} away',
                  'Until ${fmtClock(a['expiresAt'] as String?)}',
                ].join('\n')),
                isThreeLine: true,
              ),
            ),
        ]),
      ),
    );
  }
}

/// My SOS calls and reports, with their outcome.
class ActivityTab extends StatelessWidget {
  const ActivityTab({super.key, required this.state});

  final PublicState state;

  @override
  Widget build(BuildContext context) {
    final items = state.myIncidents;
    return Scaffold(
      appBar: AppBar(title: const Text('My SOS & reports')),
      body: RefreshIndicator(
        onRefresh: state.refreshLists,
        child: items.isEmpty
            ? ListView(children: const [Padding(padding: EdgeInsets.all(32), child: Text('Nothing yet. Your SOS calls and reports appear here.', textAlign: TextAlign.center))])
            : ListView.builder(
                padding: const EdgeInsets.all(12),
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final it = items[i];
                  return Card(
                    child: ListTile(
                      onTap: () => openSosTracking(context, state, it['id'] as String),
                      leading: CircleAvatar(
                        backgroundColor: FearColors.incident(it['kind'] as String),
                        child: Icon(FearIcons.incident(it['kind'] as String), color: Colors.white, size: 20),
                      ),
                      title: Text('${it['kindLabel']}'),
                      subtitle: Text('${it['source'] == 'sos' ? 'SOS' : 'Report'} · ${fmtClock(it['createdAt'] as String?)} · ${fmtAgo(it['createdAt'] as String?)}\n${it['place'] ?? ''}'),
                      isThreeLine: true,
                      trailing: StatusPill(it['status'] as String?, dense: true),
                    ),
                  );
                },
              ),
      ),
    );
  }
}

/// "Me": the person's own details, sign-in (password, mobile number), their
/// vehicles, and requests to Command - deleting the account, or transferring
/// a vehicle to someone else - which a reviewer approves in FEAR Command.
class ProfileTab extends StatefulWidget {
  const ProfileTab({super.key, required this.state});

  final PublicState state;

  @override
  State<ProfileTab> createState() => _ProfileTabState();
}

class _ProfileTabState extends State<ProfileTab> {
  List<Map<String, dynamic>>? _vehicles;
  List<Map<String, dynamic>> _requests = [];

  PublicState get s => widget.state;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    try {
      final v = await s.api.get('/public/vehicles');
      final r = await s.api.get('/public/requests');
      if (!mounted) return;
      setState(() {
        _vehicles = (v as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
        _requests = (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();
      });
    } catch (_) {}
  }

  Future<void> _saveProfile(Map<String, dynamic>? r) async {
    if (r != null) await s.session.updateProfile(Map<String, dynamic>.from(r));
  }

  Future<void> _editDetails() async {
    final me = s.me;
    final v = await formDialog(context, 'Your details', [
      FormSpec('name', 'Full name', initial: me['name'] as String? ?? ''),
      FormSpec('address', 'Address', initial: me['address'] as String? ?? '', lines: 3),
    ]);
    if (v == null || !mounted) return;
    final r = await guarded(context, () => s.api.patch('/public/me', {'name': v['name'], 'address': v['address']}), success: 'Saved');
    await _saveProfile(r as Map<String, dynamic>?);
  }

  Future<void> _password() async {
    final has = s.me['hasPassword'] == true;
    final v = await formDialog(context, has ? 'Change password' : 'Set a password', [
      if (has) const FormSpec('current', 'Current password', obscure: true),
      const FormSpec('new', 'New password', obscure: true),
      const FormSpec('again', 'New password again', obscure: true),
    ], note: 'At least 8 characters, with letters and numbers. You can then sign in with your number and password '
        'instead of a code.');
    if (v == null || !mounted) return;
    if (v['new'] != v['again']) {
      showSnack(context, 'The two new passwords are different.', error: true);
      return;
    }
    final r = await guarded(context, () => s.api.post('/public/me/password', {'current_password': v['current'], 'new_password': v['new']}),
        success: has ? 'Password changed' : 'Password set');
    await _saveProfile(r as Map<String, dynamic>?);
  }

  Future<void> _changePhone() async {
    final v = await formDialog(context, 'Change mobile number', const [FormSpec('phone', 'New mobile number', phone: true)],
        ok: 'Send code', note: 'We send a code to the new number to check it is yours.');
    if (v == null || !mounted) return;
    final sent = await guarded(context, () => s.api.post('/public/me/phone/request', {'phone': v['phone']}));
    if (sent == null || !mounted) return;
    final to = (sent as Map)['phone'] as String;
    final c = await formDialog(context, 'Enter the code', const [FormSpec('code', '6-digit code', phone: true)],
        ok: 'Verify',
        note: 'Sent to $to.${sent['devMode'] == true ? ' Development server: the code is in the FEAR server console.' : ''}');
    if (c == null || !mounted) return;
    final r = await guarded(context, () => s.api.post('/public/me/phone/verify', {'phone': to, 'code': c['code']}),
        success: 'Mobile number changed');
    await _saveProfile(r as Map<String, dynamic>?);
  }

  Future<void> _addVehicle() async {
    final types = List<String>.from(s.meta['vehicleTypes'] as List? ?? const ['car', 'motorcycle', 'scooter', 'auto_rickshaw', 'bus', 'truck', 'other']);
    var type = types.first;
    final plate = TextEditingController();
    final make = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('Add a vehicle'),
          content: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: plate,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Registration number', hintText: 'UP14 AB 1234'),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: type,
              decoration: const InputDecoration(labelText: 'Type'),
              items: [for (final t in types) DropdownMenuItem(value: t, child: Text(vehicleTypeLabel(t)))],
              onChanged: (v) => set(() => type = v!),
            ),
            const SizedBox(height: 12),
            TextField(controller: make, decoration: const InputDecoration(labelText: 'Make / model (optional)')),
            const SizedBox(height: 8),
            const Text('The RTO verifies the registration before it shows as verified.', style: TextStyle(fontSize: 12)),
          ]),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Add')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    await guarded(context, () => s.api.post('/public/vehicles', {
          'plate': plate.text.trim(),
          'vehicle_type': type,
          'make_model': make.text.trim().isEmpty ? null : make.text.trim(),
        }), success: 'Vehicle added - waiting for RTO verification');
    await _reload();
  }

  Future<void> _transfer(Map<String, dynamic> v) async {
    final f = await formDialog(context, 'Transfer ${v['plate']}', const [
      FormSpec('phone', "New owner's mobile number", phone: true),
      FormSpec('note', 'Note for the RTO (optional)', required: false, lines: 2),
    ], ok: 'Send request', note: 'The new owner must already use FEAR. The RTO desk reviews the transfer; '
        'the vehicle moves to their account once approved.');
    if (f == null || !mounted) return;
    await guarded(context, () => s.api.post('/public/requests', {
          'kind': 'transfer_vehicle',
          'vehicle_id': v['id'],
          'target_phone': f['phone'],
          'note': (f['note'] ?? '').isEmpty ? null : f['note'],
        }), success: 'Transfer requested - the RTO will review it');
    await _reload();
  }

  Future<void> _requestDeletion() async {
    final f = await formDialog(context, 'Delete my account?', const [
      FormSpec('note', 'Reason (optional)', required: false, lines: 2),
    ], ok: 'Request deletion', danger: true,
        note: 'FEAR reviews the request. Once approved, your name, number, address and vehicles are deleted and you are signed out; '
            'past SOS calls and reports stay on record without any link to you.');
    if (f == null || !mounted) return;
    await guarded(context, () => s.api.post('/public/requests', {'kind': 'delete_account', 'note': (f['note'] ?? '').isEmpty ? null : f['note']}),
        success: 'Deletion requested');
    await _reload();
  }

  Map<String, dynamic>? _pendingFor(String kind, {String? vehicleId}) => _requests
      .where((r) => r['kind'] == kind && r['status'] == 'pending' && (vehicleId == null || r['vehicle_id'] == vehicleId))
      .firstOrNull;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListenableBuilder(
      listenable: s,
      builder: (context, _) {
        final me = s.me;
        final deletion = _pendingFor('delete_account');
        return Scaffold(
          appBar: AppBar(title: const Text('Me')),
          body: RefreshIndicator(
            onRefresh: _reload,
            child: ListView(padding: const EdgeInsets.all(16), children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      const CircleAvatar(child: Icon(Icons.person)),
                      const SizedBox(width: 12),
                      Expanded(child: Text('${me['name'] ?? 'Add your name'}', style: theme.textTheme.titleMedium)),
                      IconButton(tooltip: 'Edit name and address', onPressed: _editDetails, icon: const Icon(Icons.edit)),
                    ]),
                    const SizedBox(height: 8),
                    _InfoRow(icon: Icons.phone_android, text: '${me['phone'] ?? '-'}'),
                    _InfoRow(icon: Icons.home_outlined, text: (me['address'] as String?)?.isNotEmpty == true ? me['address'] as String : 'No address yet'),
                    _InfoRow(icon: Icons.event_outlined, text: 'With FEAR since ${_date(me['createdAt'] as String?)}'),
                  ]),
                ),
              ),
              const SizedBox(height: 16),
              Text('Sign-in', style: theme.textTheme.titleMedium),
              Card(
                child: Column(children: [
                  ListTile(
                    leading: const Icon(Icons.password),
                    title: Text(me['hasPassword'] == true ? 'Change password' : 'Set a password'),
                    subtitle: Text(me['hasPassword'] == true ? 'You can sign in with your number and password' : 'Optional - otherwise you sign in with a code'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _password,
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.phonelink_setup),
                    title: const Text('Change mobile number'),
                    subtitle: const Text('Confirmed with a code sent to the new number'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _changePhone,
                  ),
                ]),
              ),
              const SizedBox(height: 16),
              Row(children: [
                Expanded(child: Text('My vehicles', style: theme.textTheme.titleMedium)),
                TextButton.icon(onPressed: _addVehicle, icon: const Icon(Icons.add), label: const Text('Add')),
              ]),
              if (_vehicles == null) const LinearProgressIndicator(),
              if (_vehicles != null && _vehicles!.isEmpty) const Text('No vehicles added.'),
              for (final v in _vehicles ?? const <Map<String, dynamic>>[]) _vehicleCard(v),
              if (_requests.isNotEmpty) ...[
                const SizedBox(height: 16),
                Text('My requests', style: theme.textTheme.titleMedium),
                for (final r in _requests)
                  Card(
                    child: ListTile(
                      leading: Icon(r['kind'] == 'delete_account' ? Icons.person_remove_outlined : Icons.swap_horiz),
                      title: Text(requestLabel(r['kind'] as String?)),
                      subtitle: Text([
                        if (r['plate'] != null) '${r['plate']} → ${r['target_phone']}',
                        'Asked ${fmtAgo(r['created_at'] as String?)}',
                        if (r['review_note'] != null) 'Reviewer: ${r['review_note']}',
                      ].join('\n')),
                      trailing: StatusPill(
                        switch (r['status']) { 'approved' => 'available', 'rejected' => 'rejected', _ => 'reported' },
                        label: titleCase(r['status'] as String? ?? ''),
                        dense: true,
                      ),
                    ),
                  ),
              ],
              const SizedBox(height: 16),
              Text('Privacy', style: theme.textTheme.titleMedium),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: me['shareTraffic'] == true,
                onChanged: (v) => guarded(context, () => s.setShareTraffic(v)),
                title: const Text('Share anonymous traffic speed'),
                subtitle: const Text('While the app is open and you are moving, your speed and position help FEAR see traffic. '
                    'Sent under a random tag that changes every 10 minutes - never linked to your account or stored.'),
              ),
              const ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.shield_outlined),
                title: Text('What Command can see'),
                subtitle: Text('Only what you send: the location of an SOS or report. For an SOS, your number goes only to the service '
                    'handling it, until it closes. FEAR keeps no location history of you.'),
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(onPressed: () => callEmergency(context), icon: const Icon(Icons.call), label: const Text('Call 112')),
              const SizedBox(height: 8),
              OutlinedButton.icon(onPressed: () => s.session.signOut(), icon: const Icon(Icons.logout), label: const Text('Sign out')),
              const SizedBox(height: 8),
              if (deletion != null)
                Text('Account deletion requested ${fmtAgo(deletion['created_at'] as String?)} - waiting for review.',
                    textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error))
              else
                TextButton(
                  style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
                  onPressed: _requestDeletion,
                  child: const Text('Request account deletion'),
                ),
              const SizedBox(height: 12),
              Text('Server: ${s.session.baseUrl}', style: theme.textTheme.bodySmall, textAlign: TextAlign.center),
            ]),
          ),
        );
      },
    );
  }

  Widget _vehicleCard(Map<String, dynamic> v) {
    final transfer = _pendingFor('transfer_vehicle', vehicleId: v['id'] as String?);
    return Card(
      child: ListTile(
        leading: Icon(vehicleTypeIcon(v['vehicle_type'] as String?)),
        title: Text('${v['plate']}', style: const TextStyle(fontWeight: FontWeight.w600, letterSpacing: 1)),
        subtitle: Text('${vehicleTypeLabel(v['vehicle_type'] as String?)}${v['make_model'] != null ? ' · ${v['make_model']}' : ''}'
            '${v['review_note'] != null ? '\nRTO: ${v['review_note']}' : ''}'
            '${transfer != null ? '\nTransfer to ${transfer['target_phone']} pending' : ''}'),
        isThreeLine: transfer != null || v['review_note'] != null,
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          StatusPill(
            switch (v['rto_status']) { 'verified' => 'available', 'rejected' => 'rejected', _ => 'reported' },
            label: switch (v['rto_status']) { 'verified' => 'RTO verified', 'rejected' => 'Rejected', _ => 'Pending' },
            dense: true,
          ),
          PopupMenuButton<String>(
            onSelected: (a) async {
              if (a == 'transfer') {
                await _transfer(v);
              } else if (a == 'remove') {
                if (!await confirm(context, 'Remove ${v['plate']}?', 'You can add it again later.')) return;
                if (!mounted) return;
                await guarded(context, () => s.api.delete('/public/vehicles/${v['id']}'));
                await _reload();
              }
            },
            itemBuilder: (_) => [
              PopupMenuItem(value: 'transfer', enabled: transfer == null, child: const ListTile(leading: Icon(Icons.swap_horiz), title: Text('Transfer to someone'))),
              const PopupMenuItem(value: 'remove', child: ListTile(leading: Icon(Icons.delete_outline), title: Text('Remove'))),
            ],
          ),
        ]),
      ),
    );
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.icon, required this.text});

  final IconData icon;
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Icon(icon, size: 18, color: Colors.black54),
        const SizedBox(width: 10),
        Expanded(child: Text(text)),
      ]),
    );
  }
}

String _date(String? iso) {
  final t = parseTime(iso);
  if (t == null) return '-';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return '${t.day} ${months[t.month - 1]} ${t.year}';
}

String vehicleTypeLabel(String? t) => switch (t) {
      'motorcycle' => 'Bike / motorcycle',
      'auto_rickshaw' => 'Auto-rickshaw',
      null => '-',
      _ => titleCase(t),
    };

IconData vehicleTypeIcon(String? t) => switch (t) {
      'motorcycle' || 'scooter' => Icons.two_wheeler,
      'bus' => Icons.directions_bus,
      'truck' => Icons.local_shipping,
      'auto_rickshaw' => Icons.electric_rickshaw,
      _ => Icons.directions_car,
    };
