import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'home.dart';
import 'login.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const FearPublicApp());
}

/// FEAR - the public app: navigation, SOS, reports, nearby emergency
/// vehicle alerts and Command's public alerts.
class FearPublicApp extends StatefulWidget {
  const FearPublicApp({super.key});

  @override
  State<FearPublicApp> createState() => _FearPublicAppState();
}

class _FearPublicAppState extends State<FearPublicApp> {
  final session = Session('public');

  @override
  void initState() {
    super.initState();
    session.init();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'FEAR',
      debugShowCheckedModeBanner: false,
      theme: fearTheme(brightness: Brightness.light),
      darkTheme: fearTheme(brightness: Brightness.dark),
      home: ListenableBuilder(
        listenable: session,
        builder: (context, _) {
          if (!session.connected) return ServerScreen(session: session, appName: 'FEAR', logo: const FearLogo());
          if (!session.signedIn) return OtpLoginScreen(session: session);
          return PublicHome(key: ValueKey('${session.token}@${session.baseUrl}'), session: session);
        },
      ),
    );
  }
}

class FearLogo extends StatelessWidget {
  const FearLogo({super.key, this.size = 72});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: size,
        height: size,
        decoration: const BoxDecoration(color: FearColors.brand, shape: BoxShape.circle),
        child: Center(
          child: Text('FEAR', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w900, fontSize: size * 0.24, letterSpacing: 1)),
        ),
      ),
    );
  }
}
