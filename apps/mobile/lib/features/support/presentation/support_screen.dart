import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/components.dart';
import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/network/capability_upload.dart';
import '../../../core/providers.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import '../data/dto/support_dto.dart';
import 'support_controller.dart';

String topicLabel(AppLocalizations l, SupportTopic t) => switch (t) {
      SupportTopic.payment => l.topicPayment,
      SupportTopic.order => l.topicOrder,
      SupportTopic.courier => l.topicCourier,
      SupportTopic.refund => l.topicRefund,
      SupportTopic.account => l.topicAccount,
      SupportTopic.appProblem => l.topicAppProblem,
      SupportTopic.presales || SupportTopic.unknown => l.topicPresales,
    };

/// Screen 25 — the single async thread. The SLA promise is always shown WITH the working-hours statement
/// (PRD §14a rule 2). Free accounts see only the pre-sales topics the server allows; requirement questions are
/// answered by operators with canned CMS links, so the standard disclaimer sits under every conversation.
class SupportScreen extends ConsumerStatefulWidget {
  const SupportScreen({super.key});

  @override
  ConsumerState<SupportScreen> createState() => _SupportScreenState();
}

class _SupportScreenState extends ConsumerState<SupportScreen> {
  final _text = TextEditingController();
  SupportTopic? _topic;
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      // The list is reversed: its "end" is the oldest message.
      if (_scroll.position.pixels > _scroll.position.maxScrollExtent - 200) {
        ref.read(supportMessagesProvider.notifier).loadMore();
      }
    });
  }

  @override
  void dispose() {
    _text.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send(SupportThreadView thread) async {
    final l = AppLocalizations.of(context);
    final topic = _topic ?? (thread.allowedTopics.length == 1 ? thread.allowedTopics.first : null);
    if (topic == null) return;
    final actions = ref.read(supportActionsProvider.notifier);
    final ok = await actions.send(body: _text.text, topic: topic);
    if (ok) {
      _text.clear();
    } else if (mounted) {
      final err = ref.read(supportActionsProvider).error;
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err == null ? l.errorGeneric : errorText(l, err))));
    }
  }

  Future<void> _openImage(SupportMessage m) async {
    final repo = ref.read(supportRepositoryProvider);
    final url = await repo.attachmentViewUrl(m.attachment!.id);
    final bytes = await getFromCapabilityUrl(ref.read(dioProvider), url);
    if (!mounted) return;
    await showDialog<void>(context: context, builder: (c) => Dialog(child: InteractiveViewer(child: Image.memory(bytes))));
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final locale = Localizations.localeOf(context).toLanguageTag();
    ref.watch(supportMarkReadProvider); // opening the thread marks replies read
    final thread = ref.watch(supportThreadProvider);
    final msgs = ref.watch(supportMessagesProvider);
    final actions = ref.watch(supportActionsProvider);
    final attachment = ref.read(supportActionsProvider.notifier).attachment;

    return Scaffold(
      appBar: GlassAppBar(title: l.supportTitle),
      body: thread.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            Text(errorText(l, e)),
            TextButton(onPressed: () => ref.invalidate(supportThreadProvider), child: Text(l.commonRetry)),
          ]),
        ),
        data: (t) {
          final canChooseTopic = t.allowedTopics.length > 1;
          final selected = _topic ?? (t.allowedTopics.length == 1 ? t.allowedTopics.first : null);
          final awaiting = t.status == SupportStatus.awaitingSupport && t.slaDueAt != null;
          return Column(children: [
            if (awaiting)
              // The deadline is only ever shown beside the working-hours statement.
              Padding(
                padding: const EdgeInsets.fromLTRB(Sp.gutter, Sp.s, Sp.gutter, 0),
                child: GlassSurface(
                  strong: true,
                  padding: const EdgeInsets.all(Sp.m),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(l.supportSlaBy(formatInstant(t.slaDueAt, locale)), key: const Key('slaDeadline'), style: VipType.label),
                    if (t.workingHoursText != null)
                      Text(l.supportHours(t.workingHoursText!), key: const Key('workingHours'), style: VipType.caption.copyWith(color: p.textSecondary)),
                  ]),
                ),
              ),
            if (t.status == SupportStatus.closed)
              Padding(padding: const EdgeInsets.all(Sp.m), child: Text(l.supportClosed, key: const Key('closedNote'))),
            Expanded(
              child: msgs.loadingFirst
                  ? const Center(child: CircularProgressIndicator())
                  : msgs.items.isEmpty
                      ? EmptyState(key: const Key('supportEmpty'), icon: Icons.chat_bubble_outline, message: l.supportPickTopic)
                      : ListView.builder(
                          controller: _scroll,
                          reverse: true,
                          padding: const EdgeInsets.all(Sp.gutter),
                          itemCount: msgs.items.length + (msgs.hasMore ? 1 : 0),
                          itemBuilder: (_, i) {
                            if (i == msgs.items.length) {
                              return TextButton(onPressed: () => ref.read(supportMessagesProvider.notifier).loadMore(), child: Text(l.supportLoadOlder));
                            }
                            final m = msgs.items[i];
                            final mine = m.senderType == SenderType.user;
                            return Align(
                              alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
                              child: Container(
                                key: Key('msg_${m.id}'),
                                margin: const EdgeInsets.only(bottom: Sp.s),
                                padding: const EdgeInsets.all(Sp.m),
                                constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
                                decoration: BoxDecoration(
                                  color: mine ? p.lagoon.withValues(alpha: 0.16) : p.surfaceSolid,
                                  borderRadius: BorderRadius.circular(Rad.md),
                                  border: Border.all(color: p.strokeHairline),
                                ),
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(mine ? l.supportYou : l.supportTeam, style: VipType.caption.copyWith(color: p.textSecondary)),
                                  if (m.body.isNotEmpty) Text(m.body, style: VipType.body),
                                  if (m.attachment != null)
                                    TextButton.icon(
                                      key: Key('att_${m.id}'),
                                      onPressed: () => _openImage(m),
                                      icon: const Icon(Icons.image_outlined, size: 18),
                                      label: Text(l.supportOpenImage),
                                    ),
                                  Text(formatInstant(m.createdAt, locale), style: VipType.caption.copyWith(color: p.textSecondary)),
                                ]),
                              ),
                            );
                          },
                        ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: Sp.gutter),
              child: Text(l.supportDisclaimer, key: const Key('supportDisclaimer'), style: VipType.caption.copyWith(color: p.textSecondary)),
            ),
            GlassSurface(
              radius: 0,
              strong: true,
              padding: const EdgeInsets.all(Sp.m),
              child: SafeArea(
                top: false,
                child: Column(children: [
                  if (canChooseTopic)
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(children: [
                        for (final topic in t.allowedTopics) ...[
                          ChoiceChip(
                            key: Key('topic_${topic.name}'),
                            label: Text(topicLabel(l, topic)),
                            selected: selected == topic,
                            onSelected: (_) => setState(() => _topic = topic),
                          ),
                          const SizedBox(width: Sp.s),
                        ],
                      ]),
                    ),
                  if (t.tier == SupportTier.free)
                    Align(alignment: Alignment.centerLeft, child: Text(l.supportTopicLocked, key: const Key('topicLocked'), style: VipType.caption.copyWith(color: p.textSecondary))),
                  if (attachment != null)
                    Row(children: [
                      const Icon(Icons.image_outlined, size: 18),
                      const SizedBox(width: Sp.xs),
                      Expanded(child: Text(l.supportAttached, key: const Key('attached'))),
                      TextButton(onPressed: () => ref.read(supportActionsProvider.notifier).clearAttachment(), child: Text(l.supportRemoveAttachment)),
                    ]),
                  Row(children: [
                    IconButton(
                      key: const Key('attach'),
                      tooltip: l.supportAttach,
                      onPressed: actions.isLoading ? null : () => ref.read(supportActionsProvider.notifier).pickImage(),
                      icon: const Icon(Icons.attach_file),
                    ),
                    Expanded(
                      child: TextField(
                        key: const Key('composer'),
                        controller: _text,
                        minLines: 1,
                        maxLines: 4,
                        maxLength: 4000,
                        buildCounter: (_, {required currentLength, required isFocused, maxLength}) => null,
                        onChanged: (_) => setState(() {}),
                        decoration: InputDecoration(hintText: l.supportInputHint),
                      ),
                    ),
                    IconButton.filled(
                      key: const Key('send'),
                      tooltip: l.supportSend,
                      onPressed: (actions.isLoading || selected == null || (_text.text.trim().isEmpty && attachment == null)) ? null : () => _send(t),
                      icon: actions.isLoading ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.send),
                    ),
                  ]),
                ]),
              ),
            ),
          ]);
        },
      ),
    );
  }
}

