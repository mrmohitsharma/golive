import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

enum LinkState { connecting, connected, reconnecting, closed }

/// Exponential backoff with jitter, shared by the WebSocket link and SRT reconnection.
class Backoff {
  Backoff({this.base = const Duration(seconds: 1), this.max = const Duration(seconds: 10), Random? random})
      : _random = random ?? Random();

  final Duration base;
  final Duration max;
  final Random _random;
  int attempt = 0;

  Duration next() {
    final exp = base.inMilliseconds * pow(2, min(attempt, 16)).toInt();
    attempt++;
    final capped = min(exp, max.inMilliseconds);
    // +/-20% jitter so 10 phones on the same cell do not reconnect in lockstep.
    final jitter = (capped * 0.2 * (_random.nextDouble() * 2 - 1)).round();
    return Duration(milliseconds: max.inMilliseconds < capped + jitter ? max.inMilliseconds : capped + jitter);
  }

  void reset() => attempt = 0;
}

/// Authenticated WebSocket to the CoGolfer server with automatic reconnection.
/// After every (re)connect it re-sends the messages returned by [onOpenMessages]
/// (subscribe / camera.join) so state is restored transparently.
class RealtimeLink {
  RealtimeLink({required this.serverUrl, required this.token, required this.onOpenMessages});

  final String serverUrl;
  final String token;
  final List<Map<String, dynamic>> Function() onOpenMessages;

  final state = ValueNotifier<LinkState>(LinkState.connecting);
  final _messages = StreamController<Map<String, dynamic>>.broadcast();
  Stream<Map<String, dynamic>> get messages => _messages.stream;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  Timer? _retry;
  Timer? _ping;
  final _backoff = Backoff();
  bool _closed = false;

  Uri get _wsUri {
    final base = serverUrl.replaceFirst(RegExp(r'^http'), 'ws');
    return Uri.parse('$base/ws');
  }

  void connect() {
    if (_closed) return;
    _retry?.cancel();
    state.value = _backoff.attempt == 0 ? LinkState.connecting : LinkState.reconnecting;
    final channel = IOWebSocketChannel.connect(
      _wsUri,
      headers: {'Authorization': 'Bearer $token'},
      pingInterval: const Duration(seconds: 20),
      connectTimeout: const Duration(seconds: 10),
    );
    _channel = channel;
    channel.ready.then((_) {
      if (_closed || _channel != channel) return;
      _backoff.reset();
      state.value = LinkState.connected;
      for (final m in onOpenMessages()) {
        send(m);
      }
    }).catchError((Object _) {
      // handled by onError / onDone below
    });
    _sub = channel.stream.listen(
      (dynamic raw) {
        try {
          final m = jsonDecode(raw as String);
          if (m is Map<String, dynamic>) _messages.add(m);
        } on Object {
          // ignore malformed frames
        }
      },
      onError: (Object _) => _scheduleReconnect(channel),
      onDone: () => _scheduleReconnect(channel),
      cancelOnError: true,
    );
    _ping?.cancel();
    _ping = Timer.periodic(const Duration(seconds: 25), (_) => send({'type': 'ping'}));
  }

  void _scheduleReconnect(WebSocketChannel channel) {
    if (_closed || _channel != channel) return;
    _channel = null;
    _sub?.cancel();
    state.value = LinkState.reconnecting;
    // 4001 = token rejected: reconnecting will not help; the UI asks the user to sign in.
    if (channel.closeCode == 4001) {
      state.value = LinkState.closed;
      _messages.add({'type': 'error', 'code': 'unauthorized', 'message': 'Session expired. Sign in again.'});
      return;
    }
    _retry = Timer(_backoff.next(), connect);
  }

  bool get isConnected => state.value == LinkState.connected;

  void send(Map<String, dynamic> message) {
    final c = _channel;
    if (c == null || (state.value != LinkState.connected && message['type'] != 'ping')) return;
    try {
      c.sink.add(jsonEncode(message));
    } on Object {
      // socket closing; reconnect logic will take over
    }
  }

  Future<void> close() async {
    _closed = true;
    _retry?.cancel();
    _ping?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close();
    state.value = LinkState.closed;
    await _messages.close();
  }
}
