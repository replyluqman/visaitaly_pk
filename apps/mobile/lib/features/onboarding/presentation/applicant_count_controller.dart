import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';

class ApplicantCountController extends AsyncNotifier<void> {
  @override
  void build() {}

  /// Screen 5. The server stores the intent and recomputes `onboardingState`; the router follows the new snapshot.
  Future<void> submit(int count) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(applicantsRepositoryProvider).setApplicantCount(count);
      await ref.read(sessionControllerProvider.notifier).refresh();
    });
  }
}

final applicantCountControllerProvider =
    AsyncNotifierProvider.autoDispose<ApplicantCountController, void>(ApplicantCountController.new);
