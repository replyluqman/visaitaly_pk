import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';

/// Sign-in / sign-up against Firebase. It does NOT talk to the API: once Firebase reports a user, the
/// SessionController registers the device and loads the snapshot, and the router reacts.
class LoginController extends AsyncNotifier<void> {
  @override
  void build() {}

  Future<void> submit({required bool signUp, required String email, required String password}) async {
    state = const AsyncLoading();
    final auth = ref.read(authGatewayProvider);
    state = await AsyncValue.guard(
      () => signUp ? auth.signUpWithEmail(email.trim(), password) : auth.signInWithEmail(email.trim(), password),
    );
  }
}

final loginControllerProvider = AsyncNotifierProvider.autoDispose<LoginController, void>(LoginController.new);
