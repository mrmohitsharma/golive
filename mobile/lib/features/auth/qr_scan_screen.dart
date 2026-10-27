import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../core/join_link.dart';

/// Scans the organiser's QR poster and returns the join link (server + code).
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode], detectionSpeed: DetectionSpeed.noDuplicates);
  bool _done = false;
  String? _hint;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final raw = b.rawValue;
      if (raw == null) continue;
      final link = parseJoinLink(raw);
      if (link != null) {
        _done = true;
        Navigator.of(context).pop(link);
        return;
      }
    }
    setState(() => _hint = 'That QR code is not a Go Live join code.');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(title: const Text('Scan the QR poster'), backgroundColor: Colors.black, foregroundColor: Colors.white),
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(controller: _controller, onDetect: _onDetect),
          Center(
            child: Container(
              width: 240,
              height: 240,
              decoration: BoxDecoration(border: Border.all(color: Colors.white, width: 3), borderRadius: BorderRadius.circular(16)),
            ),
          ),
          Positioned(
            left: 24,
            right: 24,
            bottom: 40,
            child: Text(
              _hint ?? 'Point the camera at the QR code from the organiser.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 16, shadows: [Shadow(blurRadius: 6)]),
            ),
          ),
        ],
      ),
    );
  }
}
