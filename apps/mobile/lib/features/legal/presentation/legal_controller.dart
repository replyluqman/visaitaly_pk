import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/network/api_error.dart';
import '../../../core/providers.dart';
import '../data/dto/legal_dto.dart';

/// The documents still to accept, with their bodies. Loaded fresh every time the gate opens.
final pendingLegalProvider = FutureProvider.autoDispose<List<LegalDocumentResponse>>((ref) async {
  final repo = ref.watch(legalRepositoryProvider);
  final current = await repo.current();
  final pending = current.documents.where((d) => !d.accepted).toList();
  return Future.wait(pending.map((d) async {
    final doc = await repo.document(d.docType.name);
    return doc.copyWith(id: d.id); // the id the user is shown is the id they accept
  }));
});

class LegalAcceptController extends AsyncNotifier<void> {
  @override
  void build() {}

  /// Accepts exactly the versions that were displayed. If a newer version was published meanwhile the server
  /// answers VALIDATION_FAILED: reload so the user reads the new text before accepting.
  Future<void> accept(List<String> shownVersionIds, {String? appVersion}) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      try {
        await ref.read(legalRepositoryProvider).accept(shownVersionIds, appVersion: appVersion);
      } on ApiError catch (e) {
        if (e.code == ApiCodes.validationFailed) ref.invalidate(pendingLegalProvider);
        rethrow;
      }
      await ref.read(sessionControllerProvider.notifier).refresh();
    });
  }
}

final legalAcceptControllerProvider = AsyncNotifierProvider.autoDispose<LegalAcceptController, void>(LegalAcceptController.new);
