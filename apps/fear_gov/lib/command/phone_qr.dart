import 'dart:convert';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'command_state.dart';

/// A sign-in QR code on screen: the phone's FEAR app scans it, finds this
/// server (Wi-Fi first, then the public link) and signs in - no new account,
/// no password typed. Single use, valid 30 minutes.
Future<void> showPhoneQr(BuildContext context, Map enrollment, {required String title, String? subtitle}) {
  final e = Map<String, dynamic>.from(enrollment);
  final payload = jsonEncode(e['payload']);
  final app = e['app'] == 'gov' ? 'the FEAR Command app' : 'the FEAR app';
  return showDialog(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: SizedBox(
        width: 340,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (subtitle != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(subtitle, textAlign: TextAlign.center)),
          Container(
            color: Colors.white,
            padding: const EdgeInsets.all(10),
            child: QrImageView(data: payload, size: 260, backgroundColor: Colors.white),
          ),
          const SizedBox(height: 10),
          Text('Open $app on the phone and tap "Scan QR code". Works on this Wi-Fi or anywhere on the internet. Single use · valid 30 minutes.',
              textAlign: TextAlign.center, style: Theme.of(ctx).textTheme.bodySmall),
          if (e['publicError'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('Internet link unavailable (${e['publicError']}) - this QR works on the same Wi-Fi only.',
                  textAlign: TextAlign.center, style: TextStyle(color: Theme.of(ctx).colorScheme.error, fontSize: 12)),
            ),
          const SizedBox(height: 4),
          Text('Server: ${(e['servers'] as List?)?.join('  or  ') ?? ''}', textAlign: TextAlign.center, style: Theme.of(ctx).textTheme.bodySmall),
        ]),
      ),
      actions: [FilledButton(onPressed: () => Navigator.pop(ctx), child: const Text('Done'))],
    ),
  );
}

/// "Sign in on my phone": the account signed in here, on a phone.
Future<void> signInMyPhone(BuildContext context, CommandState s) async {
  final r = await guarded(context, () => s.api.post('/gov/phones', {'kind': 'self'}));
  if (r == null || !context.mounted) return;
  await showPhoneQr(context, (r as Map)['enrollment'] as Map,
      title: 'Sign in on my phone', subtitle: 'Signs your phone in as ${s.profile['displayName']} (${s.profile['username']}).');
}

/// An existing employee's phone (by username), straight from a list row.
Future<void> signInEmployeePhone(BuildContext context, CommandState s, String username, String name) async {
  final r = await guarded(context, () => s.api.post('/gov/phones', {'kind': 'existing_user', 'username': username}));
  if (r == null || !context.mounted) return;
  await showPhoneQr(context, (r as Map)['enrollment'] as Map, title: 'Sign in $name\'s phone', subtitle: 'Existing account $username - nothing new is created.');
}

/// Signs an existing person's phone in: an employee by username, or a FEAR
/// app user by mobile number. No new account is made.
Future<void> signInExistingPhone(BuildContext context, CommandState s) async {
  var who = 'employee';
  final v = await showDialog<Map<String, String>>(
    context: context,
    builder: (ctx) {
      final ctl = TextEditingController();
      return StatefulBuilder(
        builder: (ctx, set) => AlertDialog(
          title: const Text('Sign in an existing account on a phone'),
          content: SizedBox(
            width: 380,
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(value: 'employee', label: Text('Employee / driver'), icon: Icon(Icons.badge)),
                  ButtonSegment(value: 'citizen', label: Text('FEAR app user'), icon: Icon(Icons.person)),
                ],
                selected: {who},
                onSelectionChanged: (x) => set(() => who = x.first),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: ctl,
                autofocus: true,
                keyboardType: who == 'citizen' ? TextInputType.phone : TextInputType.text,
                decoration: InputDecoration(
                  labelText: who == 'citizen' ? 'Their mobile number' : 'Their username',
                  prefixText: who == 'citizen' ? '+91 ' : null,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                who == 'citizen'
                    ? 'For someone already using the FEAR app. The control room and FEAR\'s admin can do this.'
                    : 'Drivers and admins of your organization or those below it.',
                style: Theme.of(ctx).textTheme.bodySmall,
              ),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, {'who': who, 'value': ctl.text.trim()}), child: const Text('Make QR code')),
          ],
        ),
      );
    },
  );
  if (v == null || (v['value'] ?? '').isEmpty || !context.mounted) return;
  final body = v['who'] == 'citizen' ? {'kind': 'existing_citizen', 'phone': v['value']} : {'kind': 'existing_user', 'username': v['value']};
  final r = await guarded(context, () => s.api.post('/gov/phones', body));
  if (r == null || !context.mounted) return;
  await showPhoneQr(context, (r as Map)['enrollment'] as Map,
      title: 'Phone sign-in', subtitle: '${(r['enrollment'] as Map)['label']} - existing account, nothing new is created.');
}

/// Confirms and removes an employee account or a vehicle (see staff.py on
/// the server: deactivated, personal data erased, history kept).
Future<bool> confirmRemove(BuildContext context, String what) => confirm(
      context,
      'Remove $what?',
      'Sign-in stops on every device at once and it disappears from every list and the map. Name, phone and address are erased. '
          'Past incidents keep the vehicle ID for the record. This cannot be undone.',
      ok: 'Remove',
      danger: true,
    );
