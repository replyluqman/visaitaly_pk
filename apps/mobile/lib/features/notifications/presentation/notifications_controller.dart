import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/models/enums.dart';
import '../../../core/paging.dart';
import '../../../core/providers.dart';
import '../data/dto/notification_dto.dart';

/// Bell badge: one cheap grouped count. Kept alive; refreshed on resume and after any read.
final unreadCountProvider = FutureProvider<UnreadCount>((ref) => ref.watch(notificationsRepositoryProvider).unreadCount());

class NotificationsNotifier extends PagedNotifier<AppNotification> {
  NotificationsNotifier(this.tab);
  final NotificationTab tab;

  @override
  Future<PageResult<AppNotification>> fetchPage(String? cursor) async {
    final p = await ref.read(notificationsRepositoryProvider).list(tab, cursor: cursor);
    return PageResult(p.items, p.nextCursor);
  }

  /// Opening a notification marks it read (idempotent, keeps the first read time) and fixes the badge.
  Future<void> open(AppNotification n) async {
    if (n.readAt != null) return;
    replaceWhere((x) => x.id == n.id, (x) => x.copyWith(readAt: DateTime.now().toUtc().toIso8601String()));
    try {
      await ref.read(notificationsRepositoryProvider).markRead(n.id);
    } finally {
      ref.invalidate(unreadCountProvider);
    }
  }

  Future<void> markAllRead() async {
    await ref.read(notificationsRepositoryProvider).readAll(tab: tab);
    await refresh();
    ref.invalidate(unreadCountProvider);
  }
}

final notificationsProvider = NotifierProvider.autoDispose.family<NotificationsNotifier, PagedState<AppNotification>, NotificationTab>(
  NotificationsNotifier.new,
);
