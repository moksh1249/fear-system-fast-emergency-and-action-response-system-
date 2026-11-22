import 'dart:async';
import 'dart:typed_data';

import 'package:fear_core/fear_core.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:record/record.dart';

import 'public_state.dart';

/// What came back from a voice description: the text (English, editable),
/// the words as spoken when another language was used, and the server's
/// triage preview (severity, key terms, suggested kind).
class VoiceResult {
  VoiceResult({required this.text, this.original, this.language, this.triage = const {}});

  final String text;
  final String? original;
  final String? language;
  final Map<String, dynamic> triage;

  Map<String, dynamic> get voiceMeta => {'language': language, 'original': original};
  String? get kindSuggestion => triage['kindSuggestion'] as String?;
}

/// Speak instead of typing: records up to 30 seconds from the microphone,
/// has the FEAR server transcribe it (any Indian language - it comes back in
/// English too) and pick out the important terms, then lets the person check
/// the text before using it. Nothing is sent until they press Use.
Future<VoiceResult?> describeByVoice(BuildContext context, PublicState s, {String kind = 'accident', String title = 'Describe what happened'}) {
  return showModalBottomSheet<VoiceResult>(
    context: context,
    isScrollControlled: true,
    isDismissible: false,
    builder: (_) => _VoiceSheet(state: s, kind: kind, title: title),
  );
}

enum _Phase { idle, recording, sending, review }

class _VoiceSheet extends StatefulWidget {
  const _VoiceSheet({required this.state, required this.kind, required this.title});

  final PublicState state;
  final String kind;
  final String title;

  @override
  State<_VoiceSheet> createState() => _VoiceSheetState();
}

class _VoiceSheetState extends State<_VoiceSheet> {
  static const _maxSec = 28; // Sarvam's quick transcription takes clips under 30 s
  static const _rate = 16000;

