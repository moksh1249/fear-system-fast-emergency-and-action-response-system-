import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'command_state.dart';
import 'phone_qr.dart';

/// The registration hierarchy: FEAR's super admin registers departments and
/// Command seats; each department's admin registers the organizations under
/// it, its vehicles, its drivers and who drives what.
class RegistryPage extends StatefulWidget {
  const RegistryPage({super.key, required this.state});

  final CommandState state;

  @override
  State<RegistryPage> createState() => _RegistryPageState();
}

class _RegistryPageState extends State<RegistryPage> {
  List<Map<String, dynamic>> _orgs = [], _users = [], _vehicles = [], _drivers = [];
  bool _loading = true;

  CommandState get s => widget.state;
  bool get superAdmin => s.role == 'super_admin';

  @override
  void initState() {
    super.initState();
    _load();
  }

  List<Map<String, dynamic>> _list(dynamic r) => (r as List).map((e) => Map<String, dynamic>.from(e as Map)).toList();

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      _orgs = _list(await s.api.get('/gov/orgs'));
      _users = _list(await s.api.get('/gov/users'));
      _vehicles = _list(await s.api.get('/gov/vehicles'));
      if (!superAdmin) _drivers = _list(await s.api.get('/gov/drivers'));
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.message, error: true);
    }
    if (mounted) setState(() => _loading = false);
  }

  String _orgName(String? id) => _orgs.where((o) => o['id'] == id).firstOrNull?['name'] as String? ?? '-';

  @override
  Widget build(BuildContext context) {
    final tabs = [
      const Tab(text: 'Organizations'),
      const Tab(text: 'Accounts'),
      const Tab(text: 'Vehicles'),
      if (!superAdmin) const Tab(text: 'Drivers'),
    ];
    return DefaultTabController(
      length: tabs.length,
      child: Column(children: [
        Row(children: [
          Expanded(child: TabBar(tabs: tabs, isScrollable: true)),
          IconButton(onPressed: _load, icon: const Icon(Icons.refresh)),
        ]),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : TabBarView(children: [
                  _orgsTab(),
                  _usersTab(),
                  _vehiclesTab(),
                  if (!superAdmin) _driversTab(),
                ]),
        ),
      ]),
    );
  }

  // ------------------------------------------------------------- organizations
  Widget _orgsTab() {
    final childKinds = Map<String, dynamic>.from(s.meta['childKinds'] as Map? ?? {});
    final roots = _orgs.where((o) => o['parent_id'] == null || !_orgs.any((p) => p['id'] == o['parent_id'])).toList();
    List<Widget> tree(Map<String, dynamic> o, int depth) => [
          ListTile(
            contentPadding: EdgeInsets.only(left: 16.0 + depth * 24, right: 8),
            leading: Icon(depth == 0 ? Icons.account_balance : Icons.subdirectory_arrow_right),
            title: Text('${o['name']}'),
            subtitle: Text('${o['kindLabel'] ?? o['kind']} · ${o['id']}'),
            trailing: Wrap(spacing: 8, crossAxisAlignment: WrapCrossAlignment.center, children: [
              StatusPill(o['verified'] == true ? 'available' : 'reported', label: o['verified'] == true ? 'Verified' : 'Awaiting FEAR verification', dense: true),
              if (superAdmin && o['kind'] != 'platform')
                TextButton(
                  onPressed: () async {
                    await guarded(context, () => s.api.post('/gov/orgs/${o['id']}/verify', {'verified': o['verified'] != true}));
                    await _load();
                  },
                  child: Text(o['verified'] == true ? 'Revoke' : 'Verify'),
                ),
              if (!superAdmin && ((childKinds[o['kind']] as List?)?.isNotEmpty ?? false))
                TextButton(onPressed: () => _createOrg(parent: o), child: const Text('Add under')),
            ]),
          ),
          for (final c in _orgs.where((c) => c['parent_id'] == o['id'])) ...tree(c, depth + 1),
        ];
    return ListView(padding: const EdgeInsets.symmetric(vertical: 12), children: [
      if (superAdmin)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.icon(onPressed: () => _createOrg(), icon: const Icon(Icons.add), label: const Text('Register department / organization')),
          ),
        ),
      for (final r in roots) ...tree(r, 0),
      Padding(
        padding: const EdgeInsets.all(16),
        child: Text(
          superAdmin
              ? 'Departments you register are verified. Organizations a department registers beneath itself (a hospital, a police station) '
                  'wait for your verification - until then their vehicles can\'t get emergency signal priority.'
              : 'Organizations you register beneath yours need FEAR\'s verification before their vehicles get emergency signal priority.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ),
    ]);
  }

  Future<void> _createOrg({Map<String, dynamic>? parent}) async {
    final kinds = Map<String, dynamic>.from(s.meta['orgKinds'] as Map? ?? {})..remove('platform');
    final childKinds = Map<String, dynamic>.from(s.meta['childKinds'] as Map? ?? {});
    final allowed = parent == null ? kinds.keys.toList() : List<String>.from(childKinds[parent['kind']] as List? ?? const []);
    if (allowed.isEmpty) return;
    var kind = allowed.first;
    final name = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text(parent == null ? 'Register organization' : 'Register under ${parent['name']}'),
          content: SizedBox(
            width: 400,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              DropdownButtonFormField<String>(
                initialValue: kind,
                decoration: const InputDecoration(labelText: 'Type'),
                items: [for (final k in allowed) DropdownMenuItem(value: k, child: Text('${kinds[k] ?? k}'))],
                onChanged: (v) => set(() => kind = v!),
              ),
              const SizedBox(height: 12),
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Official name')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Register')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    await guarded(context, () => s.api.post('/gov/orgs', {'name': name.text.trim(), 'kind': kind, 'parent_id': parent?['id']}), success: 'Organization registered');
    await _load();
    await s.refresh();
  }

  // ------------------------------------------------------------- accounts
  Widget _usersTab() {
    return ListView(padding: const EdgeInsets.all(12), children: [
      Wrap(spacing: 8, children: [
        if (superAdmin) FilledButton.icon(onPressed: () => _createUser('operator'), icon: const Icon(Icons.add), label: const Text('Command seat')),
        FilledButton.tonalIcon(onPressed: () => _createUser('org_admin'), icon: const Icon(Icons.add), label: const Text('Organization admin')),
      ]),
      const SizedBox(height: 12),
      for (final u in _users)
        Card(
          child: ListTile(
            leading: Icon(u['role'] == 'operator' ? Icons.headset_mic : (u['role'] == 'super_admin' ? Icons.admin_panel_settings : Icons.manage_accounts)),
            title: Text('${u['display_name']}  (${u['username']})'),
            subtitle: Text(u['role'] == 'operator'
                ? '${u['authorityLabel']}${u['org_name'] != null ? ' · ${u['org_name']}' : ''}'
                : '${titleCase(u['role'] as String)} · ${u['org_name'] ?? '-'}'),
            trailing: u['role'] == 'super_admin'
                ? null
                : Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
                    Switch(
                      value: u['active'] == true,
                      onChanged: (v) async {
                        await guarded(context, () => s.api.patch('/gov/users/${u['id']}', {'active': v}));
                        await _load();
                      },
                    ),
                    IconButton(
                      tooltip: 'Reset password',
                      icon: const Icon(Icons.key),
                      onPressed: () async {
                        if (!await confirm(context, 'Reset password?', 'A new password is generated and the account is signed out everywhere.')) return;
                        if (!mounted) return;
                        final r = await guarded(context, () => s.api.post('/gov/users/${u['id']}/reset-password'));
                        if (r != null && mounted) await showCredentials(context, 'New password', r as Map);
                      },
                    ),
                    if (u['role'] == 'org_admin' && u['active'] == true)
                      IconButton(
                        tooltip: 'Sign in their phone (QR)',
                        icon: const Icon(Icons.qr_code_2),
                        onPressed: () => signInEmployeePhone(context, s, u['username'] as String, '${u['display_name']}'),
                      ),
                    if (u['canRemove'] == true)
                      IconButton(
                        tooltip: 'Remove this account',
                        icon: Icon(Icons.person_remove, color: Theme.of(context).colorScheme.error),
                        onPressed: () async {
                          if (!await confirmRemove(context, '${u['display_name']} (${u['username']})')) return;
                          if (!mounted) return;
                          await guarded(context, () => s.api.delete('/gov/users/${u['id']}'), success: 'Account removed');
                          await _load();
                        },
                      ),
                  ]),
          ),
        ),
    ]);
  }

  Future<void> _createUser(String role) async {
    final authorities = Map<String, dynamic>.from(s.meta['authorities'] as Map? ?? {});
    final orgs = _orgs.where((o) => o['kind'] != 'platform').toList();
    var authority = authorities.keys.first;
    String? orgId = role == 'org_admin' && orgs.isNotEmpty ? orgs.first['id'] as String : null;
    final name = TextEditingController();
    final username = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: Text(role == 'operator' ? 'New Command seat' : 'New organization admin'),
          content: SizedBox(
            width: 420,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: name, decoration: const InputDecoration(labelText: 'Display name', hintText: 'e.g. Health Command - night shift')),
              const SizedBox(height: 12),
              TextField(controller: username, decoration: const InputDecoration(labelText: 'Username (optional)')),
              const SizedBox(height: 12),
              if (role == 'operator')
                DropdownButtonFormField<String>(
                  initialValue: authority,
                  decoration: const InputDecoration(labelText: 'Authority'),
                  items: [for (final e in authorities.entries) DropdownMenuItem(value: e.key, child: Text('${e.value}'))],
                  onChanged: (v) => set(() => authority = v!),
                ),
              if (role == 'operator') const SizedBox(height: 12),
              DropdownButtonFormField<String?>(
                initialValue: orgId,
                decoration: InputDecoration(labelText: role == 'operator' ? 'Organization (optional)' : 'Organization'),
                items: [
                  if (role == 'operator') const DropdownMenuItem<String?>(value: null, child: Text('-')),
                  for (final o in orgs) DropdownMenuItem<String?>(value: o['id'] as String, child: Text('${o['name']}')),
                ],
                onChanged: (v) => set(() => orgId = v),
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Create')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final r = await guarded(context, () => s.api.post('/gov/users', {
          'display_name': name.text.trim(),
          'role': role,
          'org_id': orgId,
          'authority': role == 'operator' ? authority : null,
          'username': username.text.trim().isEmpty ? null : username.text.trim(),
        }));
    if (r != null && mounted) await showCredentials(context, 'Account created', r as Map);
    await _load();
  }

  // ------------------------------------------------------------- vehicles
  Widget _vehiclesTab() {
    final orgCats = Map<String, dynamic>.from(s.meta['orgVehicleCategories'] as Map? ?? {});
    final canAdd = _orgs.any((o) => (orgCats[o['kind']] as List?)?.isNotEmpty ?? false);
    return ListView(padding: const EdgeInsets.all(12), children: [
      if (canAdd) Align(alignment: Alignment.centerLeft, child: FilledButton.icon(onPressed: _createVehicle, icon: const Icon(Icons.add), label: const Text('Register vehicle'))),
      const SizedBox(height: 12),
      if (_vehicles.isEmpty) const Text('No vehicles registered.'),
      for (final v in _vehicles)
        Card(
          child: ListTile(
            leading: CircleAvatar(backgroundColor: FearColors.category(v['category'] as String), child: Icon(FearIcons.category(v['category'] as String), color: Colors.white, size: 20)),
            title: Text('${v['id']} · ${v['plate']}'),
            subtitle: Text('${v['categoryLabel']} · ${v['org_name']}${v['make_model'] != null ? ' · ${v['make_model']}' : ''}\n'
                '${statusLabel(v['status'] as String?)}${!superAdmin ? ' · driver: ${_driverName(v['driver_id'] as String?)}' : ''}'),
            isThreeLine: true,
            trailing: Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              if (!superAdmin) TextButton(onPressed: () => _assign(v), child: const Text('Assign driver')),
              Switch(
                value: v['active'] == true,
                onChanged: (on) async {
                  await guarded(context, () => s.api.patch('/gov/vehicles/${v['id']}', {'active': on}));
                  await _load();
                },
              ),
              if (v['canRemove'] == true)
                IconButton(
                  tooltip: 'Remove this vehicle',
                  icon: Icon(Icons.delete_forever, color: Theme.of(context).colorScheme.error),
                  onPressed: () async {
                    if (!await confirmRemove(context, '${v['id']} · ${v['plate']}')) return;
                    if (!mounted) return;
                    await guarded(context, () => s.api.delete('/gov/vehicles/${v['id']}'), success: 'Vehicle removed');
                    await _load();
                  },
                ),
            ]),
          ),
        ),
    ]);
  }

  String _driverName(String? id) => id == null ? 'none' : (_drivers.where((d) => d['id'] == id).firstOrNull?['full_name'] as String? ?? id);

  Future<void> _createVehicle() async {
    final orgCats = Map<String, dynamic>.from(s.meta['orgVehicleCategories'] as Map? ?? {});
    final cats = Map<String, dynamic>.from(s.meta['vehicleCategories'] as Map? ?? {});
    final orgs = _orgs.where((o) => (orgCats[o['kind']] as List?)?.isNotEmpty ?? false).toList();
    var orgId = orgs.first['id'] as String;
    List<String> allowed() => List<String>.from(orgCats[orgs.firstWhere((o) => o['id'] == orgId)['kind']] as List);
    var category = allowed().first;
    final plate = TextEditingController();
    final make = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('Register vehicle'),
          content: SizedBox(
            width: 420,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              DropdownButtonFormField<String>(
                initialValue: orgId,
                decoration: const InputDecoration(labelText: 'Operating organization'),
                items: [for (final o in orgs) DropdownMenuItem(value: o['id'] as String, child: Text('${o['name']}'))],
                onChanged: (v) => set(() {
                  orgId = v!;
                  category = allowed().first;
                }),
              ),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                key: ValueKey(orgId),
                initialValue: category,
                decoration: const InputDecoration(labelText: 'Category'),
                items: [for (final c in allowed()) DropdownMenuItem(value: c, child: Text('${cats[c] ?? c}'))],
                onChanged: (v) => set(() => category = v!),
              ),
              const SizedBox(height: 12),
              TextField(controller: plate, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Registration plate', hintText: 'UP14 GA 1234')),
              const SizedBox(height: 12),
              TextField(controller: make, decoration: const InputDecoration(labelText: 'Make / model (optional)')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Register')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final r = await guarded(context, () => s.api.post('/gov/vehicles', {
          'org_id': orgId,
          'category': category,
          'plate': plate.text.trim(),
          'make_model': make.text.trim().isEmpty ? null : make.text.trim(),
        }));
    if (r != null && mounted) showSnack(context, 'Registered as ${(r as Map)['id']}');
    await _load();
  }

  Future<void> _assign(Map<String, dynamic> v) async {
    final candidates = _drivers.where((d) => d['active'] == true).toList();
    if (candidates.isEmpty) {
      showSnack(context, 'Add a driver first (Drivers tab).');
      return;
    }
    final picked = await showDialog<String>(
      context: context,
      builder: (ctx) => SimpleDialog(
        title: Text('Who drives ${v['id']}?'),
        children: [
          for (final d in candidates)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(ctx, d['id'] as String),
              child: ListTile(
                title: Text('${d['full_name']}'),
                subtitle: Text(d['vehicle_id'] != null ? 'currently ${d['vehicle_id']} - will be moved' : 'unassigned'),
              ),
            ),
          if (v['driver_id'] != null)
            SimpleDialogOption(onPressed: () => Navigator.pop(ctx, '__revoke'), child: const ListTile(leading: Icon(Icons.person_remove), title: Text('Revoke current assignment'))),
        ],
      ),
    );
    if (picked == null || !mounted) return;
    if (picked == '__revoke') {
      await guarded(context, () => s.api.post('/gov/assignments/revoke', {'vehicle_id': v['id'], 'driver_id': v['driver_id']}), success: 'Assignment revoked');
    } else {
      await guarded(context, () => s.api.post('/gov/assignments', {'vehicle_id': v['id'], 'driver_id': picked}), success: 'Driver assigned');
    }
    await _load();
  }

  // ------------------------------------------------------------- drivers (org admin only)
  Widget _driversTab() {
    return ListView(padding: const EdgeInsets.all(12), children: [
      Align(alignment: Alignment.centerLeft, child: FilledButton.icon(onPressed: _createDriver, icon: const Icon(Icons.person_add), label: const Text('Add driver'))),
      const SizedBox(height: 8),
      Text('Driver identities are visible to your organization only. Command sees the vehicle, not the person.', style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 12),
      for (final d in _drivers)
        Card(
          child: ListTile(
            leading: const Icon(Icons.person),
            title: Text('${d['full_name']}  (${d['username']})'),
            subtitle: Text('${d['phone']} · licence ${d['licence_no']} · ${_orgName(d['org_id'] as String?)}\n'
                'Vehicle: ${d['vehicle_id'] ?? 'none assigned'}'),
            isThreeLine: true,
            trailing: Wrap(spacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
              Switch(
                value: d['active'] == true,
                onChanged: (on) async {
                  // Driver accounts are gov_users too; switching one off blocks sign-in and priority at once.
                  await guarded(context, () => s.api.patch('/gov/users/${d['gov_user_id']}', {'active': on}));
                  await _load();
                },
              ),
              if (d['active'] == true)
                IconButton(
                  tooltip: 'Sign in their phone (QR)',
                  icon: const Icon(Icons.qr_code_2),
                  onPressed: () => signInEmployeePhone(context, s, d['username'] as String, '${d['full_name']}'),
                ),
              if (d['canRemove'] == true)
                IconButton(
                  tooltip: 'Remove this driver',
                  icon: Icon(Icons.person_remove, color: Theme.of(context).colorScheme.error),
                  onPressed: () async {
                    if (!await confirmRemove(context, '${d['full_name']} (${d['username']})')) return;
                    if (!mounted) return;
                    await guarded(context, () => s.api.delete('/gov/users/${d['gov_user_id']}'), success: 'Driver removed');
                    await _load();
                  },
                ),
            ]),
          ),
        ),
    ]);
  }

  Future<void> _createDriver() async {
    var orgId = _orgs.first['id'] as String;
    final name = TextEditingController(), phone = TextEditingController(), licence = TextEditingController(), address = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('Add driver'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                DropdownButtonFormField<String>(
                  initialValue: orgId,
                  decoration: const InputDecoration(labelText: 'Employing organization'),
                  items: [for (final o in _orgs) DropdownMenuItem(value: o['id'] as String, child: Text('${o['name']}'))],
                  onChanged: (v) => set(() => orgId = v!),
                ),
                const SizedBox(height: 12),
                TextField(controller: name, decoration: const InputDecoration(labelText: 'Full name')),
                const SizedBox(height: 12),
                TextField(controller: phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
                const SizedBox(height: 12),
                TextField(controller: licence, textCapitalization: TextCapitalization.characters, decoration: const InputDecoration(labelText: 'Driving licence number')),
                const SizedBox(height: 12),
                TextField(controller: address, decoration: const InputDecoration(labelText: 'Address (optional)')),
              ]),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Add')),
          ],
        ),
      ),
    );
    if (ok != true || !mounted) return;
    final r = await guarded(context, () => s.api.post('/gov/drivers', {
          'org_id': orgId,
          'full_name': name.text.trim(),
          'phone': phone.text.trim(),
          'licence_no': licence.text.trim(),
          'address': address.text.trim().isEmpty ? null : address.text.trim(),
        }));
    if (r != null && mounted) await showCredentials(context, 'Driver added - hand over these credentials', r as Map);
    await _load();
  }
}

Future<void> showCredentials(BuildContext context, String title, Map creds) {
  final text = 'Username: ${creds['username']}\nPassword: ${creds['password']}';
  return showDialog(
    context: context,
    barrierDismissible: false,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        KeyValue('Username', '${creds['username']}'),
        KeyValue('Password', '${creds['password']}'),
        const SizedBox(height: 8),
        const Text('The password is shown only once. Hand it over securely.', style: TextStyle(fontSize: 12)),
      ]),
      actions: [
        TextButton(
          onPressed: () {
            Clipboard.setData(ClipboardData(text: text));
            showSnack(ctx, 'Copied');
          },
          child: const Text('Copy'),
        ),
        FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done')),
      ],
    ),
  );
}
