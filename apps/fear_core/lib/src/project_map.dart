import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';

/// A 1 km detail tile's grid position (tx, ty) in the project's metres.
typedef TileKey = (int, int);

/// The city map as the red-lights-revamped viewer draws it, drawn natively
/// (see [ProjectMapLayer]) - no tile server, no internet needed beyond
/// reaching the FEAR server.
///
/// Loaded in two levels so a phone only downloads what it shows:
/// * the base (/v2/map): major roads and their junctions, areas, traffic
///   lights - the whole city, once;
/// * detail tiles (/v2/map/tile): minor roads, their junctions, buildings and
///   amenities, 1 km at a time, fetched only once zoomed in to [detailZoom]
///   and only for the part of the city on screen.
///
/// Positions are the project's own x/y metres (x east, y north from the
/// map's origin) - the same space the traffic engine and map-core.js use.
class ProjectMap extends ChangeNotifier {
  ProjectMap._();

  static final ProjectMap instance = ProjectMap._();

  /// Zoom from which minor roads, buildings and amenities are fetched and drawn.
  static const detailZoom = 14.0;
  static const _maxTiles = 160;
  static const _parallelFetches = 4;

  bool loading = false;
  String? error;
  String? version;
  LatLng origin = const LatLng(28.666925, 77.44868);
  LatLngBounds? bounds;
  double tileM = 1000;

  /// Major roads merged into one Path per (class, width, bridge).
  final List<RoadGroup> baseRoads = [];
  final List<JunctionGroup> baseJunctions = [];
  final List<MapArea> areas = [];
  final List<Offset> signalNodes = [];
  List<Offset> lamps = const [];

  /// One char per lamp: g / y / r - from the live feed every second.
  String lampColors = '';

  /// Seconds until each lamp changes colour (-1: held by emergency priority
  /// or density control - no countdown). Command's feed only.
  List<int> lampTimers = const [];

  /// What each timer means: c seconds left (fixed plan), m at most this many
  /// seconds of green left (density control), e seconds waiting at red, h
  /// seconds held for an emergency vehicle, - none.
  String lampTimerKinds = '';

  String? _baseUrl;
  final Set<TileKey> _available = {};
  final Map<TileKey, MapTile> _tiles = {};
  final Set<TileKey> _inFlight = {};
  final Map<TileKey, DateTime> _failedAt = {};
  List<TileKey> _queue = const [];
  int _frame = 0;
  int _generation = 0;

  bool get ready => version != null;

  /// Whether a position is on (or right next to) the mapped area.
  bool covers(LatLng p) {
    final b = bounds;
    if (b == null) return true;
    const m = 0.01; // ~1 km
    return p.latitude >= b.south - m && p.latitude <= b.north + m && p.longitude >= b.west - m && p.longitude <= b.east + m;
  }

  LatLng get centre => bounds?.center ?? origin;

