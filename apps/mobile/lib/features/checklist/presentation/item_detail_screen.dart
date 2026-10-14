import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/components.dart';
import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/network/api_error.dart';
import '../../../core/providers.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import '../data/dto/checklist_dto.dart';
import 'checklist_controller.dart';
import 'paywall_sheet.dart';

/// Screen 11 — Checklist Item Detail: the single merged screen. "Verified N days ago" is prominent at the top,
/// never in a footer (PRD §13); the footer always carries "Verify with official source" (PRD §18).
class ItemDetailScreen extends ConsumerWidget {
  const ItemDetailScreen({required this.itemId, super.key});
  final String itemId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final detail = ref.watch(checklistItemProvider(itemId));

    return Scaffold(
      appBar: GlassAppBar(title: detail.value?.title ?? ''),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => e.isPremiumRequired
            ? _Locked(onTap: () => showPaywallPreview(context))
            : Center(
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(errorText(l, e), textAlign: TextAlign.center),
                  const SizedBox(height: Sp.m),
                  FilledButton(onPressed: () => ref.invalidate(checklistItemProvider(itemId)), child: Text(l.commonRetry)),
                ]),
              ),
        data: (item) => _Body(item: item),
      ),
    );
  }
}

class _Locked extends StatelessWidget {
  const _Locked({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return EmptyState(
      key: const Key('itemLocked'),
      icon: Icons.lock_outline,
      message: l.premiumRequired,
      action: FilledButton(onPressed: onTap, child: Text(l.paywallTitle)),
    );
  }
}

class _Body extends ConsumerWidget {
  const _Body({required this.item});
  final ChecklistItemDetail item;

  Future<void> _openUrl(BuildContext context, WidgetRef ref, String url) async {
    final l = AppLocalizations.of(context);
    final ok = await ref.read(urlOpenerProvider)(Uri.parse(url));
    if (!ok && context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.itemSourceFailed)));
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final actions = ref.watch(itemActionsProvider);
    final na = item.status == ItemStatus.notApplicable;
    final writable = item.canWrite && !na;
    final now = ref.watch(clockProvider)();

    ref.listen(itemActionsProvider, (prev, next) {
      if (prev?.isLoading == true && next.hasError) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(_actionError(l, next.error!))));
      }
    });

    Widget section(String title, String? text) => text == null || text.isEmpty
        ? const SizedBox.shrink()
        : Padding(
            padding: const EdgeInsets.only(bottom: Sp.l),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: VipType.label.copyWith(color: p.textSecondary)),
              const SizedBox(height: Sp.xs),
              Text(text, style: VipType.body),
            ]),
          );

    return ListView(
      padding: const EdgeInsets.all(Sp.gutter),
      children: [
        VerifiedStamp(lastVerifiedAt: parseInstant(item.lastVerifiedAt), staleAfterDays: item.staleAfterDays, now: now),
        const SizedBox(height: Sp.m),
        Row(children: [
          Expanded(child: Text(item.title, style: VipType.title)),
          StatusChip(item.status),
        ]),
        if (item.badges.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: Sp.s),
            child: Wrap(spacing: Sp.s, runSpacing: Sp.xs, children: [for (final b in item.badges) BadgePill(b)]),
          ),
        if (item.badges.contains(ItemBadge.needsReview))
          Padding(
            padding: const EdgeInsets.only(top: Sp.m),
            child: GlassSurface(
              strong: true,
              padding: const EdgeInsets.all(Sp.l),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(l.itemAckHint, key: const Key('ackHint')),
                const SizedBox(height: Sp.s),
                OutlinedButton(
                  key: const Key('ackButton'),
                  onPressed: actions.isLoading || !item.canWrite ? null : () => ref.read(itemActionsProvider.notifier).acknowledgeReview(item.id),
                  child: Text(l.itemAckButton),
                ),
              ]),
            ),
          ),
        const SizedBox(height: Sp.l),
        if (na) ...[
          GlassSurface(
            strong: true,
            padding: const EdgeInsets.all(Sp.l),
            child: Text(item.notApplicableReason ?? '', key: const Key('naReasonDetail')),
          ),
          const SizedBox(height: Sp.l),
        ] else ...[
          Text(l.itemStatus, style: VipType.label.copyWith(color: p.textSecondary)),
          const SizedBox(height: Sp.s),
          Wrap(spacing: Sp.s, runSpacing: Sp.s, children: [
            for (final s in writableStatuses)
              ChoiceChip(
                key: Key('status_${s.name}'),
                label: Text(statusStyle(context, s).label),
                avatar: Icon(statusStyle(context, s).icon, size: 18, color: statusStyle(context, s).color),
                selected: item.status == s,
                // The current status stays an enabled (selected) chip — a disabled look would read as "unavailable".
                onSelected: (!writable || actions.isLoading)
                    ? null
                    : (_) {
                        if (item.status == s) return;
                        Haptics.light();
                        ref.read(itemActionsProvider.notifier).setStatus(item, s);
                      },
              ),
          ]),
          if (!item.canWrite)
            Padding(padding: const EdgeInsets.only(top: Sp.s), child: Text(l.itemReadOnly, key: const Key('itemReadOnly'), style: VipType.caption.copyWith(color: p.textSecondary))),
          const SizedBox(height: Sp.l),
        ],
        GlassSurface(
          strong: true,
          padding: const EdgeInsets.all(Sp.l),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            section(l.itemWhy, item.purpose),
            section(l.itemWho, item.whoProvides),
            section(l.itemWhere, item.whereToObtain),
            section(l.itemTiming, item.recommendedTiming),
            section(l.itemCondition, item.conditionNote),
            if (item.translationRequired || item.apostilleRequired)
              Wrap(spacing: Sp.m, children: [
                if (item.translationRequired) Chip(avatar: const Icon(Icons.translate, size: 16), label: Text(l.itemTranslation)),
                if (item.apostilleRequired) Chip(avatar: const Icon(Icons.approval, size: 16), label: Text(l.itemApostille)),
              ]),
          ]),
        ),
        const SizedBox(height: Sp.l),
        if (!na) _Documents(item: item, writable: writable),
        const SizedBox(height: Sp.l),
        GlassSurface(
          strong: true,
          padding: const EdgeInsets.all(Sp.l),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(l.itemSource, style: VipType.label.copyWith(color: p.textSecondary)),
            if (item.source != null) ...[
              const SizedBox(height: Sp.xs),
              Text('${item.source!.name}${item.source!.document == null ? '' : ' · ${item.source!.document}'}', style: VipType.body),
            ],
            const SizedBox(height: Sp.s),
            // PRD §18: the footer always offers the official source.
            FilledButton.tonalIcon(
              key: const Key('verifyOfficial'),
              onPressed: item.source == null ? null : () => _openUrl(context, ref, item.source!.url),
              icon: const Icon(Icons.open_in_new, size: 18),
              label: Text(l.itemVerifyFooter),
            ),
          ]),
        ),
        const SizedBox(height: Sp.x3),
      ],
    );
  }

  String _actionError(AppLocalizations l, Object e) {
    if (e is ApiError) {
      if (e.code == ApiCodes.uploadTooLarge || e.code == ApiCodes.uploadQuotaExceeded) return e.message; // the server states the limit
      if (e.code == ApiCodes.uploadRejected) return l.itemUploadFailed;
      if (e.code == ApiCodes.checklistConflict) return l.itemAckHint;
    }
    return errorText(l, e);
  }
}

