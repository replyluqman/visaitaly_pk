import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/providers.dart';
import '../../../core/session/session_state.dart';
import '../../../core/ui/error_text.dart';
import 'login_controller.dart';

/// Screen 3 — Login / Signup. States: idle · loading · auth error · sign-out notice (e.g. device evicted).
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _form = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _signUp = false;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  String? _noticeText(AppLocalizations l, SignOutNotice? n) => switch (n) {
        SignOutNotice.deviceEvicted => l.noticeDeviceEvicted,
        SignOutNotice.deviceSignedOut => l.noticeDeviceSignedOut,
        SignOutNotice.deviceUnknown => l.noticeDeviceUnknown,
        SignOutNotice.accountDeleted => l.noticeAccountDeleted,
        SignOutNotice.sessionExpired => l.noticeSessionExpired,
        null => null,
      };

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    await ref.read(loginControllerProvider.notifier).submit(
          signUp: _signUp,
          email: _email.text,
          password: _password.text,
        );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final login = ref.watch(loginControllerProvider);
    final session = ref.watch(sessionControllerProvider);
    final notice = session is SessionSignedOut ? _noticeText(l, session.notice) : null;
    final busy = login.isLoading;

    return Scaffold(
      appBar: AppBar(title: Text(_signUp ? l.signupTitle : l.loginTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(24),
          children: [
            if (notice != null) _Banner(text: notice, key: const Key('signOutNotice')),
            if (login.hasError) _Banner(text: errorText(l, login.error!), error: true, key: const Key('loginError')),
            Form(
              key: _form,
              child: Column(
                children: [
                  TextFormField(
                    key: const Key('email'),
                    controller: _email,
                    keyboardType: TextInputType.emailAddress,
                    autofillHints: const [AutofillHints.email],
                    decoration: InputDecoration(labelText: l.loginEmail),
                    validator: (v) => (v == null || !v.contains('@') || v.trim().length < 5) ? l.loginInvalidEmail : null,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    key: const Key('password'),
                    controller: _password,
                    obscureText: true,
                    autofillHints: [_signUp ? AutofillHints.newPassword : AutofillHints.password],
                    decoration: InputDecoration(labelText: l.loginPassword),
                    validator: (v) => (v == null || v.length < 8) ? l.loginPasswordShort : null,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              key: const Key('submit'),
              onPressed: busy ? null : _submit,
              child: busy
                  ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2))
                  : Text(_signUp ? l.loginCreate : l.loginSignIn),
            ),
            TextButton(
              key: const Key('toggle'),
              onPressed: busy ? null : () => setState(() => _signUp = !_signUp),
              child: Text(_signUp ? l.loginToSignin : l.loginToSignup),
            ),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({required this.text, this.error = false, super.key});
  final String text;
  final bool error;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: error ? scheme.errorContainer : scheme.secondaryContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(text, style: TextStyle(color: error ? scheme.onErrorContainer : scheme.onSecondaryContainer)),
    );
  }
}