  Future<void> load(String baseUrl, {bool force = false}) async {
    _baseUrl = baseUrl;
    if (loading || (ready && !force)) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final res = await http.get(Uri.parse('$baseUrl/v2/map')).timeout(const Duration(seconds: 60));
      if (res.statusCode != 200) throw Exception('map download failed (${res.statusCode})');
      final data = await compute(_decode, res.bodyBytes);
      _apply(data);
    } catch (e) {
      error = 'Could not load the map: $e';
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  /// Called with each live tick; reloads the map if the server's map changed.
  void onTick(Map<String, dynamic> tick, String baseUrl) {
    final s = tick['signals'];
    final st = tick['signalTimers'];
    if (st is List) lampTimers = [for (final v in st) (v as num).toInt()];
    final sk = tick['signalTimerKinds'];
    if (sk is String) lampTimerKinds = sk;
    if (s is String && (s != lampColors || st is List)) {
      lampColors = s;
      notifyListeners();
    }
    final mv = tick['mapVersion'];
    if (mv is String && ready && mv != version) load(baseUrl, force: true);
  }

  static Map<String, dynamic> _decode(Uint8List bytes) => jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;

  void _apply(Map<String, dynamic> d) {
    final o = d['origin'] as Map?;
    if (o != null) origin = LatLng((o['lat'] as num).toDouble(), (o['lon'] as num).toDouble());
    final b = d['bounds'] as Map?;
    if (b != null) {
      bounds = LatLngBounds(
        LatLng((b['minlat'] as num).toDouble(), (b['minlon'] as num).toDouble()),
        LatLng((b['maxlat'] as num).toDouble(), (b['maxlon'] as num).toDouble()),
      );
    }
    tileM = (d['tileM'] as num?)?.toDouble() ?? 1000;
    baseRoads
      ..clear()
      ..addAll(_roadGroups(d['ways'] as List? ?? const []));
    baseJunctions
      ..clear()
      ..addAll(_junctionGroups(d['junctions'] as List? ?? const []));
    areas.clear();
    for (final a in d['areas'] as List? ?? const []) {
      final p = (a[3] as List).cast<num>();
      if (p.length < 6) continue;
      areas.add(MapArea(a[0] as String? ?? '', a[1] as String? ?? '', _polygon(p)));
    }
    signalNodes
      ..clear()
      ..addAll((d['signals'] as List? ?? const []).map((s) => Offset((s[1] as num).toDouble(), (s[2] as num).toDouble())));
    lamps = (d['lamps'] as List? ?? const []).map((l) => Offset((l[0] as num).toDouble(), (l[1] as num).toDouble())).toList();
    // a new map: every detail tile from the old one is stale
    _generation++;
    _available
      ..clear()
      ..addAll((d['tiles'] as List? ?? const []).map((t) => ((t[0] as num).toInt(), (t[1] as num).toInt())));
    _tiles.clear();
    _inFlight.clear();
    _failedAt.clear();
    _queue = const [];
    version = d['version'] as String?;
  }

  static ui.Path _polygon(List<num> p) {
    final path = ui.Path()..moveTo(p[0].toDouble(), p[1].toDouble());
    for (var i = 2; i + 1 < p.length; i += 2) {
      path.lineTo(p[i].toDouble(), p[i + 1].toDouble());
    }
    return path..close();
  }

  static List<RoadGroup> _roadGroups(List ways) {
    final groups = <String, RoadGroup>{};
    for (final w in ways) {
      final hw = w[0] as String;
      final width = (w[1] as num).toDouble();
      final layer = (w[3] as num).toInt();
      final pts = (w[5] as List).cast<num>();
      if (pts.length < 4) continue;
      final g = groups.putIfAbsent('$hw|$width|${layer > 0 ? 1 : 0}', () => RoadGroup(hw, width, layer > 0));
      g.path.moveTo(pts[0].toDouble(), pts[1].toDouble());
      for (var i = 2; i + 1 < pts.length; i += 2) {
        g.path.lineTo(pts[i].toDouble(), pts[i + 1].toDouble());
      }
    }
    return groups.values.toList();
  }

  static List<JunctionGroup> _junctionGroups(List junctions) {
    final groups = <String, JunctionGroup>{};
    for (final j in junctions) {
      final hw = j[0] as String;
      final p = (j[1] as List).cast<num>();
      if (p.length < 6) continue;
      groups.putIfAbsent(hw, () => JunctionGroup(hw)).path.addPath(_polygon(p), Offset.zero);
    }
    return groups.values.toList();
  }

  // ----------------------------------------------------------- detail tiles

  /// The world-metre rectangle the camera shows (left/right = x, top/bottom
  /// = min/max y), grown by [marginM].
  Rect visibleWorld(MapCamera camera, {double marginM = 0}) {
    final vb = camera.visibleBounds;
    final a = toWorld(vb.southWest);
    final b = toWorld(vb.northEast);
    return Rect.fromLTRB(math.min(a.dx, b.dx) - marginM, math.min(a.dy, b.dy) - marginM,
        math.max(a.dx, b.dx) + marginM, math.max(a.dy, b.dy) + marginM);
  }

  /// Called by [ProjectMapLayer] whenever the camera moves: queues the detail
  /// tiles on screen (nearest the centre first) once zoomed in far enough.
  /// Never notifies synchronously - it runs during a build.
  void ensureVisible(MapCamera camera) {
    if (!ready || _baseUrl == null) return;
    _frame++;
    if (camera.zoom < detailZoom) return;
    final r = visibleWorld(camera, marginM: tileM * 0.25);
    final x0 = (r.left / tileM).floor(), x1 = (r.right / tileM).floor();
    final y0 = (r.top / tileM).floor(), y1 = (r.bottom / tileM).floor();
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 120) return;
    final missing = <TileKey>[];
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        final k = (tx, ty);
        if (!_available.contains(k)) continue;
        final t = _tiles[k];
        if (t != null) {
          t.lastUsed = _frame;
        } else {
          missing.add(k);
        }
      }
    }
    if (missing.isEmpty) return;
    final c = r.center;
    double dist(TileKey k) => (Offset((k.$1 + 0.5) * tileM, (k.$2 + 0.5) * tileM) - c).distanceSquared;
    missing.sort((a, b) => dist(a).compareTo(dist(b)));
    _queue = missing;
    _pump();
  }

  void _pump() {
    while (_inFlight.length < _parallelFetches && _queue.isNotEmpty) {
      final k = _queue.first;
      _queue = _queue.sublist(1);
      if (_inFlight.contains(k) || _tiles.containsKey(k)) continue;
      final failed = _failedAt[k];
      if (failed != null && DateTime.now().difference(failed) < const Duration(seconds: 10)) continue;
      _inFlight.add(k);
      _fetchTile(k);
    }
  }

  Future<void> _fetchTile(TileKey k) async {
    final gen = _generation;
    try {
      final res = await http
          .get(Uri.parse('$_baseUrl/v2/map/tile?tx=${k.$1}&ty=${k.$2}'))
          .timeout(const Duration(seconds: 20));
      if (gen != _generation) return;
      if (res.statusCode != 200) throw Exception('tile ${res.statusCode}');
      final d = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
      if (d['version'] != version) {
        if (_baseUrl != null) load(_baseUrl!, force: true);
        return;
      }
      _tiles[k] = _buildTile(k, d)..lastUsed = _frame;
      _evict();
      notifyListeners();
    } catch (_) {
      _failedAt[k] = DateTime.now();
    } finally {
      _inFlight.remove(k);
      if (gen == _generation) _pump();
    }
  }

  MapTile _buildTile(TileKey k, Map<String, dynamic> d) {
    final t = MapTile(k, Rect.fromLTWH(k.$1 * tileM, k.$2 * tileM, tileM, tileM));
    t.roads.addAll(_roadGroups(d['ways'] as List? ?? const []));
    t.junctions.addAll(_junctionGroups(d['junctions'] as List? ?? const []));
    for (final poly in d['buildings'] as List? ?? const []) {
      final p = (poly as List).cast<num>();
      if (p.length >= 6) t.buildings.addPath(_polygon(p), Offset.zero);
    }
    for (final a in d['amenities'] as List? ?? const []) {
      t.amenities.add(MapAmenity(a[0] as String, a[1] as String? ?? '', Offset((a[2] as num).toDouble(), (a[3] as num).toDouble())));
    }
    return t;
  }

  void _evict() {
    if (_tiles.length <= _maxTiles) return;
    final old = _tiles.values.toList()..sort((a, b) => a.lastUsed.compareTo(b.lastUsed));
    for (final t in old.take(_tiles.length - _maxTiles)) {
      _tiles.remove(t.key);
    }
  }

  /// Loaded detail tiles overlapping [r] (grown a little: a minor road is
  /// filed under the tile its middle is in, so it can reach past the edge).
  Iterable<MapTile> tilesIn(Rect r) {
    final grown = r.inflate(tileM * 0.6);
    return _tiles.values.where((t) => t.rect.overlaps(grown));
  }

  // ------------------------------------------------------------- projection
  static const _r = 6378137.0;
  static const _deg = math.pi / 180;

  Offset toWorld(LatLng p) => Offset(
        (p.longitude - origin.longitude) * _deg * math.cos(origin.latitude * _deg) * _r,
        (p.latitude - origin.latitude) * _deg * _r,
      );

  LatLng toLatLng(Offset w) => LatLng(
        origin.latitude + w.dy / (_deg * _r),
        origin.longitude + w.dx / (_deg * math.cos(origin.latitude * _deg) * _r),
      );
}

