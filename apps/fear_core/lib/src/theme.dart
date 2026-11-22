import 'package:flutter/material.dart';

/// Visual vocabulary shared by both apps: one colour and icon per vehicle
/// category and incident kind, so an ambulance looks the same on the
/// Command wall and on a citizen's phone.
class FearColors {
  static const brand = Color(0xFFC62828);
  static const navy = Color(0xFF0E1A2B);
  static const ok = Color(0xFF2E7D32);
  static const warn = Color(0xFFF9A825);
  static const demo = Color(0xFFEF6C00);

  static const categories = <String, Color>{
    'ambulance': Color(0xFFE53935),
    'firetruck': Color(0xFFF4511E),
    'police': Color(0xFF1E88E5),
    'bus': Color(0xFF43A047),
    'municipal': Color(0xFF8D6E63),
    'government': Color(0xFF7E57C2),
    'commercial': Color(0xFF546E7A),
  };

  static const incidents = <String, Color>{
    'medical': Color(0xFFE53935),
    'fire': Color(0xFFF4511E),
    'crime': Color(0xFF1E88E5),
    'accident': Color(0xFFD84315),
    'hazard': Color(0xFFF9A825),
    'road_blocked': Color(0xFF6D4C41),
    'congestion': Color(0xFFFFA000),
    'other': Color(0xFF607D8B),
  };

  static Color category(String? c) => categories[c] ?? const Color(0xFF607D8B);
  static Color incident(String? k) => incidents[k] ?? const Color(0xFF607D8B);

  static Color status(String? s) => switch (s) {
        'available' => ok,
        'assigned' => const Color(0xFF8E24AA),
        'en_route' || 'transporting' => brand,
        'on_scene' => const Color(0xFFEF6C00),
        'off_duty' => const Color(0xFF9E9E9E),
        'reported' => warn,
        'open' => const Color(0xFFD84315),
        'dispatched' => const Color(0xFF8E24AA),
        'closed' || 'completed' => const Color(0xFF616161),
        'rejected' || 'cancelled' || 'recalled' || 'declined' => const Color(0xFF9E9E9E),
        _ => const Color(0xFF607D8B),
      };
}

class FearIcons {
  static IconData category(String? c) => switch (c) {
        'ambulance' => Icons.emergency,
        'firetruck' => Icons.fire_truck,
        'police' => Icons.local_police,
        'bus' => Icons.directions_bus,
        'municipal' => Icons.local_shipping,
        'government' => Icons.account_balance,
        'commercial' => Icons.local_shipping_outlined,
        _ => Icons.directions_car,
      };

  static IconData incident(String? k) => switch (k) {
        'medical' => Icons.medical_services,
        'fire' => Icons.local_fire_department,
        'crime' => Icons.local_police,
        'accident' => Icons.car_crash,
        'hazard' => Icons.warning_amber,
        'road_blocked' => Icons.block,
        'congestion' => Icons.traffic,
        _ => Icons.report,
      };
}

ThemeData fearTheme({required Brightness brightness, Color seed = FearColors.brand}) {
  final scheme = ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
  return ThemeData(
    colorScheme: scheme,
    useMaterial3: true,
    visualDensity: VisualDensity.standard,
    appBarTheme: AppBarTheme(
      backgroundColor: brightness == Brightness.dark ? FearColors.navy : scheme.surface,
      foregroundColor: brightness == Brightness.dark ? Colors.white : scheme.onSurface,
      centerTitle: false,
      elevation: 0,
    ),
    cardTheme: const CardThemeData(margin: EdgeInsets.zero, clipBehavior: Clip.antiAlias),
    inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
    snackBarTheme: const SnackBarThemeData(behavior: SnackBarBehavior.floating),
  );
}
