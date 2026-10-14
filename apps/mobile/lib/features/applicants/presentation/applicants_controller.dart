import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/providers.dart';
import '../data/applicants_repository.dart';
import '../data/dto/applicant_dto.dart';

final applicantsProvider = FutureProvider.autoDispose<ApplicantListResponse>(
  (ref) => ref.watch(applicantsRepositoryProvider).list(),
);

/// Cached for the app's life: relationships change rarely (docs/API-CONTRACT.md).
final relationshipsProvider = FutureProvider<List<RelationshipOption>>(
  (ref) => ref.watch(applicantsRepositoryProvider).relationships(),
);

class AddApplicantController extends AsyncNotifier<void> {
  @override
  void build() {}

  Future<void> submit(NewApplicant input) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(applicantsRepositoryProvider).create(input);
      ref.invalidate(applicantsProvider);
      await ref.read(sessionControllerProvider.notifier).refresh();
    });
  }
}

final addApplicantControllerProvider = AsyncNotifierProvider.autoDispose<AddApplicantController, void>(AddApplicantController.new);

/// Screen 7's eight choices, each mapping onto the canonical `(currentStage, nullaOstaStatus)` pair.
/// "Nulla Osta in process" and "received" are the SAME stage with different tracker state (invariant 5).
enum StageChoice {
  planning(JourneyStage.eligibility, null),
  nullaOstaInProcess(JourneyStage.nullaOsta, NullaOstaStatus.inProcess),
  nullaOstaReceived(JourneyStage.nullaOsta, NullaOstaStatus.received),
  documents(JourneyStage.documents, null),
  appointment(JourneyStage.appointment, null),
  submitted(JourneyStage.application, null),
  processing(JourneyStage.processing, null),
  decision(JourneyStage.decision, null);

  const StageChoice(this.stage, this.nullaOsta);
  final JourneyStage stage;
  final NullaOstaStatus? nullaOsta;
}

class SetStageController extends AsyncNotifier<void> {
  @override
  void build() {}

  /// Tracker state first, stage last: setting the stage is what completes onboarding, and both calls are
  /// idempotent, so a retry after a half-failure is safe.
  Future<void> submit(Applicant applicant, StageChoice choice) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      final repo = ref.read(applicantsRepositoryProvider);
      final status = choice.nullaOsta;
      if (status != null && applicant.nullaOsta.status != status) {
        await repo.patch(applicant.id, {'nullaOstaStatus': wire(status)});
      }
      await repo.setStage(applicant.id, choice.stage);
      ref.invalidate(applicantsProvider);
      await ref.read(sessionControllerProvider.notifier).refresh();
    });
  }
}

final setStageControllerProvider = AsyncNotifierProvider.autoDispose<SetStageController, void>(SetStageController.new);