class RoadStyle {
  const RoadStyle(this.color, this.widthPx, {this.outline = const Color(0xFF4A4458), this.footpath = false});

  final Color color;
  final double widthPx;
  final Color outline;
  final bool footpath;
}

/// map-core.js's ROAD_STYLE, colour for colour.
const roadStyles = <String, RoadStyle>{
  'motorway': RoadStyle(Color(0xFFEF476F), 5),
  'trunk': RoadStyle(Color(0xFFF4845F), 4.6),
  'primary': RoadStyle(Color(0xFFF8961E), 4.2),
  'secondary': RoadStyle(Color(0xFFF9C74F), 3.6),
  'tertiary': RoadStyle(Color(0xFFFEE08B), 3.2),
  'motorway_link': RoadStyle(Color(0xFFEF476F), 3),
  'trunk_link': RoadStyle(Color(0xFFF4845F), 3),
  'primary_link': RoadStyle(Color(0xFFF8961E), 3),
  'secondary_link': RoadStyle(Color(0xFFF9C74F), 2.6),
  'tertiary_link': RoadStyle(Color(0xFFFEE08B), 2.6),
  'unclassified': RoadStyle(Color(0xFFFAF3E0), 2.6),
  'residential': RoadStyle(Color(0xFFFAF3E0), 2.6),
  'living_street': RoadStyle(Color(0xFFEDE0D4), 2.4),
  'service': RoadStyle(Color(0xFFF5EBE0), 1.6),
  'pedestrian': RoadStyle(Color(0xFFC9B2E6), 2, footpath: true),
  'footway': RoadStyle(Color(0xFF90C2E7), 1.4, footpath: true),
  'cycleway': RoadStyle(Color(0xFF4CC9F0), 1.4, footpath: true),
  'track': RoadStyle(Color(0xFFB98A52), 1.6, footpath: true),
  'path': RoadStyle(Color(0xFF8A9A5B), 1.3, footpath: true),
  'steps': RoadStyle(Color(0xFFB06FC7), 1.6, footpath: true),
  'default': RoadStyle(Color(0xFFD4CDC0), 1.8),
};

