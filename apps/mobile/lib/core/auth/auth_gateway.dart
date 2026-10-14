import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';

class AuthUser {
  const AuthUser({required this.uid, this.email});
  final String uid;
  final String? email;
}

enum AuthFailureReason { invalidCredentials, userDisabled, emailInUse, weakPassword, invalidEmail, network, tooManyRequests, unknown }

class AuthFailure implements Exception {
  const AuthFailure(this.reason);
  final AuthFailureReason reason;
  @override
  String toString() => 'AuthFailure(${reason.name})';
}

/// The only seam to Firebase. Everything else (interceptors, session, tests) talks to this interface, so the
/// app logic is testable without a Firebase project and the SDK can be swapped without touching features.
abstract class AuthGateway {
  /// Emits the current user (or null) first, then every change.
  Stream<AuthUser?> authStateChanges();

  /// A valid Firebase ID token. Firebase refreshes it when near expiry; [forceRefresh] bypasses the cache.
  Future<String?> idToken({bool forceRefresh = false});

  Future<void> signInWithEmail(String email, String password);
  Future<void> signUpWithEmail(String email, String password);
  Future<void> signOut();
}

class FirebaseAuthGateway implements AuthGateway {
  FirebaseAuthGateway(this._auth);
  final FirebaseAuth _auth;

  @override
  Stream<AuthUser?> authStateChanges() => _auth.authStateChanges().map(
        (u) => u == null ? null : AuthUser(uid: u.uid, email: u.email),
      );

  @override
  Future<String?> idToken({bool forceRefresh = false}) async => _auth.currentUser?.getIdToken(forceRefresh);

  @override
  Future<void> signInWithEmail(String email, String password) =>
      _guard(() => _auth.signInWithEmailAndPassword(email: email, password: password));

  @override
  Future<void> signUpWithEmail(String email, String password) =>
      _guard(() => _auth.createUserWithEmailAndPassword(email: email, password: password));

  @override
  Future<void> signOut() => _auth.signOut();

  Future<void> _guard(Future<Object?> Function() f) async {
    try {
      await f();
    } on FirebaseAuthException catch (e) {
      throw AuthFailure(reasonFor(e.code));
    }
  }

  static AuthFailureReason reasonFor(String code) => switch (code) {
        'invalid-credential' || 'wrong-password' || 'user-not-found' || 'invalid-login-credentials' => AuthFailureReason.invalidCredentials,
        'user-disabled' => AuthFailureReason.userDisabled,
        'email-already-in-use' => AuthFailureReason.emailInUse,
        'weak-password' => AuthFailureReason.weakPassword,
        'invalid-email' => AuthFailureReason.invalidEmail,
        'network-request-failed' => AuthFailureReason.network,
        'too-many-requests' => AuthFailureReason.tooManyRequests,
        _ => AuthFailureReason.unknown,
      };
}
