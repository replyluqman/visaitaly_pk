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
import '../../applicants/data/dto/applicant_dto.dart';
import '../../applicants/presentation/applicants_controller.dart';
import '../data/checklist_repository.dart';
import 'checklist_controller.dart';
import 'checklist_widgets.dart';
import 'paywall_sheet.dart';

/// Screen 10 — Applicant Case View: readiness, personalization line, Nulla Osta card (expands in place),
/// the case file list with search + filters, locked rows on the free tier, greyed N/A rows with their reason.
class CaseViewScreen extends ConsumerStatefulWidget {
  const CaseViewScreen({required this.applicantId, super.key});
  final String applicantId;

  @override
  ConsumerState<CaseViewScreen> createState() => _CaseViewScreenState();
}

class _CaseViewScreenState extends ConsumerState<CaseViewScreen> {
  ChecklistFilter _filter = const ChecklistFilter();
  String _query = '';
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 400) {
        ref.read(checklistProvider(ChecklistArgs(widget.applicantId, _filter)).notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  ChecklistArgs get _args => ChecklistArgs(widget.applicantId, _filter);

  Future<void> _refresh() async {
    ref.invalidate(applicantsProvider);
    await ref.read(checklistProvider(_args).notifier).refresh();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final applicants = ref.watch(applicantsProvider);
    final list = ref.watch(checklistProvider(_args));
    final applicant = applicants.value?.applicants.where((a) => a.id == widget.applicantId).firstOrNull;

    final q = _query.trim().toLowerCase();
    final visible = q.isEmpty ? list.items : list.items.where((i) => i.title.toLowerCase().contains(q)).toList();

    return Scaffold(
      appBar: GlassAppBar(title: applicant?.displayName ?? l.caseTitle),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: CustomScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            if (applicant != null) SliverToBoxAdapter(child: _Header(applicant: applicant)),
            SliverToBoxAdapter(child: _SearchAndFilters(
              filter: _filter,
              onFilter: (f) => setState(() => _filter = f),
              onQuery: (v) => setState(() => _query = v),
            )),
            if (list.loadingFirst)
              const SliverFillRemaining(hasScrollBody: false, child: Center(child: CircularProgressIndicator()))
            else if (list.error != null && list.items.isEmpty)
              SliverFillRemaining(
                hasScrollBody: false,
                child: Center(
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Text(errorText(l, list.error!), textAlign: TextAlign.center),
                    const SizedBox(height: Sp.m),
                    FilledButton(onPressed: () => ref.read(checklistProvider(_args).notifier).refresh(), child: Text(l.commonRetry)),
                  ]),
                ),
              )
            else ...[
              if (visible.isEmpty && list.lockedCount == 0)
                SliverFillRemaining(hasScrollBody: false, child: EmptyState(message: l.caseNoResults, icon: Icons.search_off))
              else
                SliverPadding(
                  padding: const EdgeInsets.symmetric(horizontal: Sp.gutter),
                  sliver: SliverList.separated(
                    itemCount: visible.length,
                    separatorBuilder: (_, _) => const SizedBox(height: Sp.s),
                    itemBuilder: (_, i) => ChecklistRow(item: visible[i], onTap: () => context.push(Routes.item(visible[i].id))),
                  ),
                ),
              if (list.loadingMore) const SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(Sp.l), child: Center(child: CircularProgressIndicator()))),
              if (list.error != null && list.items.isNotEmpty)
                SliverToBoxAdapter(
                  child: TextButton(onPressed: () => ref.read(checklistProvider(_args).notifier).loadMore(), child: Text(l.commonRetry)),
                ),
              if (list.lockedCount > 0)
                SliverPadding(
                  padding: const EdgeInsets.all(Sp.gutter),
                  sliver: SliverToBoxAdapter(child: LockedRows(count: list.lockedCount, onTap: () => showPaywallPreview(context))),
                ),
              const SliverToBoxAdapter(child: SizedBox(height: Sp.x3)),
            ],
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.applicant});
  final Applicant applicant;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final r = applicant.readiness;
    final generated = applicant.caseGeneratedAt != null;
    return Padding(
      padding: const EdgeInsets.all(Sp.gutter),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (generated) ...[
          Row(children: [
            ReadinessRing(percent: r.percent, blocking: r.blockingCount),
            const SizedBox(width: Sp.l),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(l.homeBlocking(r.blockingCount), key: const Key('blockingCount'), style: VipType.headline),
                const SizedBox(height: Sp.xs),
                // "23 requirements · 4 specific to Spouse category · 2 not applicable to you"
                Text(
                  l.casePersonalization(
                    r.applicableCount + r.notApplicableCount,
                    r.categorySpecificCount,
                    categoryLabel(l, wire(applicant.relationshipCategory)),
                    r.notApplicableCount,
                  ),
                  key: const Key('personalization'),
                  style: VipType.caption.copyWith(color: p.textSecondary),
                ),
              ]),
            ),
          ]),
        ] else
          Text(l.homeCasePreparing),
        if (!applicant.access.canWrite)
          Padding(
            padding: const EdgeInsets.only(top: Sp.m),
            child: Text(
              applicant.access.level == AccessLevel.graceReadOnly ? l.homeGraceBanner : l.homeReadOnlyBanner,
              key: const Key('readOnlyBanner'),
              style: TextStyle(color: p.statusIssueFound),
            ),
          ),
        const SizedBox(height: Sp.m),
        _NullaOstaCard(applicant: applicant),
        const SizedBox(height: Sp.m),
        Wrap(spacing: Sp.s, children: [
          ActionChip(
            key: const Key('openJourney'),
            avatar: const Icon(Icons.timeline, size: 18),
            label: Text(l.caseJourney),
            onPressed: () => context.push(Routes.journey(applicant.id)),
          ),
          ActionChip(
            avatar: const Icon(Icons.verified_outlined, size: 18),
            label: Text(l.caseVerify),
            onPressed: () => context.push(Routes.verify),
          ),
        ]),
      ]),
    );
  }
}