/// Road-level zoom: the zoom a road class first appears at. Zoomed out, only
/// the network that matters at that scale is drawn - the GUI viewer's
/// roadLodVisible does the same.
double roadMinZoom(String highway) => switch (highway) {
      'motorway' || 'trunk' || 'primary' || 'motorway_link' || 'trunk_link' || 'primary_link' => 0,
      'secondary' || 'secondary_link' => 11.5,
      'tertiary' || 'tertiary_link' => 12.5,
      'pedestrian' || 'footway' || 'cycleway' || 'track' || 'path' || 'steps' => 16,
      _ => ProjectMap.detailZoom,
    };

const mapBackground = Color(0xFFF5F0E8);

class RoadGroup {
  RoadGroup(this.highway, this.widthM, this.bridge)
      : style = roadStyles[highway] ?? roadStyles['default']!,
        minZoom = roadMinZoom(highway);

  final String highway;
  final RoadStyle style;
  final double widthM; // real carriageway width, 0 = unknown
  final bool bridge;
  final double minZoom;
  final ui.Path path = ui.Path();

  double get minWidthPx => style.widthPx + widthM * 0.01;
}

/// Every junction area whose widest road is [highway], as one Path: the open
/// space where trimmed road ends meet, filled in that road's colour.
class JunctionGroup {
  JunctionGroup(this.highway)
      : style = roadStyles[highway] ?? roadStyles['default']!,
        minZoom = roadMinZoom(highway);

  final String highway;
  final RoadStyle style;
  final double minZoom;
  final ui.Path path = ui.Path();
}

class MapTile {
  MapTile(this.key, this.rect);

  final TileKey key;
  final Rect rect;
  final List<RoadGroup> roads = [];
  final List<JunctionGroup> junctions = [];
  final ui.Path buildings = ui.Path();
  final List<MapAmenity> amenities = [];
  int lastUsed = 0;
}

class MapArea {
  MapArea(this.kind, this.type, this.path);

  final String kind;
  final String type;
  final ui.Path path;
}

class MapAmenity {
  MapAmenity(this.kind, this.name, this.pos);

  final String kind;
  final String name;
  final Offset pos;
}

const _amenityIcons = <String, String>{
  'hospital': '🏥', 'clinic': '🏥', 'doctors': '🏥', 'pharmacy': '💊', 'fire_station': '🚒', 'police': '🚓',
  'school': '🏫', 'university': '🎓', 'college': '🎓', 'kindergarten': '🧸', 'library': '📚', 'townhall': '🏛️',
  'community_centre': '🏘️', 'place_of_worship': '🛕', 'restaurant': '🍽️', 'cafe': '☕', 'fast_food': '🍔',
  'bank': '🏦', 'atm': '🏧', 'fuel': '⛽', 'parking': '🅿️', 'marketplace': '🛒', 'post_office': '✉️',
  'cinema': '🎬', 'theatre': '🎭', 'bus_station': '🚌', 'courthouse': '⚖️', 'blood_bank': '🩸',
};

/// Draws [ProjectMap] under the other flutter_map layers, in place of tiles.
class ProjectMapLayer extends StatelessWidget {
  const ProjectMapLayer({super.key});

