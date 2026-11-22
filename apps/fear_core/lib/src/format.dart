String fmtDuration(num? seconds) {
  if (seconds == null) return '--';
  final s = seconds.round();
  if (s < 60) return '$s s';
  final m = (s / 60).round();
  if (m < 60) return '$m min';
  return '${m ~/ 60} h ${m % 60} min';
}

String fmtDistance(num? metres) {
  if (metres == null) return '--';
  if (metres < 1000) return '${metres.round()} m';
  return '${(metres / 1000).toStringAsFixed(metres < 10000 ? 1 : 0)} km';
}

DateTime? parseTime(String? iso) => iso == null ? null : DateTime.tryParse(iso)?.toLocal();

String fmtClock(String? iso) {
  final t = parseTime(iso);
  if (t == null) return '--';
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(t.hour)}:${two(t.minute)}';
}

String fmtAgo(String? iso) {
  final t = parseTime(iso);
  if (t == null) return '--';
  final d = DateTime.now().difference(t);
  if (d.inSeconds < 60) return '${d.inSeconds.clamp(0, 59)} s ago';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

String titleCase(String s) =>
    s.replaceAll('_', ' ').split(' ').map((w) => w.isEmpty ? w : w[0].toUpperCase() + w.substring(1)).join(' ');

const statusLabels = <String, String>{
  'available': 'Available',
  'off_duty': 'Off duty',
  'assigned': 'Assigned',
  'en_route': 'En route',
  'on_scene': 'On scene',
  'transporting': 'Transporting',
  'completed': 'Completed',
  'declined': 'Declined',
  'recalled': 'Recalled',
  'reported': 'Awaiting verification',
  'open': 'Open',
  'dispatched': 'Help dispatched',
  'closed': 'Closed',
  'rejected': 'Rejected',
  'cancelled': 'Cancelled',
};

String statusLabel(String? s) => statusLabels[s] ?? titleCase(s ?? '');
