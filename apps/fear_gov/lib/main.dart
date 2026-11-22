import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'command/command_shell.dart';
import 'driver/driver_home.dart';
import 'login_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const FearCommandApp());
}

/// FEAR Command - the government app. One app, chosen by the signed-in
/// account's role: the Command & Control / administration dashboard (on the
/// web, served by the backend at /command, or on a tablet), or the emergency
/// driver screen on a phone.
class FearCommandApp extends StatefulWidget {
  const FearCommandApp({super.key});

  @override
  State<FearCommandApp> createState() => _FearCommandAppState();
}

class _FearCommandAppState extends State<FearCommandApp> {
  final session = Session('gov');

  @override
  void initState() {
    super.initState();
    session.init();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FEAR Command',
      debugShowCheckedModeBanner: false,
      theme: fearTheme(brightness: Brightness.light, seed: const Color(0xFF1E3A5F)),
      darkTheme: fearTheme(brightness: Brightness.dark, seed: const Color(0xFF1E3A5F)),
      themeMode: ThemeMode.dark,
      home: ListenableBuilder(
        listenable: session,
        builder: (context, _) {
          if (!session.connected) {
            return ServerScreen(session: session, appName: 'FEAR Command', logo: const CommandLogo());
          }
          if (!session.signedIn) return LoginScreen(session: session);
          final role = session.profile!['role'] as String?;
          if (role == 'driver') return DriverHome(key: ValueKey('${session.token}@${session.baseUrl}'), session: session);
          return CommandShell(key: ValueKey('${session.token}@${session.baseUrl}'), session: session);
        },
      ),
    );
  }
}

class CommandLogo extends StatelessWidget {
  const CommandLogo({super.key, this.size = 64});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: FearColors.brand, borderRadius: BorderRadius.circular(size * 0.22)),
        child: Icon(Icons.shield, color: Colors.white, size: size * 0.6),
      ),
    );
  }
}
