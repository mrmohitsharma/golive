import 'package:cogolfer_live/core/join_link.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('website login QR is recognised; join posters are not login links', () {
    final l = parseLoginLink('https://icca.co.in/app/login/AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(l?.server, 'https://icca.co.in');
    expect(l?.code, 'AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(parseLoginLink('https://icca.co.in/join/ABC123'), isNull);
    expect(parseLoginLink('https://icca.co.in/app/login/short'), isNull);
    expect(parseJoinLink('https://icca.co.in/join/ABC123')?.code, 'ABC123');
  });
}
