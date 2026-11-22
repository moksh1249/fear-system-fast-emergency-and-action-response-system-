import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

/// "Me" for a driver: their details and vehicle, changing their password,
/// mobile number and address, and asking their organization to delete the
/// account (their organization's admin approves it in FEAR Command).
class DriverProfilePage extends StatefulWidget {
  const DriverProfilePage({super.key, required this.api});

  final ApiClient api;

  static Future<void> open(BuildContext context, ApiClient api) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => DriverProfilePage(api: api)));

  @override
  State<DriverProfilePage> createState() => _DriverProfilePageState();
}

class _DriverProfilePageState extends State<DriverProfilePage> {
  Map<String, dynamic>? _p;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final r = await widget.api.get('/gov/me/profile');
      if (mounted) setState(() => _p = Map<String, dynamic>.from(r as Map));
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Map<String, dynamic>? get _driver => (_p?['driver'] as Map?)?.cast<String, dynamic>();
  Map<String, dynamic>? get _vehicle => (_p?['vehicle'] as Map?)?.cast<String, dynamic>();
  List<Map<String, dynamic>> get _requests =>
      ((_p?['requests'] as List?) ?? const []).map((e) => Map<String, dynamic>.from(e as Map)).toList();

  Future<void> _editContact() async {
    final d = _driver ?? const {};
    final v = await formDialog(context, 'Contact details', [
      FormSpec('phone', 'Mobile number', initial: '${d['phone'] ?? ''}'.replaceFirst('+91', '').trim(), phone: true),
      FormSpec('address', 'Address', initial: d['address'] as String? ?? '', lines: 3),
    ]);
    if (v == null || !mounted) return;
    final r = await guarded(context, () => widget.api.patch('/gov/me/profile', {'phone': v['phone'], 'address': v['address']}), success: 'Saved');
    if (r != null && mounted) setState(() => _p = Map<String, dynamic>.from(r as Map));
  }

  Future<void> _password() async {
    final v = await formDialog(context, 'Change password', const [
      FormSpec('current', 'Current password', obscure: true),
      FormSpec('new', 'New password', obscure: true),
      FormSpec('again', 'New password again', obscure: true),
    ], note: 'At least 8 characters, with letters and numbers.');
    if (v == null || !mounted) return;
    if (v['new'] != v['again']) {
      showSnack(context, 'The two new passwords are different.', error: true);
      return;
    }
    await guarded(context, () => widget.api.post('/gov/me/password', {'current_password': v['current'], 'new_password': v['new']}),
        success: 'Password changed');
  }

  Future<void> _requestDeletion() async {
    final v = await formDialog(context, 'Delete my account?', const [FormSpec('note', 'Reason (optional)', required: false, lines: 2)],
        ok: 'Request deletion',
        danger: true,
        note: "Your organization's admin reviews this. Once approved, this login stops working and you are taken off the vehicle.");
    if (v == null || !mounted) return;
    await guarded(context, () => widget.api.post('/gov/me/requests', {'kind': 'delete_account', 'note': (v['note'] ?? '').isEmpty ? null : v['note']}),
        success: 'Deletion requested');
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final p = _p;
    final d = _driver;
    final veh = _vehicle;
    final pendingDeletion = _requests.any((r) => r['kind'] == 'delete_account' && r['status'] == 'pending');
    return Scaffold(
      appBar: AppBar(title: const Text('Me')),
      body: p == null
          ? Center(child: _error != null ? Text(_error!) : const CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: _load,
              child: ListView(padding: const EdgeInsets.all(16), children: [
                Card(
                  child: ListTile(
                    leading: const CircleAvatar(child: Icon(Icons.badge_outlined)),
                    title: Text('${d?['fullName'] ?? p['displayName']}', style: theme.textTheme.titleMedium),
                    subtitle: Text('${p['orgName'] ?? ''}\nSign-in: ${p['username']}'),
                    isThreeLine: true,
                  ),
                ),
                if (veh != null)
                  Card(
                    child: ListTile(
                      leading: Icon(FearIcons.category(veh['category'] as String?), color: FearColors.category(veh['category'] as String?)),
                      title: Text('${veh['id']} · ${veh['plate']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: Text('${veh['categoryLabel']}${veh['makeModel'] != null ? ' · ${veh['makeModel']}' : ''}'),
                    ),
                  ),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(child: Text('Contact', style: theme.textTheme.titleMedium)),
                  if (d != null) TextButton.icon(onPressed: _editContact, icon: const Icon(Icons.edit, size: 18), label: const Text('Edit')),
                ]),
                Card(
                  child: Column(children: [
                    ListTile(leading: const Icon(Icons.phone_android), title: Text('${d?['phone'] ?? '-'}')),
                    const Divider(height: 1),
                    ListTile(leading: const Icon(Icons.home_outlined), title: Text((d?['address'] as String?)?.isNotEmpty == true ? d!['address'] as String : 'No address')),
                  ]),
                ),
                const SizedBox(height: 12),
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.password),
                    title: const Text('Change password'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: _password,
                  ),
                ),
                if (_requests.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Text('My requests', style: theme.textTheme.titleMedium),
                  for (final r in _requests)
                    Card(
                      child: ListTile(
                        leading: const Icon(Icons.person_remove_outlined),
                        title: Text(requestLabel(r['kind'] as String?)),
                        subtitle: Text('Asked ${fmtAgo(r['created_at'] as String?)}${r['review_note'] != null ? '\nReviewer: ${r['review_note']}' : ''}'),
                        trailing: StatusPill(
                          switch (r['status']) { 'approved' => 'available', 'rejected' => 'rejected', _ => 'reported' },
                          label: titleCase(r['status'] as String? ?? ''),
                          dense: true,
                        ),
                      ),
                    ),
                ],
                const SizedBox(height: 16),
                if (d != null)
                  pendingDeletion
                      ? Text('Account deletion requested - waiting for your organization.', textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error))
                      : TextButton(
                          style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
                          onPressed: _requestDeletion,
                          child: const Text('Request account deletion'),
                        ),
              ]),
            ),
    );
  }
}
