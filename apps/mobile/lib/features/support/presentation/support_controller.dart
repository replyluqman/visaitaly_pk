import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/file_picker_gateway.dart';
import '../../../core/models/enums.dart';
import '../../../core/paging.dart';
import '../../../core/providers.dart';
import '../data/dto/support_dto.dart';

final supportThreadProvider = FutureProvider.autoDispose<SupportThreadView>((ref) => ref.watch(supportRepositoryProvider).thread());

/// Messages arrive newest-first; the screen shows them in a reversed list (newest at the bottom).
class SupportMessagesNotifier extends PagedNotifier<SupportMessage> {
  @override
  Future<PageResult<SupportMessage>> fetchPage(String? cursor) async {
    final p = await ref.read(supportRepositoryProvider).messages(cursor: cursor);
    return PageResult(p.items, p.nextCursor);
  }
}

final supportMessagesProvider = NotifierProvider.autoDispose<SupportMessagesNotifier, PagedState<SupportMessage>>(SupportMessagesNotifier.new);

/// Opening the thread marks the admin replies as read.
final supportMarkReadProvider = FutureProvider.autoDispose<void>((ref) async {
  await ref.watch(supportRepositoryProvider).markRead();
  ref.invalidate(supportThreadProvider);
});

class SupportActions extends AsyncNotifier<void> {
  PickedFile? attachment;

  @override
  void build() {}

  Future<void> pickImage() async {
    final picked = await ref.read(filePickerProvider).pick(imagesOnly: true);
    if (picked != null) {
      attachment = picked;
      ref.notifyListeners();
    }
  }

  void clearAttachment() {
    attachment = null;
    ref.notifyListeners();
  }

  /// Uploads the image first (if any), then sends. NOT retried: a duplicate send would be a duplicate message.
  Future<bool> send({required String body, required SupportTopic topic, String? applicantId}) async {
    state = const AsyncLoading();
    var sent = false;
    state = await AsyncValue.guard(() async {
      final repo = ref.read(supportRepositoryProvider);
      String? attachmentId;
      final a = attachment;
      if (a != null) attachmentId = await repo.uploadAttachment(bytes: a.bytes, mime: a.mime);
      await repo.send(body: body.trim(), topic: topic, applicantId: applicantId, attachmentId: attachmentId);
      attachment = null;
      sent = true;
      ref.invalidate(supportThreadProvider);
      await ref.read(supportMessagesProvider.notifier).refresh();
    });
    return sent;
  }
}

final supportActionsProvider = AsyncNotifierProvider.autoDispose<SupportActions, void>(SupportActions.new);
