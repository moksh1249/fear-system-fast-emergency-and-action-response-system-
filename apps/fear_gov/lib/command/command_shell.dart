import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';

import 'admin_pages.dart';
import 'alerts_page.dart';
import 'command_state.dart';
import 'live_map_page.dart';
import 'ops_pages.dart';
import 'phone_qr.dart';
import 'registry_page.dart';

class _Section {
  const _Section(this.title, this.icon, this.builder);

  final String title;
  final IconData icon;
  final Widget Function(CommandState) builder;
}

/// The Command & Control / administration dashboard. Which sections appear
/// depends on the account's permissions (the server enforces them anyway).
class CommandShell extends StatefulWidget {
  const CommandShell({super.key, required this.session});

  final Session session;

  @override
  State<CommandShell> createState() => _CommandShellState();
}

class _CommandShellState extends State<CommandShell> {
  late final CommandState state = CommandState(widget.session);
  int _index = 0;

  @override
  void initState() {
    super.initState();
    state.start();
  }

  @override
  void dispose() {
    state.dispose();
    super.dispose();
  }

  List<_Section> _sections() {
    final s = state;
    return [
      if (s.isCommand || s.role == 'org_admin') _Section(s.isCommand ? 'Live map' : 'My fleet', Icons.map, (s) => LiveMapPage(state: s)),
      if (s.isCommand) _Section('Incidents', Icons.crisis_alert, (s) => IncidentsPage(state: s)),
      _Section('Units', Icons.local_shipping, (s) => UnitsPage(state: s)),
      if (s.can('controlSignals') || s.isCommand) _Section('Signals', Icons.traffic, (s) => SignalsPage(state: s)),
      if (s.can('manageAlerts')) _Section('Public alerts', Icons.campaign, (s) => AlertsPage(state: s)),
      if (s.can('manageRegistry')) _Section('Registry', Icons.account_tree, (s) => RegistryPage(state: s)),
      if (s.can('verifyCitizenVehicles')) _Section('RTO verification', Icons.fact_check, (s) => VerificationPage(state: s)),
      if (s.isCommand) _Section('Analytics', Icons.insights, (s) => AnalyticsPage(state: s)),
      if (s.can('viewAudit')) _Section('Audit log', Icons.policy, (s) => AuditPage(state: s)),
      if (s.can('devOutbox')) _Section('Dev OTP outbox', Icons.sms, (s) => OutboxPage(state: s)),
    ];
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) {
        final sections = _sections();
        if (_index >= sections.length) _index = 0;
        final wide = MediaQuery.sizeOf(context).width >= 900;
        final p = state.profile;
        final org = p['org'] as Map?;
        final who = p['role'] == 'operator' ? (p['authorityLabel'] ?? 'Operator') : (p['role'] == 'super_admin' ? 'Super admin' : 'Org admin');
        final appBar = AppBar(
          title: Row(children: [
            const Icon(Icons.shield, color: FearColors.brand),
            const SizedBox(width: 10),
            Text(sections[_index].title),
          ]),
          actions: [
            _EngineChip(state: state),
            const SizedBox(width: 8),
            _FeedDot(online: state.feed.online),
            const SizedBox(width: 12),
            if (wide)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text('${p['displayName']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text('$who${org != null ? ' · ${org['name']}' : ''}', style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
            PopupMenuButton<String>(
              tooltip: 'Phone sign-in',
              icon: const Icon(Icons.qr_code_2),
              onSelected: (v) => v == 'me' ? signInMyPhone(context, state) : signInExistingPhone(context, state),
              itemBuilder: (_) => [
                const PopupMenuItem(value: 'me', child: ListTile(leading: Icon(Icons.phone_android), title: Text('Sign in on my phone'))),
                if (state.can('enrollPhones') || ['super_admin', 'org_admin'].contains(state.role) ||
                    (state.role == 'operator' && state.profile['authority'] == 'iccc'))
                  const PopupMenuItem(value: 'other', child: ListTile(leading: Icon(Icons.qr_code), title: Text('Sign in an existing account on a phone'))),
              ],
            ),
            IconButton(
              tooltip: 'Sign out',
              icon: const Icon(Icons.logout),
              onPressed: () async {
                try {
                  await state.api.post('/gov/auth/logout');
                } catch (_) {}
                await widget.session.signOut();
              },
            ),
          ],
        );
        final body = sections[_index].builder(state);
        if (wide) {
          return Scaffold(
            appBar: appBar,
            body: Row(children: [
              NavigationRail(
                selectedIndex: _index,
                onDestinationSelected: (i) => setState(() => _index = i),
                labelType: NavigationRailLabelType.all,
                destinations: [for (final s in sections) NavigationRailDestination(icon: Icon(s.icon), label: Text(s.title))],
              ),
              const VerticalDivider(width: 1),
              Expanded(child: body),
            ]),
          );
        }
        return Scaffold(
          appBar: appBar,
          drawer: Drawer(
            child: ListView(children: [
              DrawerHeader(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.end, children: [
                  Text('${p['displayName']}', style: Theme.of(context).textTheme.titleMedium),
                  Text('$who${org != null ? '\n${org['name']}' : ''}'),
                ]),
              ),
              for (var i = 0; i < sections.length; i++)
                ListTile(
                  leading: Icon(sections[i].icon),
                  title: Text(sections[i].title),
                  selected: i == _index,
                  onTap: () {
                    setState(() => _index = i);
                    Navigator.pop(context);
                  },
                ),
            ]),
          ),
          body: body,
        );
      },
    );
  }
}

class _EngineChip extends StatelessWidget {
  const _EngineChip({required this.state});

  final CommandState state;

  @override
  Widget build(BuildContext context) {
    final e = state.engine;
    final connected = e['connected'] == true;
    final mode = e['simMode'] as String?;
    final text = !connected ? 'Traffic engine offline' : (mode == 'realistic' ? 'Realistic mode' : 'Simulation mode');
    final color = !connected ? Colors.grey : (mode == 'realistic' ? FearColors.ok : FearColors.warn);
    return Tooltip(
      message: connected ? 'Signals: ${e['signalMode'] ?? '-'} · live GPS vehicles: ${e['liveVehicles'] ?? 0}' : 'Start it from Signals',
      child: Chip(
        avatar: Icon(Icons.memory, size: 16, color: color),
        label: Text(text, style: TextStyle(color: color, fontSize: 12)),
        visualDensity: VisualDensity.compact,
      ),
    );
  }
}

class _FeedDot extends StatelessWidget {
  const _FeedDot({required this.online});

  final bool online;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: online ? 'Live feed connected' : 'Reconnecting to live feed...',
      child: Icon(Icons.circle, size: 12, color: online ? FearColors.ok : Colors.redAccent),
    );
  }
}
