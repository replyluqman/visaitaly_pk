import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/components.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/network/api_error.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import '../../../core/ui/labels.dart';
import '../../applicants/presentation/applicants_controller.dart';
import '../../checklist/presentation/paywall_sheet.dart';
import '../../documents/data/dto/document_dto.dart';
import 'today_controller.dart';

/// The sentence for an action, built on the client from structured data — the server holds no English.
String todaySentence(AppLocalizations l, TodayAction a, String locale) {
  final title = a.title ?? l.todayItemFallback;
  return switch (a.reason) {
    TodayReason.documentExpires => l.todayExpiringDoc(title, formatYmd(a.dueDate, locale)),
    TodayReason.nullaOstaExpires => l.todayNullaExpires(formatYmd(a.dueDate, locale)),
    TodayReason.blocksSubmission => l.todayBlocking(title),
    TodayReason.issueFound => l.todayIssue(title),
    TodayReason.inProgress => l.todayInProgress(title),
    TodayReason.notStarted || TodayReason.unknown => l.todayNotStarted(title),
  };
}

/// Screen 9 — the direct answer to "what should I do next?". Premium only: free/expired accounts see the
/// paywall preview, not an error. States: actions · all clear · not computed yet · locked.
class TodayScreen extends ConsumerWidget {
  const TodayScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).toLanguageTag();
    final today = ref.watch(todayProvider);
    final names = {for (final a in ref.watch(applicantsProvider).value?.applicants ?? const []) a.id: a.displayName};

    return Scaffold(
      appBar: GlassAppBar(title: l.todayTitle),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(todayProvider);
          await ref.read(todayProvider.future).catchError((_) => const TodayResponse());
        },
        child: today.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => e is ApiError && e.code == ApiCodes.premiumRequired
              ? EmptyState(
                  key: const Key('todayLocked'),
                  icon: Icons.lock_outline,
                  message: l.premiumRequired,
                  action: FilledButton(onPressed: () => showPaywallPreview(context), child: Text(l.paywallTitle)),
                )
              : ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
                  const SizedBox(height: Sp.x4),
                  Center(child: Text(errorText(l, e))),
                  Center(child: TextButton(onPressed: () => ref.invalidate(todayProvider), child: Text(l.commonRetry))),
                ]),
          data: (t) {
            if (t.actions.isNotEmpty) {
              return ListView.separated(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.all(Sp.gutter),
                itemCount: t.actions.length,
                separatorBuilder: (_, _) => const SizedBox(height: Sp.s),
                itemBuilder: (_, i) {
                  final a = t.actions[i];
                  final p = context.vip;
                  final color = switch (a.kind) {
                    TodayKind.expiring => p.badgeNeedsReview,
                    TodayKind.blocking => p.badgeBlocking,
                    _ => p.lagoon,
                  };
                  return TintCard(
                    key: Key('action_$i'),
                    onTap: () {
                      final link = safeDeepLink(a.deepLink);
                      if (link != null) context.push(link);
                    },
                    child: Row(children: [
                      Icon(switch (a.kind) { TodayKind.expiring => Icons.schedule, TodayKind.blocking => Icons.lock_outline, _ => Icons.arrow_circle_right_outlined }, color: color),
                      const SizedBox(width: Sp.m),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          Text(todaySentence(l, a, locale), style: VipType.headline),
                          if (names[a.applicantId] != null && names.length > 1)
                            Text(l.todayFor(names[a.applicantId]!), style: VipType.caption.copyWith(color: p.textSecondary)),
                        ]),
                      ),
                      const Icon(Icons.chevron_right),
                    ]),
                  );
                },
              );
            }
            // Nothing to list. "Not computed yet" and "all clear" are different answers and must not be conflated.
            if (t.allClear == null) {
              return ListView(physics: const AlwaysScrollableScrollPhysics(), children: [EmptyState(key: const Key('todayPreparing'), icon: Icons.hourglass_empty, message: l.todayPreparing)]);
            }
            final next = t.allClear!.nextStage;
            return ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
              EmptyState(
                key: const Key('todayAllClear'),
                icon: Icons.check_circle_outline,
                message: next == null || next == JourneyStage.unknown ? l.todayAllClear : l.todayAllClearNext(journeyLabel(l, next)),
              ),
            ]);
          },
        ),
      ),
    );
  }
}