  @override
  Widget build(BuildContext context) {
    final camera = MapCamera.of(context);
    ProjectMap.instance.ensureVisible(camera);
    return MobileLayerTransformer(
      child: ListenableBuilder(
        listenable: ProjectMap.instance,
        builder: (context, _) => CustomPaint(
          size: camera.size,
          painter: _ProjectMapPainter(ProjectMap.instance, camera),
        ),
      ),
    );
  }
}

class _ProjectMapPainter extends CustomPainter {
  _ProjectMapPainter(this.map, this.camera);

  final ProjectMap map;
  final MapCamera camera;

  static final Map<String, TextPainter> _iconCache = {};

  @override
  void paint(Canvas canvas, Size size) {
    if (!map.ready) return;
    // world metres -> screen: one affine transform, taken at the CENTRE OF
    // THE VIEW. Web Mercator stretches north-south with latitude, so a
    // transform taken at the map's origin drifts tens of metres away from
    // everything flutter_map projects exactly (route lines, markers, GPS) in
    // an area 20-30 km from the origin. Anchored on screen, the stretch
    // across one view stays under a pixel at any zoom.
    final cw = map.toWorld(camera.center);
    final oc = camera.getOffsetFromOrigin(camera.center);
    final east = camera.getOffsetFromOrigin(map.toLatLng(cw + const Offset(1000, 0)));
    final north = camera.getOffsetFromOrigin(map.toLatLng(cw + const Offset(0, 1000)));
    final kx = (east.dx - oc.dx) / 1000;
    final ky = (north.dy - oc.dy) / 1000; // negative - screen y grows downward
    final k = kx.abs();
    final o = Offset(oc.dx - cw.dx * kx, oc.dy - cw.dy * ky); // where world (0, 0) lands under this transform
    Offset screen(Offset w) => Offset(o.dx + w.dx * kx, o.dy + w.dy * ky);
    final zoom = camera.zoom;
    final view = map.visibleWorld(camera);

    // What this zoom shows: the base's major roads by class, and the loaded
    // detail tiles on screen (their minor roads still gated by class).
    final tiles = zoom >= ProjectMap.detailZoom - 0.5 ? map.tilesIn(view).toList() : const <MapTile>[];
    final roads = <RoadGroup>[
      ...map.baseRoads.where((g) => zoom >= g.minZoom),
      for (final t in tiles) ...t.roads.where((g) => zoom >= g.minZoom),
    ]..sort((a, b) => a.minWidthPx.compareTo(b.minWidthPx));
    final junctions = <JunctionGroup>[
      ...map.baseJunctions.where((j) => zoom >= j.minZoom),
      for (final t in tiles) ...t.junctions.where((j) => zoom >= j.minZoom),
    ];

    canvas.save();
    canvas.translate(o.dx, o.dy);
    canvas.scale(kx, ky);

    // areas (zones, jurisdictions) - a faint wash under everything
    for (final a in map.areas) {
      final fill = a.kind == 'zone' ? const Color(0x1A8D99AE) : const Color(0x00000000);
      if (fill.a > 0) canvas.drawPath(a.path, Paint()..color = fill);
      canvas.drawPath(
          a.path,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 2 / k
            ..color = a.kind == 'zone' ? const Color(0x558D99AE) : const Color(0x33E63946));
    }
    if (zoom >= 15) {
      final fill = Paint()..color = const Color(0x8CC6B091);
      final edge = Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 0.8 / k
        ..color = const Color(0xFF7A6A52);
      for (final t in tiles) {
        canvas.drawPath(t.buildings, fill);
        if (zoom >= 16) canvas.drawPath(t.buildings, edge);
      }
    }

    double widthPx(RoadGroup g) => math.max(g.style.widthPx * (zoom >= 15 ? 1 : 0.7), g.widthM * k);
    Paint stroke(Color c, double px) => Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = c
      ..strokeWidth = px / k;

    void drawRoads(bool bridges) {
      // every outline first, then every surface narrowest-first, so a wider
      // road's surface runs over a narrower one where they meet
      for (final g in roads) {
        if (g.bridge != bridges || g.style.footpath) continue;
        canvas.drawPath(g.path, stroke(g.style.outline, widthPx(g) + 2));
      }
      if (!bridges) {
        // the kerb round each junction's open area; the road surfaces drawn
        // next cover it wherever a road enters
        final kerb = Paint()
          ..style = PaintingStyle.stroke
          ..strokeJoin = StrokeJoin.round
          ..color = const Color(0xFF4A4458)
          ..strokeWidth = 2 / k;
        for (final j in junctions) {
          canvas.drawPath(j.path, kerb);
        }
      }
      for (final g in roads) {
        if (g.bridge != bridges) continue;
        canvas.drawPath(g.path, stroke(g.style.color, widthPx(g)));
      }
      if (!bridges) {
        // the junction's open area itself, in its widest road's colour - so
        // trimmed road ends read as one continuous surface, not a hole
        for (final j in junctions) {
          canvas.drawPath(j.path, Paint()..color = j.style.color);
        }
      }
    }

    drawRoads(false);
    drawRoads(true);
    canvas.restore();

    // signal junctions and their lamps, at constant screen size
    if (zoom >= 13.5) {
      final dot = Paint()..color = const Color(0xFFEF476F);
      for (final s in map.signalNodes) {
        final p = screen(s);
        if (!_onScreen(p, size)) continue;
        canvas.drawCircle(p, zoom >= 16 ? 4.2 : 3.2, dot);
      }
    }
    if (zoom >= 15.5 && map.lampColors.length == map.lamps.length) {
      final r = zoom >= 18 ? 4.5 : 3.4;
      final ring = Paint()..color = const Color(0xFF1A1A2E);
      for (var i = 0; i < map.lamps.length; i++) {
        final p = screen(map.lamps[i]);
        if (!_onScreen(p, size)) continue;
        final c = switch (map.lampColors[i]) {
          'g' => const Color(0xFF06D6A0),
          'y' => const Color(0xFFFFD166),
          _ => const Color(0xFFEF476F),
        };
        canvas.drawCircle(p, r + 1.4, ring);
        canvas.drawCircle(p, r, Paint()..color = c);
      }
      // red-light durations: seconds left on each approach's main (through)
      // lamp, next to it - zoomed in far enough to read them
      final timers = map.lampTimers;
      final kinds = map.lampTimerKinds;
      if (zoom >= 16 && timers.length == map.lamps.length) {
        for (var i = 0; i < map.lamps.length; i += 2) {
          final secs = timers[i];
          final kind = i < kinds.length ? kinds[i] : 'c';
          if (secs < 0 || kind == '-') continue;
          final p = screen(map.lamps[i]);
          if (!_onScreen(p, size)) continue;
          final colour = map.lampColors[i];
          final label = switch (kind) { 'm' => '≤$secs', 'e' => '+$secs', 'h' => '⚡$secs', _ => '$secs' };
          final tp = _timerText(label, colour);
          final box = Rect.fromCenter(center: p + Offset(0, -(r + 9)), width: tp.width + 6, height: tp.height + 2);
          canvas.drawRRect(RRect.fromRectAndRadius(box, const Radius.circular(4)), Paint()..color = const Color(0xE61A1A2E));
          tp.paint(canvas, box.topLeft + const Offset(3, 1));
        }
      }
    }
    // amenity icons
    if (zoom >= 15.5) {
      for (final t in tiles) {
        for (final a in t.amenities) {
          final p = screen(a.pos);
          if (!_onScreen(p, size)) continue;
          final icon = _amenityIcons[a.kind] ?? '📍';
          final tp = _iconCache.putIfAbsent(icon, () {
            return TextPainter(text: TextSpan(text: icon, style: const TextStyle(fontSize: 15)), textDirection: TextDirection.ltr)
              ..layout();
          });
          tp.paint(canvas, p - Offset(tp.width / 2, tp.height / 2));
        }
      }
    }
  }

  static final Map<String, TextPainter> _timerCache = {};

  static TextPainter _timerText(String text, String colour) {
    if (_timerCache.length > 1500) _timerCache.clear();
    return _timerCache.putIfAbsent('$colour$text', () {
      final c = switch (colour) { 'g' => const Color(0xFF06D6A0), 'y' => const Color(0xFFFFD166), _ => const Color(0xFFFF6B81) };
      return TextPainter(
        text: TextSpan(text: text, style: TextStyle(color: c, fontSize: 10.5, fontWeight: FontWeight.w800, height: 1.1)),
        textDirection: TextDirection.ltr,
      )..layout();
    });
  }

  static bool _onScreen(Offset p, Size s) => p.dx > -30 && p.dy > -30 && p.dx < s.width + 30 && p.dy < s.height + 30;

  @override
  bool shouldRepaint(_ProjectMapPainter old) => true;
}
