import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/network/api_error.dart';
import '../../../core/paging.dart';
import '../../../core/file_picker_gateway.dart';
import '../../../core/providers.dart';
import '../../applicants/presentation/applicants_controller.dart';
import '../../documents/data/dto/document_dto.dart';
import '../../documents/presentation/documents_controller.dart';
import '../../today/presentation/today_controller.dart';
import '../data/checklist_repository.dart';
import '../data/dto/checklist_dto.dart';

class ChecklistArgs {
  const ChecklistArgs(this.applicantId, [this.filter = const ChecklistFilter()]);
  final String applicantId;
  final ChecklistFilter filter;

  @override
  bool operator ==(Object other) => other is ChecklistArgs && other.applicantId == applicantId && other.filter == filter;
  @override
  int get hashCode => Object.hash(applicantId, filter);
}

/// The case file list (Screen 10): keyset-paged, server-side filters. `meta` carries `lockedCount`.
class ChecklistNotifier extends PagedNotifier<ChecklistItem> {
  ChecklistNotifier(this.args);
  final ChecklistArgs args;

  @override
  Future<PageResult<ChecklistItem>> fetchPage(String? cursor) async {
    final r = await ref.read(checklistRepositoryProvider).list(args.applicantId, filter: args.filter, cursor: cursor);
    return PageResult(r.items, r.nextCursor, meta: r.lockedCount);
  }
}

final checklistProvider =
    NotifierProvider.autoDispose.family<ChecklistNotifier, PagedState<ChecklistItem>, ChecklistArgs>(ChecklistNotifier.new);

extension LockedCount on PagedState<ChecklistItem> {
  int get lockedCount => (meta as int?) ?? 0;
}

final checklistItemProvider = FutureProvider.autoDispose.family<ChecklistItemDetail, String>(
  (ref, id) => ref.watch(checklistRepositoryProvider).detail(id),
);

final journeyProvider = FutureProvider.autoDispose.family<JourneyResponse, String>(
  (ref, applicantId) => ref.watch(checklistRepositoryProvider).journey(applicantId),
);

/// Writes on a checklist item. Every write re-reads what the screens show (detail, list, readiness) so the
/// numbers on the dashboard never disagree with the item.
class ItemActions extends AsyncNotifier<void> {
  @override
  void build() {}

  void _refreshViews(String itemId, String? applicantId) {
    ref.invalidate(checklistItemProvider(itemId));
    ref.invalidate(checklistProvider);
    ref.invalidate(applicantsProvider);
    ref.invalidate(todayProvider);
    ref.invalidate(documentsProvider);
  }

  Future<void> setStatus(ChecklistItemDetail item, ItemStatus status) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(checklistRepositoryProvider).setStatus(item.id, status);
      _refreshViews(item.id, null);
    });
  }

  Future<void> acknowledgeReview(String itemId) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(checklistRepositoryProvider).acknowledgeReview(itemId);
      _refreshViews(itemId, null);
    });
  }

  /// Pick → upload → attach to this item. A cancelled pick is not an error.
  Future<bool> addDocument(ChecklistItemDetail item, String applicantId) async {
    state = const AsyncLoading();
    var uploaded = false;
    state = await AsyncValue.guard(() async {
      final picked = await ref.read(filePickerProvider).pick();
      if (picked == null) return;
      await ref.read(documentsRepositoryProvider).upload(
            applicantId: applicantId,
            bytes: picked.bytes,
            mime: picked.mime,
            checklistItemId: item.id,
          );
      uploaded = true;
      _refreshViews(item.id, applicantId);
    });
    return uploaded;
  }

  Future<void> deleteDocument(DocumentDto doc, String itemId) async {
    state = const AsyncLoading();
    state = await AsyncValue.guard(() async {
      await ref.read(documentsRepositoryProvider).delete(doc.id);
      _refreshViews(itemId, doc.applicantId);
    });
  }
}

final itemActionsProvider = AsyncNotifierProvider.autoDispose<ItemActions, void>(ItemActions.new);

extension PremiumGate on Object? {
  bool get isPremiumRequired => this is ApiError && (this as ApiError).code == ApiCodes.premiumRequired;
}
