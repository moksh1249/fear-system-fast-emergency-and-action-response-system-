import 'dart:async';
import 'dart:convert';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:audioplayers/audioplayers.dart';
import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:record/record.dart';

import 'public_state.dart';

/// How the person wants to report: talk to the AI responder, or fill a form.
/// Returns 'voice', 'form' or null (cancelled).
Future<String?> askReportMode(BuildContext context, {required bool sos}) {
  return showModalBottomSheet<String>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text(sos ? 'How do you want to ask for help?' : 'How do you want to report it?', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 12),
          Material(
            color: FearColors.brand.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(12),
            child: ListTile(
              leading: const Icon(Icons.record_voice_over, color: FearColors.brand, size: 34),
              title: const Text('Talk to the FEAR responder', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: Text(sos
                  ? 'Say what happened - help is requested from your first answer, then it asks a few quick questions. Any language.'
                  : 'Say what happened and answer a few quick questions. Any language.'),
              onTap: () => Navigator.pop(ctx, 'voice'),
            ),
          ),
          const SizedBox(height: 8),
          Material(
            color: Theme.of(ctx).colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            child: ListTile(
              leading: const Icon(Icons.edit_note, size: 34),
              title: const Text('Fill in a form', style: TextStyle(fontWeight: FontWeight.w700)),
              subtitle: const Text('Choose the type and type the details yourself.'),
              onTap: () => Navigator.pop(ctx, 'form'),
            ),
          ),
        ]),
      ),
    ),
  );
}

/// Opens the AI responder conversation. Returns the incident id it raised
/// (an SOS, or a report once sent), 'form' if the person switched to the
/// form, or null.
Future<String?> openResponder(BuildContext context, PublicState s, {required String purpose, required LatLng at, bool demo = false}) {
  return Navigator.of(context).push<String>(MaterialPageRoute(
    fullscreenDialog: true,
    builder: (_) => ResponderScreen(state: s, purpose: purpose, at: at, demo: demo),
  ));
}

enum _Phase { starting, speaking, listening, thinking, done, failed }

/// The conversation: the responder speaks a question, the phone listens
/// (stopping by itself a moment after the person stops talking), sends the
/// answer, and speaks the next question - until it has what Command needs.
class ResponderScreen extends StatefulWidget {
  const ResponderScreen({super.key, required this.state, required this.purpose, required this.at, this.demo = false});

  final PublicState state;
  final String purpose; // 'sos' | 'report'
  final LatLng at;
  final bool demo;

  @override
  State<ResponderScreen> createState() => _ResponderScreenState();
}

class _ResponderScreenState extends State<ResponderScreen> {
  static const _rate = 16000;
  static const _sosKinds = [('medical', 'Medical'), ('accident', 'Accident'), ('fire', 'Fire'), ('crime', 'Police')];
  static const _reportKinds = [('accident', 'Accident'), ('hazard', 'Hazard'), ('road_blocked', 'Blocked road'), ('congestion', 'Traffic jam'), ('fire', 'Fire'), ('other', 'Other')];

  final _player = AudioPlayer();
  final _rec = AudioRecorder();
  final _pcm = BytesBuilder(copy: false);
  final _turns = <(String, String?)>[]; // (question, answer)
  StreamSubscription<Uint8List>? _sub;
  StreamSubscription<Amplitude>? _ampSub;
  Timer? _guard;

  _Phase _phase = _Phase.starting;
  String? _sid;
  String _question = '';
  String? _error;
  String? _incidentId;
  String? _kind;
  Map<String, dynamic> _facts = const {};
  String? _summary;
  String? _severityLabel;
  int? _severity;
  double _level = 0;
  bool _heardSpeech = false;
  DateTime? _lastLoud;
  DateTime _listenStart = DateTime.now();
  bool _closing = false;

