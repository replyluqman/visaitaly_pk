import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/components.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import 'notifications_controller.dart';

/// Screen 13 — one persistent inbox, three tabs. Neon is the record; a missed push loses nothing.
class NotificationsScreen extends ConsumerWidget {
  const NotificationsScreen({super.key});

  static const tabs = [NotificationTab.reminder, NotificationTab.update, NotificationTab.activity];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final counts = ref.watch(unreadCountProvider).value;
    String label(NotificationTab t, String text) {
      final n = switch (t) {
        NotificationTab.reminder => counts?.byTab.reminder ?? 0,
        NotificationTab.update => counts?.byTab.update ?? 0,
        _ => counts?.byTab.activity ?? 0,
      };
      return n > 0 ? '$text ($n)' : text;
    }

    return DefaultTabController(
      length: tabs.length,
      child: Scaffold(
        appBar: PreferredSize(
          preferredSize: const Size.fromHeight(kToolbarHeight + 48),
          child: Column(children: [
            GlassAppBar(title: l.notifTitle, showBell: false),
            Material(
              color: Colors.transparent,
              child: TabBar(tabs: [
                Tab(key: const Key('tab_reminder'), text: label(NotificationTab.reminder, l.tabReminders)),
                Tab(key: const Key('tab_update'), text: label(NotificationTab.update, l.tabUpdates)),
                Tab(key: const Key('tab_activity'), text: label(NotificationTab.activity, l.tabActivity)),
              ]),
            ),
          ]),
        ),
        body: TabBarView(children: [for (final t in tabs) _TabList(tab: t)]),
      ),
    );
  }
}

class _TabList extends ConsumerStatefulWidget {
  const _TabList({required this.tab});
  final NotificationTab tab;

  @override
  ConsumerState<_TabList> createState() => _TabListState();
}

class _TabListState extends ConsumerState<_TabList> {
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) {
        ref.read(notificationsProvider(widget.tab).notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final state = ref.watch(notificationsProvider(widget.tab));
    final notifier = ref.read(notificationsProvider(widget.tab).notifier);

    if (state.loadingFirst) return const Center(child: CircularProgressIndicator());
    if (state.error != null && state.items.isEmpty) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(errorText(l, state.error!)),
          TextButton(onPressed: notifier.refresh, child: Text(l.commonRetry)),
        ]),
      );
    }
    if (state.items.isEmpty) {
      return RefreshIndicator(
        onRefresh: notifier.refresh,
        child: ListView(children: [EmptyState(key: Key('empty_${widget.tab.name}'), icon: Icons.notifications_none, message: l.notifEmpty)]),
      );
    }
    final hasUnread = state.items.any((n) => n.readAt == null);
    return RefreshIndicator(
      onRefresh: notifier.refresh,
      child: ListView.separated(
        controller: _scroll,
        padding: const EdgeInsets.all(Sp.gutter),
        itemCount: state.items.length + 1,
        separatorBuilder: (_, _) => const SizedBox(height: Sp.s),
        itemBuilder: (_, i) {
          if (i == state.items.length) {
            return Column(children: [
              if (state.loadingMore) const Padding(padding: EdgeInsets.all(Sp.l), child: CircularProgressIndicator()),
              if (hasUnread) TextButton(key: const Key('markAll'), onPressed: notifier.markAllRead, child: Text(l.notifMarkAll)),
            ]);
          }
          final n = state.items[i];
          final unread = n.readAt == null;
          return TintCard(
            key: Key('notif_${n.id}'),
            onTap: () async {
              await notifier.open(n);
              final link = safeDeepLink(n.deepLink);
              if (link != null && context.mounted) context.push(link);
            },
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Padding(
                padding: const EdgeInsets.only(top: 6, right: Sp.m),
                child: Icon(Icons.circle, size: 10, color: unread ? p.lagoon : Colors.transparent, semanticLabel: unread ? 'unread' : null),
              ),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(n.title, style: unread ? VipType.headline : VipType.body),
                  const SizedBox(height: Sp.xs),
                  Text(n.body, style: VipType.body.copyWith(color: p.textSecondary)),
                  const SizedBox(height: Sp.xs),
                  Text(formatInstant(n.createdAt, locale), style: VipType.caption.copyWith(color: p.textSecondary)),
                ]),
              ),
            ]),
          );
        },
      ),
    );
  }
}
