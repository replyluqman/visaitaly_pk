import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/components.dart';
import '../../../core/design/tokens.dart';
import '../../../core/file_picker_gateway.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/providers.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import '../../applicants/data/dto/applicant_dto.dart';
import '../../applicants/presentation/applicants_controller.dart';
import '../../checklist/presentation/item_detail_screen.dart' show openDocument;
import 'documents_controller.dart';

/// Screen 14 — every uploaded file across applicants, newest first; filter by applicant. Files live in R2 and are
/// opened through short-lived signed URLs.
class DocumentsScreen extends ConsumerStatefulWidget {
  const DocumentsScreen({super.key});

  @override
  ConsumerState<DocumentsScreen> createState() => _DocumentsScreenState();
}

class _DocumentsScreenState extends ConsumerState<DocumentsScreen> {
  String? _applicantId;
  bool _uploading = false;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 300) {
        ref.read(documentsProvider(_applicantId).notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _upload(List<Applicant> applicants) async {
    final l = AppLocalizations.of(context);
    if (applicants.isEmpty) return;
    var target = _applicantId ?? (applicants.length == 1 ? applicants.first.id : null);
    target ??= await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(title: Text(l.docsPickApplicant), children: [
        for (final a in applicants) SimpleDialogOption(key: Key('pick_${a.id}'), onPressed: () => Navigator.pop(c, a.id), child: Text(a.displayName)),
      ]),
    );
    if (target == null || !mounted) return;
    setState(() => _uploading = true);
    try {
      final picked = await ref.read(filePickerProvider).pick();
      if (picked == null) return;
      await ref.read(documentsRepositoryProvider).upload(applicantId: target, bytes: picked.bytes, mime: picked.mime);
      ref.invalidate(documentsProvider);
    } on Object catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e is FileTooLargeToRead ? l.itemPickFailed : errorText(l, e))));
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final locale = Localizations.localeOf(context).toLanguageTag();
    final docs = ref.watch(documentsProvider(_applicantId));
    final applicants = ref.watch(applicantsProvider).value?.applicants ?? const <Applicant>[];
    final names = {for (final a in applicants) a.id: a.displayName};
    final quota = docs.quota;

    return Scaffold(
      appBar: GlassAppBar(title: l.docsTitle),
      floatingActionButton: FloatingActionButton.extended(
        key: const Key('uploadDoc'),
        onPressed: _uploading ? null : () => _upload(applicants),
        icon: _uploading ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.upload_file),
        label: Text(_uploading ? l.itemUploading : l.docsUpload),
      ),
      body: Column(children: [
        if (applicants.length > 1)
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: Sp.gutter),
            child: Row(children: [
              ChoiceChip(key: const Key('docFilterAll'), label: Text(l.docsFilterEveryone), selected: _applicantId == null, onSelected: (_) => setState(() => _applicantId = null)),
              for (final a in applicants) ...[
                const SizedBox(width: Sp.s),
                ChoiceChip(key: Key('docFilter_${a.id}'), label: Text(a.displayName), selected: _applicantId == a.id, onSelected: (_) => setState(() => _applicantId = a.id)),
              ],
            ]),
          ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: () => ref.read(documentsProvider(_applicantId).notifier).refresh(),
            child: docs.loadingFirst
                ? const Center(child: CircularProgressIndicator())
                : docs.error != null && docs.items.isEmpty
                    ? ListView(children: [
                        const SizedBox(height: Sp.x4),
                        Center(child: Text(errorText(l, docs.error!))),
                        Center(child: TextButton(onPressed: () => ref.read(documentsProvider(_applicantId).notifier).refresh(), child: Text(l.commonRetry))),
                      ])
                    : docs.items.isEmpty
                        ? ListView(children: [EmptyState(key: const Key('docsEmpty'), icon: Icons.folder_open, message: l.docsEmpty)])
                        : ListView.separated(
                            controller: _scroll,
                            padding: const EdgeInsets.fromLTRB(Sp.gutter, Sp.s, Sp.gutter, 96),
                            itemCount: docs.items.length + 1,
                            separatorBuilder: (_, _) => const SizedBox(height: Sp.s),
                            itemBuilder: (_, i) {
                              if (i == docs.items.length) {
                                return quota == null
                                    ? const SizedBox.shrink()
                                    : Center(child: Text(l.docsQuota(formatBytes(quota.usedBytes), formatBytes(quota.maxBytes)), key: const Key('quota'), style: VipType.caption.copyWith(color: context.vip.textSecondary)));
                              }
                              final d = docs.items[i];
                              return TintCard(
                                key: Key('doc_${d.id}'),
                                onTap: () => openDocument(context, ref, d.id),
                                child: Row(children: [
                                  Icon(d.mime == 'application/pdf' ? Icons.picture_as_pdf_outlined : Icons.image_outlined),
                                  const SizedBox(width: Sp.m),
                                  Expanded(
                                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                      Text(names[d.applicantId] ?? '', style: VipType.headline),
                                      Text('${formatInstant(d.createdAt, locale)} · ${formatBytes(d.sizeBytes)}', style: VipType.caption.copyWith(color: context.vip.textSecondary)),
                                      if (d.expiryDate != null) Text(l.docsExpires(formatYmd(d.expiryDate, locale)), style: VipType.caption),
                                    ]),
                                  ),
                                  if (d.checklistItemId != null)
                                    IconButton(
                                      tooltip: l.docsLinked,
                                      icon: const Icon(Icons.link),
                                      onPressed: () => context.push(Routes.item(d.checklistItemId!)),
                                    ),
                                ]),
                              );
                            },
                          ),
          ),
        ),
      ]),
    );
  }
}