  ApiClient get api => widget.state.api;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _closing = true;
    _guard?.cancel();
    _sub?.cancel();
    _ampSub?.cancel();
    _rec.dispose();
    _player.dispose();
    super.dispose();
  }

  String get _deviceLang {
    final l = Platform.localeName.toLowerCase();
    for (final c in const ['hi', 'bn', 'gu', 'kn', 'ml', 'mr', 'pa', 'ta', 'te']) {
      if (l.startsWith(c)) return '$c-IN';
    }
    return 'en-IN';
  }

  Future<void> _start() async {
    try {
      if (!await _rec.hasPermission()) {
        setState(() {
          _phase = _Phase.failed;
          _error = 'FEAR needs the microphone to talk with you. Allow it in the phone\'s settings - or use the form.';
        });
        return;
      }
      final r = Map<String, dynamic>.from(await api.post('/public/responder/start', {
        'purpose': widget.purpose,
        'lat': widget.at.latitude,
        'lon': widget.at.longitude,
        'lang': _deviceLang,
        'demo': widget.demo,
      }) as Map);
      _sid = r['sid'] as String;
      _apply(r);
      await _speak(r['say'] as Map?);
    } on ApiException catch (e) {
      _fail(e.message);
    } catch (e) {
      _fail('Could not reach FEAR: $e');
    }
  }

  void _fail(String msg) {
    if (!mounted) return;
    setState(() {
      _phase = _Phase.failed;
      _error = msg;
    });
  }

  void _apply(Map<String, dynamic> r) {
    final heard = r['heard'] as Map?;
    if (heard != null && _turns.isNotEmpty) _turns[_turns.length - 1] = (_turns.last.$1, heard['text'] as String?);
    final firstSos = _incidentId == null && r['incidentId'] != null && widget.purpose == 'sos';
    setState(() {
      _incidentId = r['incidentId'] as String? ?? _incidentId;
      _kind = r['kind'] as String? ?? _kind;
      _facts = Map<String, dynamic>.from((r['facts'] as Map?) ?? const {});
      _summary = r['summary'] as String? ?? _summary;
      _severity = r['severity'] as int? ?? _severity;
      _severityLabel = r['severityLabel'] as String? ?? _severityLabel;
    });
    if (firstSos) {
      HapticFeedback.heavyImpact();
      widget.state.refreshLists();
    }
  }

  Future<void> _speak(Map? say) async {
    if (say == null || _closing) return;
    final text = '${say['text'] ?? ''}';
    final done = (say['key'] as String? ?? '').startsWith('close_');
    setState(() {
      _question = text;
      _phase = _Phase.speaking;
      if (!done) _turns.add((text, null));
    });
    final audio = say['audio'] as String?;
    if (audio != null) {
      try {
        await _player.play(BytesSource(base64Decode(audio), mimeType: 'audio/mpeg'));
        await _player.onPlayerComplete.first.timeout(const Duration(seconds: 30));
      } catch (_) {}
    } else {
      await Future.delayed(const Duration(milliseconds: 600)); // no voice: the text is on screen
    }
    if (_closing || !mounted) return;
    if (done) {
      setState(() => _phase = _Phase.done);
      return;
    }
    await _listen();
  }

  /// Records until the person has spoken and then been quiet for a moment
  /// (or 20 s, or 8 s of silence with no speech at all).
  Future<void> _listen() async {
    _pcm.clear();
    _heardSpeech = false;
    _lastLoud = null;
    _listenStart = DateTime.now();
    try {
      final stream = await _rec.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: _rate, numChannels: 1));
      _sub = stream.listen(_pcm.add);
      _ampSub = _rec.onAmplitudeChanged(const Duration(milliseconds: 100)).listen((a) {
        final now = DateTime.now();
        if (a.current > -38) {
          _heardSpeech = true;
          _lastLoud = now;
        }
        if (mounted) setState(() => _level = ((a.current + 50) / 50).clamp(0.0, 1.0));
        final quietFor = _lastLoud == null ? Duration.zero : now.difference(_lastLoud!);
        final listening = now.difference(_listenStart);
        if ((_heardSpeech && quietFor > const Duration(milliseconds: 1600)) ||
            listening > const Duration(seconds: 20) ||
            (!_heardSpeech && listening > const Duration(seconds: 8))) {
          _finishAnswer();
        }
      });
      if (mounted) setState(() => _phase = _Phase.listening);
    } catch (e) {
      _fail('Could not use the microphone: $e');
    }
  }

  bool _sending = false;

  Future<void> _finishAnswer() async {
    if (_sending || _phase != _Phase.listening) return;
    _sending = true;
    try {
      await _ampSub?.cancel();
      await _rec.stop();
      await _sub?.cancel();
      final pcm = _pcm.takeBytes();
      setState(() {
        _phase = _Phase.thinking;
        _level = 0;
      });
      final body = _heardSpeech ? _wav(pcm) : Uint8List(0);
      final r = Map<String, dynamic>.from(await api.postBytes('/public/responder/$_sid/answer', body, contentType: 'audio/wav') as Map);
      _apply(r);
      await _speak(r['say'] as Map?);
    } on ApiException catch (e) {
      _fail(e.message);
    } catch (e) {
      _fail('Could not reach FEAR: $e');
    } finally {
      _sending = false;
    }
  }

  Future<void> _tapKind(String kind) async {
    if (_sid == null) return;
    try {
      final r = Map<String, dynamic>.from(await api.post('/public/responder/$_sid/kind', {'kind': kind}) as Map);
      _apply(r);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.message, error: true);
    }
  }

  Future<void> _sendReport() async {
    final r = await guarded(context, () => api.post('/public/responder/$_sid/finish', {'kind': _kind ?? 'other'}),
        success: 'Thanks - your report reached Command.');
    if (r == null || !mounted) return;
    await widget.state.refreshLists();
    if (mounted) Navigator.pop(context, (r as Map)['incidentId'] as String?);
  }

  Future<void> _close() async {
    _closing = true;
    await _player.stop();
    if (_phase == _Phase.listening) await _rec.stop();
    if (_sid != null && widget.purpose == 'sos') {
      try {
        await api.post('/public/responder/$_sid/finish', {});
      } catch (_) {}
    }
    if (mounted) Navigator.pop(context, _incidentId);
  }

  static Uint8List _wav(Uint8List pcm) {
    final h = ByteData(44);
    void str(int at, String s) {
      for (var i = 0; i < s.length; i++) {
        h.setUint8(at + i, s.codeUnitAt(i));
      }
    }

    str(0, 'RIFF');
    h.setUint32(4, 36 + pcm.length, Endian.little);
    str(8, 'WAVE');
    str(12, 'fmt ');
    h.setUint32(16, 16, Endian.little);
    h.setUint16(20, 1, Endian.little);
    h.setUint16(22, 1, Endian.little);
    h.setUint32(24, _rate, Endian.little);
    h.setUint32(28, _rate * 2, Endian.little);
    h.setUint16(32, 2, Endian.little);
    h.setUint16(34, 16, Endian.little);
    str(36, 'data');
    h.setUint32(40, pcm.length, Endian.little);
    return (BytesBuilder()
          ..add(h.buffer.asUint8List())
          ..add(pcm))
        .takeBytes();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sos = widget.purpose == 'sos';
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _close();
      },
      child: Scaffold(
        appBar: AppBar(
          title: Text(sos ? 'FEAR emergency responder' : 'FEAR responder'),
          leading: IconButton(icon: const Icon(Icons.close), onPressed: _close),
        ),
        body: SafeArea(
          child: ListView(padding: const EdgeInsets.all(16), children: [
            if (sos)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: _incidentId != null ? FearColors.ok.withValues(alpha: 0.15) : FearColors.brand.withValues(alpha: 0.10),
                    borderRadius: BorderRadius.circular(12)),
                child: Row(children: [
                  Icon(_incidentId != null ? Icons.check_circle : Icons.sos, color: _incidentId != null ? FearColors.ok : FearColors.brand),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(_incidentId != null
                        ? 'SOS sent - help is being arranged. Keep talking: it helps responders.'
                        : 'Help is requested as soon as you say what happened - or tap it below.'),
                  ),
                ]),
              ),
            if (sos && _incidentId == null) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                for (final k in _sosKinds)
                  ActionChip(avatar: Icon(FearIcons.incident(k.$1), size: 18), label: Text(k.$2), onPressed: () => _tapKind(k.$1)),
              ]),
            ],
            const SizedBox(height: 20),
            Center(child: _orb(theme)),
            const SizedBox(height: 14),
            Text(_question, textAlign: TextAlign.center, style: theme.textTheme.titleMedium),
            const SizedBox(height: 6),
            Text(
              switch (_phase) {
                _Phase.starting => 'Connecting to the responder...',
                _Phase.speaking => 'Responder speaking...',
                _Phase.listening => _heardSpeech ? 'Listening... (stops when you pause)' : 'Your turn - speak now',
                _Phase.thinking => 'Understanding...',
                _Phase.done => sos ? 'Done - help is on the way.' : 'Done - check and send.',
                _Phase.failed => '',
              },
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall,
            ),
            if (_phase == _Phase.listening)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Center(child: FilledButton.tonalIcon(onPressed: _finishAnswer, icon: const Icon(Icons.stop), label: const Text('Done talking'))),
              ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error)),
            ],
            const SizedBox(height: 16),
            if (_severity != null || _facts.values.any((v) => v != null && v != '' && v is! List || (v is List && v.isNotEmpty))) _factsCard(theme),
            for (final t in _turns)
              if (t.$2 != null)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(t.$1, style: theme.textTheme.bodySmall),
                    Align(
                      alignment: Alignment.centerRight,
                      child: Container(
                        margin: const EdgeInsets.only(top: 2, left: 40),
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                        decoration: BoxDecoration(color: theme.colorScheme.primaryContainer, borderRadius: BorderRadius.circular(12)),
                        child: Text(t.$2!),
                      ),
                    ),
                  ]),
                ),
            const SizedBox(height: 20),
            if (_phase == _Phase.done && !sos) ...[
              Text('Type of problem', style: theme.textTheme.titleSmall),
              Wrap(spacing: 8, children: [
                for (final k in _reportKinds) ChoiceChip(label: Text(k.$2), selected: _kind == k.$1, onSelected: (_) => setState(() => _kind = k.$1)),
              ]),
              const SizedBox(height: 12),
              FilledButton.icon(onPressed: _sendReport, icon: const Icon(Icons.send), label: const Text('Send report')),
            ],
            if (_phase == _Phase.done && sos)
              FilledButton.icon(onPressed: _close, icon: const Icon(Icons.local_shipping), label: const Text('Follow the help coming')),
            if (_phase == _Phase.failed || (_incidentId == null && _phase != _Phase.done))
              TextButton.icon(
                onPressed: () async {
                  _closing = true;
                  await _player.stop();
                  if (_phase == _Phase.listening) await _rec.stop();
                  if (context.mounted) Navigator.pop(context, 'form');
                },
                icon: const Icon(Icons.edit_note),
                label: const Text('Use the form instead'),
              ),
          ]),
        ),
      ),
    );
  }

  Widget _orb(ThemeData theme) {
    final listening = _phase == _Phase.listening;
    final colour = switch (_phase) {
      _Phase.listening => FearColors.brand,
      _Phase.speaking => const Color(0xFF1A73E8),
      _Phase.done => FearColors.ok,
      _ => theme.colorScheme.outline,
    };
    return AnimatedContainer(
      duration: const Duration(milliseconds: 120),
      width: 110 + (listening ? _level * 40 : 0),
      height: 110 + (listening ? _level * 40 : 0),
      decoration: BoxDecoration(shape: BoxShape.circle, color: colour, boxShadow: [BoxShadow(color: colour.withValues(alpha: 0.4), blurRadius: 18)]),
      child: Icon(
        switch (_phase) {
          _Phase.listening => Icons.mic,
          _Phase.speaking => Icons.volume_up,
          _Phase.thinking || _Phase.starting => Icons.more_horiz,
          _Phase.done => Icons.check,
          _Phase.failed => Icons.mic_off,
        },
        color: Colors.white,
        size: 48,
      ),
    );
  }

  Widget _factsCard(ThemeData theme) {
    final f = _facts;
    String yn(Object? v) => v == 'yes' ? 'Yes' : v == 'no' ? 'No' : '-';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Text('What the responder understood', style: theme.textTheme.titleSmall),
            const Spacer(),
            if (_severity != null) SeverityChip(score: _severity, dense: true),
          ]),
          if (_summary != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text(_summary!)),
          const SizedBox(height: 6),
          Wrap(spacing: 14, runSpacing: 4, children: [
            Text('Hurt: ${f['injured'] ?? '-'}'),
            Text('Unconscious / not breathing / heavy bleeding: ${yn(f['critical'])}'),
            Text('Trapped / fire / fuel: ${yn(f['hazard'])}'),
            if ((f['vehicles'] as List?)?.isNotEmpty == true) Text('Vehicles: ${(f['vehicles'] as List).join(', ')}'),
            if (f['landmark'] != null) Text('Landmark: ${f['landmark']}'),
            if (f['callerSafe'] != null) Text('You are safe: ${yn(f['callerSafe'])}'),
          ]),
          if (_severityLabel != null) Text('Rated $_severityLabel', style: theme.textTheme.bodySmall),
        ]),
      ),
    );
  }
}