class _Documents extends ConsumerWidget {
  const _Documents({required this.item, required this.writable});
  final ChecklistItemDetail item;
  final bool writable;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final busy = ref.watch(itemActionsProvider).isLoading;
    final locale = Localizations.localeOf(context).toLanguageTag();
    return GlassSurface(
      strong: true,
      padding: const EdgeInsets.all(Sp.l),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(l.itemDocuments, style: VipType.headline),
        const SizedBox(height: Sp.s),
        if (item.documents.isEmpty)
          Text(l.itemNoDocuments, key: const Key('noDocs'), style: VipType.body.copyWith(color: p.textSecondary)),
        for (final d in item.documents)
          ListTile(
            key: Key('doc_${d.id}'),
            contentPadding: EdgeInsets.zero,
            leading: Icon(d.mime == 'application/pdf' ? Icons.picture_as_pdf_outlined : Icons.image_outlined),
            title: Text(formatInstant(d.createdAt, locale)),
            subtitle: Text(formatBytes(d.sizeBytes)),
            trailing: writable
                ? IconButton(
                    tooltip: l.itemDeleteDocument,
                    icon: const Icon(Icons.delete_outline),
                    onPressed: busy
                        ? null
                        : () async {
                            final ok = await showDialog<bool>(
                              context: context,
                              builder: (c) => AlertDialog(
                                content: Text(l.itemDeleteConfirm),
                                actions: [
                                  TextButton(onPressed: () => Navigator.pop(c, false), child: Text(l.commonCancel)),
                                  TextButton(key: const Key('confirmDelete'), onPressed: () => Navigator.pop(c, true), child: Text(l.itemDeleteDocument)),
                                ],
                              ),
                            );
                            if (ok == true) await ref.read(itemActionsProvider.notifier).deleteDocument(d, item.id);
                          },
                  )
                : null,
            onTap: () => openDocument(context, ref, d.id),
          ),
        if (writable)
          Padding(
            padding: const EdgeInsets.only(top: Sp.s),
            child: FilledButton.tonalIcon(
              key: const Key('addDocument'),
              onPressed: busy ? null : () => ref.read(itemActionsProvider.notifier).addDocument(item, item.applicantId),
              icon: busy ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.add),
              label: Text(busy ? l.itemUploading : l.itemAddDocument),
            ),
          ),
      ]),
    );
  }
}

/// Shows a document: images inline (bytes fetched through the signed URL), PDFs handed to the system viewer.
Future<void> openDocument(BuildContext context, WidgetRef ref, String documentId) async {
  final repo = ref.read(documentsRepositoryProvider);
  final doc = await repo.detail(documentId);
  final url = doc.viewUrl;
  if (url == null || !context.mounted) return;
  if (doc.mime == 'application/pdf') {
    await ref.read(urlOpenerProvider)(Uri.parse(url));
    return;
  }
  final bytes = await repo.download(url);
  if (!context.mounted) return;
  await showDialog<void>(
    context: context,
    builder: (c) => Dialog(child: InteractiveViewer(child: Image.memory(bytes, key: const Key('docImage')))),
  );
}
