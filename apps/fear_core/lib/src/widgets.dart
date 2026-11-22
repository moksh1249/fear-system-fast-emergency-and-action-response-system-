import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'api.dart';
import 'format.dart';
import 'location.dart';
import 'scanner.dart';
import 'server.dart';
import 'session.dart';
import 'theme.dart';

void showSnack(BuildContext context, String message, {bool error = false}) {
  final messenger = ScaffoldMessenger.maybeOf(context);
  messenger?.hideCurrentSnackBar();
  messenger?.showSnackBar(SnackBar(
    content: Text(message),
    backgroundColor: error ? Theme.of(context).colorScheme.error : null,
  ));
}

/// Runs [action], turning an [ApiException] into a snackbar. Returns the
/// result, or null if it failed.
Future<T?> guarded<T>(BuildContext context, Future<T> Function() action, {String? success}) async {
  try {
    final r = await action();
    if (success != null && context.mounted) showSnack(context, success);
    return r;
  } on ApiException catch (e) {
    if (context.mounted) showSnack(context, e.message, error: true);
  } catch (e) {
    if (context.mounted) showSnack(context, 'Something went wrong: $e', error: true);
  }
  return null;
}

Future<bool> confirm(BuildContext context, String title, String body, {String ok = 'Confirm', bool danger = false}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error) : null,
          onPressed: () => Navigator.pop(ctx, true),
          child: Text(ok),
        ),
      ],
    ),
  );
  return r ?? false;
}

/// One text field in a [formDialog].
class FormSpec {
  const FormSpec(this.key, this.label,
      {this.initial = '', this.hint, this.obscure = false, this.phone = false, this.lines = 1, this.required = true, this.caps = false});

  final String key;
  final String label;
  final String initial;
  final String? hint;
  final bool obscure;
  final bool phone;
  final int lines;
  final bool required;
  final bool caps;
}

/// A small form in a dialog: returns each field's trimmed text by key, or
/// null if cancelled. OK stays disabled until every required field has text.
Future<Map<String, String>?> formDialog(BuildContext context, String title, List<FormSpec> fields,
    {String ok = 'Save', String? note, bool danger = false}) async {
  final ctls = {for (final f in fields) f.key: TextEditingController(text: f.initial)};
  final r = await showDialog<Map<String, String>>(
    context: context,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) {
        final complete = fields.every((f) => !f.required || ctls[f.key]!.text.trim().isNotEmpty);
        return AlertDialog(
          title: Text(title),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              for (final f in fields) ...[
                TextField(
                  controller: ctls[f.key],
                  obscureText: f.obscure,
                  maxLines: f.obscure ? 1 : f.lines,
                  keyboardType: f.phone ? TextInputType.phone : (f.lines > 1 ? TextInputType.multiline : TextInputType.text),
                  textCapitalization: f.caps ? TextCapitalization.characters : TextCapitalization.sentences,
                  autofocus: f == fields.first,
                  onChanged: (_) => set(() {}),
                  decoration: InputDecoration(labelText: f.label, hintText: f.hint, prefixText: f.phone ? '+91 ' : null),
                ),
                const SizedBox(height: 10),
              ],
              if (note != null) Text(note, style: Theme.of(ctx).textTheme.bodySmall),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(
              style: danger ? FilledButton.styleFrom(backgroundColor: Theme.of(ctx).colorScheme.error) : null,
              onPressed: complete ? () => Navigator.pop(ctx, {for (final e in ctls.entries) e.key: e.value.text.trim()}) : null,
              child: Text(ok),
            ),
          ],
        );
      },
    ),
  );
  // (not disposed here: the dialog's closing animation still shows the fields)
  return r;
}

/// Incident severity as triage rates it (1-5).
const severityLabels = {1: 'Minor', 2: 'Moderate', 3: 'Serious', 4: 'Severe', 5: 'Critical'};

Color severityColor(int score) => switch (score) {
      1 => const Color(0xFF2A9D8F),
      2 => const Color(0xFFE9C46A),
      3 => const Color(0xFFF4A261),
      4 => const Color(0xFFE76F51),
      _ => const Color(0xFF9D0208),
    };

class SeverityChip extends StatelessWidget {
  const SeverityChip({super.key, required this.score, this.dense = false});

  final int? score;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final s = score;
    if (s == null) return const SizedBox.shrink();
    final c = severityColor(s);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 6 : 10, vertical: dense ? 1 : 4),
      decoration: BoxDecoration(color: c, borderRadius: BorderRadius.circular(20)),
      child: Text('${severityLabels[s] ?? s}${dense ? '' : ' · $s/5'}',
          style: TextStyle(color: s == 2 || s == 3 ? Colors.black87 : Colors.white, fontWeight: FontWeight.w800, fontSize: dense ? 10 : 12)),
    );
  }
}

/// Account requests (deletion, vehicle transfer) as people see them.
String requestLabel(String? kind) => switch (kind) {
      'delete_account' => 'Delete my account',
      'transfer_vehicle' => 'Transfer vehicle',
      _ => titleCase(kind ?? ''),
    };

class StatusPill extends StatelessWidget {
  const StatusPill(this.status, {super.key, this.label, this.dense = false});

  final String? status;
  final String? label;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final c = FearColors.status(status);
    return Container(
      padding: EdgeInsets.symmetric(horizontal: dense ? 6 : 10, vertical: dense ? 2 : 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.14), borderRadius: BorderRadius.circular(20), border: Border.all(color: c.withValues(alpha: 0.6))),
      child: Text(label ?? statusLabel(status),
          style: TextStyle(color: c, fontWeight: FontWeight.w600, fontSize: dense ? 11 : 12)),
    );
  }
}