  final _rec = AudioRecorder();
  final _pcm = BytesBuilder(copy: false);
  final _text = TextEditingController();
  StreamSubscription<Uint8List>? _sub;
  StreamSubscription<Amplitude>? _ampSub;
  Timer? _timer;
  _Phase _phase = _Phase.idle;
  int _sec = 0;
  double _level = 0;
  String? _error;
  Map<String, dynamic>? _result;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _sub?.cancel();
    _ampSub?.cancel();
    _rec.dispose();
    _text.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _error = null;
      _phase = _Phase.idle;
    });
    try {
      if (!await _rec.hasPermission()) {
        setState(() => _error = 'FEAR needs the microphone to take a voice description. Allow it in the phone\'s settings, or type instead.');
        return;
      }
      _pcm.clear();
      final stream = await _rec.startStream(const RecordConfig(encoder: AudioEncoder.pcm16bits, sampleRate: _rate, numChannels: 1));
      _sub = stream.listen(_pcm.add);
      _ampSub = _rec.onAmplitudeChanged(const Duration(milliseconds: 120)).listen((a) {
        if (mounted) setState(() => _level = ((a.current + 50) / 50).clamp(0.0, 1.0));
      });
      HapticFeedback.mediumImpact();
      setState(() {
        _phase = _Phase.recording;
        _sec = 0;
      });
      _timer = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() => _sec++);
        if (_sec >= _maxSec) _stop();
      });
    } catch (e) {
      setState(() => _error = 'Could not start the microphone: $e');
    }
  }

  Future<void> _stop() async {
    if (_phase != _Phase.recording) return;
    _timer?.cancel();
    await _rec.stop();
    await _sub?.cancel();
    await _ampSub?.cancel();
    HapticFeedback.selectionClick();
    final pcm = _pcm.takeBytes();
    if (pcm.length < _rate * 2 * 0.8) {
      setState(() {
        _phase = _Phase.idle;
        _error = 'That was too short - hold on a moment longer and speak clearly.';
      });
      return;
    }
    setState(() => _phase = _Phase.sending);
    try {
      final r = await widget.state.api.postBytes('/public/voice', _wav(pcm), contentType: 'audio/wav', query: {'kind': widget.kind});
      final m = Map<String, dynamic>.from(r as Map);
      _text.text = (m['transcript'] as String?) ?? '';
      setState(() {
        _result = m;
        _phase = _Phase.review;
      });
    } on ApiException catch (e) {
      setState(() {
        _phase = _Phase.idle;
        _error = e.message;
      });
    } catch (e) {
      setState(() {
        _phase = _Phase.idle;
        _error = 'Could not reach FEAR: $e';
      });
    }
  }

  /// 16 kHz mono 16-bit PCM wrapped as a WAV file.
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
    h.setUint16(20, 1, Endian.little); // PCM
    h.setUint16(22, 1, Endian.little); // mono
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
    final t = Map<String, dynamic>.from((_result?['triage'] as Map?) ?? const {});
    final terms = List<String>.from((t['terms'] as List?) ?? const []);
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 16, 20, MediaQuery.viewInsetsOf(context).bottom + 16),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Row(children: [
          Expanded(child: Text(widget.title, style: theme.textTheme.titleLarge)),
          IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
        ]),
        if (_phase == _Phase.recording || _phase == _Phase.idle) ...[
          const SizedBox(height: 8),
          Text(
            _phase == _Phase.recording
                ? 'Listening… say what happened, how many people are hurt, and anything dangerous (fire, fuel, trapped). Any language.'
                : 'Tap the microphone and speak.',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 18),
          Center(
            child: GestureDetector(
              onTap: _phase == _Phase.recording ? _stop : _start,
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 120),
                width: 96 + _level * 36,
                height: 96 + _level * 36,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _phase == _Phase.recording ? FearColors.brand : theme.colorScheme.primary,
                  boxShadow: [BoxShadow(color: FearColors.brand.withValues(alpha: 0.35), blurRadius: 12 + _level * 24)],
                ),
                child: Icon(_phase == _Phase.recording ? Icons.stop : Icons.mic, color: Colors.white, size: 44),
              ),
            ),
          ),
          const SizedBox(height: 12),
          if (_phase == _Phase.recording)
            Text('0:${_sec.toString().padLeft(2, '0')} / 0:$_maxSec · tap to finish', textAlign: TextAlign.center, style: theme.textTheme.bodySmall),
        ],
        if (_phase == _Phase.sending)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 36),
            child: Column(children: [CircularProgressIndicator(), SizedBox(height: 12), Text('Understanding what you said…')]),
          ),
        if (_phase == _Phase.review) ...[
          const SizedBox(height: 8),
          if (t['label'] != null)
            Wrap(spacing: 6, runSpacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
              SeverityChip(score: t['severity'] as int?),
              for (final term in terms.take(6)) Chip(label: Text(term, style: const TextStyle(fontSize: 12)), visualDensity: VisualDensity.compact),
            ]),
          const SizedBox(height: 10),
          TextField(
            controller: _text,
            maxLines: 5,
            minLines: 3,
            decoration: const InputDecoration(labelText: 'What we heard - correct it if needed', border: OutlineInputBorder()),
          ),
          if (_result?['original'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text('As spoken (${_result?['language']}): ${_result?['original']}', style: theme.textTheme.bodySmall),
            ),
          const SizedBox(height: 12),
          Row(children: [
            OutlinedButton.icon(onPressed: _start, icon: const Icon(Icons.mic), label: const Text('Again')),
            const SizedBox(width: 8),
            Expanded(
              child: FilledButton.icon(
                onPressed: () {
                  final text = _text.text.trim();
                  if (text.isEmpty) return;
                  Navigator.pop(
                    context,
                    VoiceResult(
                      text: text,
                      original: _result?['original'] as String?,
                      language: _result?['language'] as String?,
                      triage: t,
                    ),
                  );
                },
                icon: const Icon(Icons.check),
                label: const Text('Use this'),
              ),
            ),
          ]),
        ],
        if (_error != null) ...[
          const SizedBox(height: 12),
          Text(_error!, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.error)),
        ],
      ]),
    );
  }
}
