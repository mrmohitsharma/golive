import 'package:cogolfer_live/core/models.dart';
import 'package:cogolfer_live/core/session.dart';
import 'package:cogolfer_live/features/auth/login_screen.dart';
import 'package:cogolfer_live/features/director/production_sheets.dart';
import 'package:cogolfer_live/features/home/home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('first screen is volunteer join, with QR scan and validation', (tester) async {
    final session = Session()..loaded = true;
    await tester.pumpWidget(MaterialApp(home: LoginScreen(session: session)));
    expect(find.text('Go Live'), findsOneWidget);
    expect(find.text('Scan QR poster'), findsOneWidget);
    await tester.tap(find.text('Join tournament'));
    await tester.pump();
    expect(find.textContaining('Enter the server address'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Server'), 'live.club.in');
    await tester.tap(find.text('Join tournament'));
    await tester.pump();
    expect(find.textContaining('Enter the code from the organiser'), findsOneWidget);
  });

  testWidgets('sign-up asks for club details and a long password', (tester) async {
    final session = Session()..loaded = true;
    await tester.pumpWidget(MaterialApp(home: LoginScreen(session: session)));
    await tester.tap(find.text('New club'));
    await tester.pump();
    expect(find.widgetWithText(TextField, 'Club or organisation'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Server'), 'live.club.in');
    await tester.enterText(find.widgetWithText(TextField, 'Your name'), 'Mohit');
    await tester.enterText(find.widgetWithText(TextField, 'Club or organisation'), 'DLF Golf');
    await tester.enterText(find.widgetWithText(TextField, 'Email'), 'm@club.in');
    await tester.enterText(find.widgetWithText(TextField, 'Password (8+ characters)'), 'short');
    await tester.tap(find.text('Create account'));
    await tester.pump();
    expect(find.textContaining('at least 8 characters'), findsOneWidget);
  });

  testWidgets('an account with no organisation is offered to create one', (tester) async {
    final session = Session()
      ..loaded = true
      ..serverUrl = 'https://x.test'
      ..token = 't'
      ..user = const AppUser(id: 'u', email: 'u@x', name: 'Mohit');
    await tester.pumpWidget(MaterialApp(home: HomeScreen(session: session)));
    await tester.pump();
    expect(find.text('Hi Mohit'), findsOneWidget);
    expect(find.text('Create organisation'), findsOneWidget);
    expect(find.text('New tournament'), findsNothing);
  });

  testWidgets('owners get “New tournament” and the organisation button', (tester) async {
    final session = Session()
      ..loaded = true
      ..serverUrl = 'https://x.test'
      ..token = 't'
      ..user = const AppUser(id: 'u', email: 'u@x', name: 'Mohit')
      ..orgs = const [OrgMembership(id: 'o1', name: 'DLF Golf', role: TournamentRole.owner)];
    await tester.pumpWidget(MaterialApp(home: HomeScreen(session: session)));
    await tester.pump();
    expect(find.text('DLF Golf'), findsOneWidget);
    expect(find.text('New tournament'), findsOneWidget);
    expect(find.byTooltip('Organisation: staff and YouTube'), findsOneWidget);
  });

  testWidgets('level meter maps dBFS to a bar', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Column(children: [LevelMeter(db: -30), LevelMeter(db: null)]))));
    final bars = tester.widgetList<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).toList();
    expect(bars[0].value, closeTo(0.5, 1e-9));
    expect(bars[1].value, 0);
  });
}
