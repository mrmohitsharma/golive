import 'package:flutter/material.dart';

import 'core/session.dart';
import 'features/auth/login_screen.dart';
import 'features/home/home_screen.dart';
import 'ui/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final session = Session();
  runApp(CoGolferLiveApp(session: session));
  session.load();
}

class CoGolferLiveApp extends StatelessWidget {
  const CoGolferLiveApp({super.key, required this.session});
  final Session session;

  @override
  Widget build(BuildContext context) {
    final scheme = ColorScheme.fromSeed(seedColor: Broadcast.course, brightness: Brightness.dark);
    return MaterialApp(
      title: 'Go Live',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: scheme,
        useMaterial3: true,
        inputDecorationTheme: const InputDecorationTheme(border: OutlineInputBorder()),
      ),
      home: ListenableBuilder(
        listenable: session,
        builder: (context, _) {
          if (!session.loaded) return const Scaffold(body: Center(child: CircularProgressIndicator()));
          if (!session.signedIn) return LoginScreen(session: session);
          // Keyed by identity so switching account / joining another tournament rebuilds the tree.
          final g = session.guest;
          if (g != null) return GuestHome(key: ValueKey('guest:${g.id}:${g.tournament.id}'), session: session);
          return HomeScreen(key: ValueKey('user:${session.user!.id}'), session: session);
        },
      ),
    );
  }
}
