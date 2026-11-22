import 'package:fear_core/fear_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'main.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.session});

  final Session session;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _user = TextEditingController();
  final _pass = TextEditingController();
  bool _busy = false;
  bool _obscure = true;
  String? _error;

  @override
  void dispose() {
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_user.text.trim().isEmpty || _pass.text.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final res = await widget.session.api.post('/gov/auth/login', {'username': _user.text.trim(), 'password': _pass.text});
      await widget.session.signIn(res['token'] as String, Map<String, dynamic>.from(res['user'] as Map));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.session;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: ListView(padding: const EdgeInsets.all(24), shrinkWrap: true, children: [
              const CommandLogo(),
              const SizedBox(height: 16),
              Text('FEAR Command', textAlign: TextAlign.center, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 4),
              Text('Government & emergency services', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodyMedium),
              const SizedBox(height: 28),
              if (s.sessionExpired)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text('Your session ended - please sign in again.', textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.tertiary)),
                ),
              TextField(
                controller: _user,
                autocorrect: false,
                textInputAction: TextInputAction.next,
                decoration: const InputDecoration(labelText: 'Username', prefixIcon: Icon(Icons.badge_outlined)),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: _pass,
                obscureText: _obscure,
                onSubmitted: (_) => _submit(),
                decoration: InputDecoration(
                  labelText: 'Password',
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off), onPressed: () => setState(() => _obscure = !_obscure)),
                ),
              ),
              if (_error != null) ...[
                const SizedBox(height: 12),
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 20),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: _busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Sign in'),
                ),
              ),
              if (!kIsWeb) ...[
                const SizedBox(height: 10),
                OutlinedButton.icon(
                  onPressed: () => QrScanScreen.open(context, title: 'Scan FEAR QR code', onCode: s.enrollFromQr),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Padding(padding: EdgeInsets.symmetric(vertical: 10), child: Text('Sign in with a QR code')),
                ),
              ],
              const SizedBox(height: 24),
              Text(
                'Accounts are issued by your organization\'s FEAR administrator. Drivers sign in with the credentials their organization gave them.',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 8),
              TextButton(onPressed: s.forgetServer, child: Text('Server: ${s.baseUrl}  (change)', style: Theme.of(context).textTheme.bodySmall)),
            ]),
          ),
        ),
      ),
    );
  }
}