class _NullaOstaCard extends StatelessWidget {
  const _NullaOstaCard({required this.applicant});
  final Applicant applicant;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final n = applicant.nullaOsta;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final days = n.daysRemaining;
    final status = switch (n.status) {
      NullaOstaStatus.notStarted => l.nullaNotStarted,
      NullaOstaStatus.inProcess => l.nullaInProcess,
      NullaOstaStatus.received => l.nullaReceived,
      NullaOstaStatus.notApplicable => l.nullaNotApplicable,
      NullaOstaStatus.unknown => l.nullaUnknown,
    };
    return Card(
      child: ExpansionTile(
        key: const Key('nullaCard'),
        shape: const Border(),
        collapsedShape: const Border(),
        title: Text('${l.nullaCardTitle} · $status', style: VipType.headline),
        subtitle: days == null
            ? null
            : Text(
                days >= 0 ? l.nullaDaysLeft(days) : l.nullaExpiredAgo(-days),
                key: const Key('nullaDays'),
                style: VipType.caption.copyWith(color: days < 0 ? p.statusIssueFound : p.textSecondary),
              ),
        childrenPadding: const EdgeInsets.fromLTRB(Sp.l, 0, Sp.l, Sp.l),
        expandedAlignment: Alignment.centerLeft,
        children: [
          if (n.issueDate == null && n.expiryDate == null)
            Text(l.nullaNoDates)
          else ...[
            if (n.issueDate != null) Text(l.nullaIssued(formatYmd(n.issueDate, locale))),
            if (n.expiryDate != null) Text(l.nullaExpires(formatYmd(n.expiryDate, locale))),
          ],
        ],
      ),
    );
  }
}

class _SearchAndFilters extends StatelessWidget {
  const _SearchAndFilters({required this.filter, required this.onFilter, required this.onQuery});
  final ChecklistFilter filter;
  final ValueChanged<ChecklistFilter> onFilter;
  final ValueChanged<String> onQuery;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    Widget chip(Key k, String label, bool selected, VoidCallback onTap) =>
        FilterChip(key: k, label: Text(label), selected: selected, onSelected: (_) => onTap());
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: Sp.gutter),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        TextField(
          key: const Key('search'),
          onChanged: onQuery,
          decoration: InputDecoration(prefixIcon: const Icon(Icons.search), hintText: l.caseSearchHint),
        ),
        const SizedBox(height: Sp.s),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(children: [
            chip(const Key('fAll'), l.filterAll, filter.isEmpty, () => onFilter(const ChecklistFilter())),
            const SizedBox(width: Sp.s),
            chip(const Key('fBlocking'), l.filterBlocking, filter.blocking == true, () => onFilter(filter.copyWith(blocking: filter.blocking == true ? null : true))),
            const SizedBox(width: Sp.s),
            chip(const Key('fTranslation'), l.filterTranslation, filter.translation == true, () => onFilter(filter.copyWith(translation: filter.translation == true ? null : true))),
            const SizedBox(width: Sp.s),
            chip(const Key('fApostille'), l.filterApostille, filter.apostille == true, () => onFilter(filter.copyWith(apostille: filter.apostille == true ? null : true))),
            for (final s in const [ItemStatus.notStarted, ItemStatus.inProgress, ItemStatus.ready, ItemStatus.issueFound, ItemStatus.notApplicable]) ...[
              const SizedBox(width: Sp.s),
              chip(Key('fStatus_${s.name}'), statusStyle(context, s).label, filter.status == s, () => onFilter(filter.copyWith(status: filter.status == s ? null : s))),
            ],
          ]),
        ),
        const SizedBox(height: Sp.s),
      ]),
    );
  }
}
