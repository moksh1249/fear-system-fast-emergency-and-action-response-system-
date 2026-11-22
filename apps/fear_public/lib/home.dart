import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'map_tab.dart';
import 'public_state.dart';
import 'tabs.dart';

class PublicHome extends StatefulWidget {
  const PublicHome({super.key, required this.session});

  final Session session;

  @override
  State<PublicHome> createState() => _PublicHomeState();
}

class _PublicHomeState extends State<PublicHome> {
  late final PublicState state = PublicState(widget.session);
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    state.start();
    WidgetsBinding.instance.addPostFrameCallback((_) => _askTrafficConsent());
  }

  /// Once per install: say that the phone shares its position anonymously
  /// (on by default - it is what lets the traffic lights respond to real
  /// traffic), and offer to turn it off.
  Future<void> _askTrafficConsent() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool('fear.public.askedTraffic') == true || !mounted) return;
    await prefs.setBool('fear.public.askedTraffic', true);
    if (!mounted) return;
    final keep = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        icon: const Icon(Icons.traffic),
        title: const Text('FEAR shares your position anonymously'),
        content: const Text('While the app is open, your position and speed go to FEAR under a random tag that changes every '
            '10 minutes - never linked to your account and never stored. The traffic lights use it to give green to the '
            'busiest roads and to clear the way for ambulances. You can turn this off any time under Me.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Turn off')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('OK')),
        ],
      ),
    );
    if (keep == false && mounted) {
      await guarded(context, () => state.setShareTraffic(false));
    } else if (keep == true && state.me['shareTraffic'] != true && mounted) {
      await guarded(context, () => state.setShareTraffic(true));
    }
  }

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final alertCount = state.alerts.where((a) => a['inside'] == true).length;
        return Scaffold(
          body: IndexedStack(index: _tab, children: [
            MapTab(state: state),
            AlertsTab(state: state),
            ActivityTab(state: state),
            ProfileTab(state: state),
          ]),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) {
              setState(() => _tab = i);
              if (i != 0) state.refreshLists();
            },
            destinations: [
              const NavigationDestination(icon: Icon(Icons.map_outlined), selectedIcon: Icon(Icons.map), label: 'Map'),
              NavigationDestination(
                icon: Badge(isLabelVisible: alertCount > 0, label: Text('$alertCount'), child: const Icon(Icons.campaign_outlined)),
                selectedIcon: const Icon(Icons.campaign),
                label: 'Alerts',
              ),
              NavigationDestination(
                icon: Badge(isLabelVisible: state.openSos.isNotEmpty, child: const Icon(Icons.history)),
                label: 'Activity',
              ),
              const NavigationDestination(icon: Icon(Icons.person_outline), selectedIcon: Icon(Icons.person), label: 'Me'),
            ],
          ),
        );
      },
    );
  }
}
