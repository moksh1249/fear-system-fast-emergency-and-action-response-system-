import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// Full-screen camera that reads a FEAR QR code (issued from FEAR Command's
/// Phones panel). [onCode] gets the raw text and returns an error message
/// to show, or null when the code worked - the screen then closes.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key, required this.title, required this.onCode});

  final String title;
  final Future<String?> Function(String raw) onCode;

  static Future<bool> open(BuildContext context, {required String title, required Future<String?> Function(String raw) onCode}) async {
    final r = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => QrScanScreen(title: title, onCode: onCode)));
    return r ?? false;
  }

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_busy) return;
    final raw = capture.barcodes.map((b) => b.rawValue).whereType<String>().firstOrNull;
    if (raw == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await widget.onCode(raw);
    if (!mounted) return;
    if (err == null) {
      Navigator.of(context).pop(true);
    } else {
      setState(() {
        _busy = false;
        _error = err;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      backgroundColor: Colors.black,
      body: Stack(children: [
        MobileScanner(controller: _controller, onDetect: _onDetect),
        Center(
          child: Container(
            width: 250,
            height: 250,
            decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 3), borderRadius: BorderRadius.circular(16)),
          ),
        ),
        Positioned(
          left: 16,
          right: 16,
          bottom: 32,
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(14),
              child: _busy
                  ? const Row(children: [
                      SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2)),
                      SizedBox(width: 12),
                      Expanded(child: Text('Connecting to the FEAR server...')),
                    ])
                  : Text(
                      _error ?? 'Point the camera at the QR code shown in FEAR Command (Phones panel).',
                      style: TextStyle(color: _error != null ? Theme.of(context).colorScheme.error : null),
                    ),
            ),
          ),
        ),
      ]),
    );
  }
}