/// Always-visible marker that positions are simulated, not from GPS.
class DemoBadge extends StatelessWidget {
  const DemoBadge({super.key, this.text = 'DEMO LOCATION'});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: FearColors.demo, borderRadius: BorderRadius.circular(4)),
      child: Text(text, style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 0.5)),
    );
  }
}

/// Explains why there's no position yet and offers the fix.
class LocationNotice extends StatelessWidget {
  const LocationNotice({super.key, required this.location, this.onUseDemo});

  final LocationService location;
  final VoidCallback? onUseDemo;

  @override
  Widget build(BuildContext context) {
    final s = location.status;
    if (s == LocationStatus.ok || s == LocationStatus.off) return const SizedBox.shrink();
    final text = location.message ?? (s == LocationStatus.starting ? 'Getting your location...' : 'Location unavailable');
    return Material(
      color: Theme.of(context).colorScheme.secondaryContainer,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(children: [
          Icon(s == LocationStatus.starting ? Icons.gps_not_fixed : Icons.location_off, size: 20),
          const SizedBox(width: 10),
          Expanded(child: Text(text)),
          if (s == LocationStatus.permissionDenied || s == LocationStatus.serviceDisabled)
            TextButton(
              onPressed: location.requestAgain,
              child: Text(s == LocationStatus.serviceDisabled || location.blocked ? 'Open settings' : 'Allow location'),
            ),
          if (onUseDemo != null && !location.demoMode) TextButton(onPressed: onUseDemo, child: const Text('Demo')),
        ]),
      ),
    );
  }
}

/// Shown when the device's real position is outside the mapped area.
class OutOfCoverageNotice extends StatelessWidget {
  const OutOfCoverageNotice({super.key, required this.onShowMap});

  final VoidCallback onShowMap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.tertiaryContainer,
      borderRadius: BorderRadius.circular(10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(children: [
          const Icon(Icons.wrong_location_outlined, size: 20),
          const SizedBox(width: 10),
          const Expanded(
            child: Text('You are outside the area FEAR has mapped, so your position is not on a FEAR road yet. '
                'The FEAR admin can add this area from an OpenStreetMap export.'),
          ),
          TextButton(onPressed: onShowMap, child: const Text('Show mapped area')),
        ]),
      ),
    );
  }
}

class KeyValue extends StatelessWidget {
  const KeyValue(this.k, this.v, {super.key});

  final String k;
  final String? v;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 130, child: Text(k, style: TextStyle(color: Theme.of(context).hintColor))),
        Expanded(child: SelectableText(v ?? '--')),
      ]),
    );
  }
}

/// Finding / choosing the FEAR server. Shown until [Session.connected].
class ServerScreen extends StatefulWidget {
  const ServerScreen({super.key, required this.session, required this.appName, this.logo});

  final Session session;
  final String appName;
  final Widget? logo;

  @override
  State<ServerScreen> createState() => _ServerScreenState();
}

class _ServerScreenState extends State<ServerScreen> {
  final _addr = TextEditingController();
  Timer? _retry;

  @override
  void initState() {
    super.initState();
    // Still signed in: keep looking for the server on its own.
    _retry = Timer.periodic(const Duration(seconds: 10), (_) {
      final s = widget.session;
      if (s.token != null && !s.loading && !s.connected) s.connect();
    });
  }

  @override
  void dispose() {
    _retry?.cancel();
    _addr.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: ListView(padding: const EdgeInsets.all(24), shrinkWrap: true, children: [
              if (widget.logo != null) widget.logo!,
              const SizedBox(height: 12),
              Text(widget.appName, textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 24),
              if (s.token != null && s.profile != null) ...[
                Card(
                  child: ListTile(
                    leading: const Icon(Icons.verified_user),
                    title: Text('Still signed in as ${s.profile!['displayName'] ?? s.profile!['name'] ?? s.profile!['username'] ?? s.profile!['phone'] ?? 'you'}'),
                    subtitle: const Text('Reconnecting to the FEAR server on its own - no need to sign in again.'),
                  ),
                ),
                const SizedBox(height: 12),
              ],
              if (s.loading) ...[
                const Center(child: CircularProgressIndicator()),
                const SizedBox(height: 16),
                Text('Connecting to FEAR (${ServerLocator.publicServer.replaceFirst('https://', '')})...', textAlign: TextAlign.center),
              ] else ...[
                if (s.connectError != null)
                  Text(s.connectError!, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 16),
                if (!kIsWeb) ...[
                  FilledButton.icon(
                    onPressed: () => QrScanScreen.open(context, title: 'Scan FEAR QR code', onCode: s.enrollFromQr),
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('Scan QR code'),
                  ),
                  const SizedBox(height: 8),
                ],
                OutlinedButton.icon(onPressed: () => s.connect(), icon: const Icon(Icons.wifi_find), label: const Text('Search again')),
                const SizedBox(height: 24),
                TextField(
                  controller: _addr,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(labelText: 'Server address', hintText: '192.168.1.20:8080'),
                  onSubmitted: (v) => s.connect(manual: v),
                ),
                const SizedBox(height: 8),
                OutlinedButton(onPressed: () => s.connect(manual: _addr.text), child: const Text('Connect')),
                const SizedBox(height: 16),
                if (!kIsWeb)
                  Text(
                    'Scan the QR code from the Phones panel in FEAR Command, or type the address it shows '
                    '(e.g. 10.12.46.54:8080 on the same Wi-Fi, or the https link when the server is public).',
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
              ],
            ]),
          ),
        ),
      ),
    );
  }
}
