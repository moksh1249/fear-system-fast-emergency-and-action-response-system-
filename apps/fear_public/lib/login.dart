import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'main.dart';

/// Mobile number + one-time code - or, for anyone who set one on the Me
/// screen, mobile number + password.
class OtpLoginScreen extends StatefulWidget {
  const OtpLoginScreen({super.key, required this.session});

  final Session session;

  @override
  State<OtpLoginScreen> createState() => _OtpLoginScreenState();
}

class _OtpLoginScreenState extends State<OtpLoginScreen> {
  final _phone = TextEditingController();
  final _code = TextEditingController();
  final _name = TextEditingController();
  final _password = TextEditingController();
  bool _usePassword = true; // mobile number + password first; a one-time code for new accounts
  String? _sentTo;
  bool _devMode = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    _name.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _request() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.session.api.post('/public/auth/otp/request', {'phone': _phone.text});
      setState(() {
        _sentTo = (r as Map)['phone'] as String;
        _devMode = r['devMode'] == true;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.session.api.post('/public/auth/otp/verify', {
        'phone': _sentTo,
        'code': _code.text.trim(),
        'name': _name.text.trim().isEmpty ? null : _name.text.trim(),
      });
      await widget.session.signIn((r as Map)['token'] as String, Map<String, dynamic>.from(r['me'] as Map));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _passwordLogin() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final r = await widget.session.api.post('/public/auth/login', {'phone': _phone.text, 'password': _password.text});
      await widget.session.signIn((r as Map)['token'] as String, Map<String, dynamic>.from(r['me'] as Map));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: ListView(padding: const EdgeInsets.all(24), shrinkWrap: true, children: [
              const FearLogo(),
              const SizedBox(height: 16),
              Text('Fast Emergency and Action Response', textAlign: TextAlign.center, style: theme.textTheme.titleMedium),
              const SizedBox(height: 28),
              if (_sentTo == null) ...[
                TextField(
                  controller: _phone,
                  keyboardType: TextInputType.phone,
                  inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9+ ]'))],
                  decoration: const InputDecoration(labelText: 'Mobile number', prefixText: '+91 ', prefixIcon: Icon(Icons.phone_android)),
                  onSubmitted: (_) => _usePassword ? null : _request(),
                ),
                if (_usePassword) ...[
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Password', prefixIcon: Icon(Icons.password)),
                    onSubmitted: (_) => _passwordLogin(),
                  ),
                ],
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : (_usePassword ? _passwordLogin : _request),
                  child: Padding(padding: const EdgeInsets.symmetric(vertical: 12), child: Text(_usePassword ? 'Sign in' : 'Send code')),
                ),
                TextButton(
                  onPressed: _busy ? null : () => setState(() {
                    _usePassword = !_usePassword;
                    _error = null;
                  }),
                  child: Text(_usePassword ? 'New to FEAR, or no password yet? Use a one-time code' : 'I have a password - sign in with it'),
                ),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () => QrScanScreen.open(context, title: 'Scan FEAR QR code', onCode: widget.session.enrollFromQr),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('Got a QR code? Scan it'),
                ),
              ] else ...[
                Text('Enter the 6-digit code sent to $_sentTo', textAlign: TextAlign.center),
                if (_devMode)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Development server: the code is shown in the FEAR server console, not texted.',
                        textAlign: TextAlign.center, style: theme.textTheme.bodySmall?.copyWith(color: FearColors.demo)),
                  ),
                const SizedBox(height: 16),
                TextField(
                  controller: _code,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  autofocus: true,
                  textAlign: TextAlign.center,
                  style: const TextStyle(fontSize: 24, letterSpacing: 8),
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(counterText: '', hintText: '------'),
                ),
                const SizedBox(height: 12),
                TextField(controller: _name, textCapitalization: TextCapitalization.words, decoration: const InputDecoration(labelText: 'Your name (optional)')),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: _busy ? null : _verify,
                  child: const Padding(padding: EdgeInsets.symmetric(vertical: 12), child: Text('Verify & continue')),
                ),
                TextButton(onPressed: _busy ? null : () => setState(() => _sentTo = null), child: const Text('Use a different number')),
              ],
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error)),
              ],
              const SizedBox(height: 24),
              Text(
                'FEAR uses your location only while you use navigation or call for help. Command never sees your location history.',
                textAlign: TextAlign.center,
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: 16),
              OutlinedButton.icon(
                style: OutlinedButton.styleFrom(foregroundColor: FearColors.brand),
                onPressed: () => callEmergency(context),
                icon: const Icon(Icons.call),
                label: const Text('Emergency? Call 112 now'),
              ),
              TextButton(
                onPressed: widget.session.forgetServer,
                child: Text('Server: ${widget.session.baseUrl}  (change)', style: theme.textTheme.bodySmall),
              ),
            ]),
          ),
        ),
      ),
    );
  }
}

/// Opens the phone dialer on 112 - the fallback that works anywhere.
Future<void> callEmergency(BuildContext context) async {
  final ok = await launchUrl(Uri.parse('tel:112'));
  if (!ok && context.mounted) showSnack(context, 'Dial 112 from your phone.', error: true);
}
