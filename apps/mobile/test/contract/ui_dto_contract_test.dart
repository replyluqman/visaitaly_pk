import 'package:flutter_test/flutter_test.dart';
import 'package:visaitaly_pk/core/models/enums.dart';
import 'package:visaitaly_pk/features/account/data/dto/account_dto.dart';
import 'package:visaitaly_pk/features/checklist/data/dto/checklist_dto.dart';
import 'package:visaitaly_pk/features/documents/data/dto/document_dto.dart';
import 'package:visaitaly_pk/features/notifications/data/dto/notification_dto.dart';
import 'package:visaitaly_pk/features/public/data/dto/public_dto.dart';
import 'package:visaitaly_pk/features/support/data/dto/support_dto.dart';

import '../helpers/fakes.dart';

/// REAL server output (apps/api/test/mobile-fixtures-ui.test.ts) decoded into the DTOs the screens use.
void main() {
  group('checklist', () {
    test('premium list: items, statuses, badges, flags, no locked rows', () {
      final r = ChecklistResponse.fromJson(fixture('checklist_premium'));
      expect(r.lockedCount, 0);
      expect(r.items, isNotEmpty);
      final nikah = r.items.firstWhere((i) => i.requirementCode == 'nikah');
      expect(nikah.stage, JourneyStage.documents);
      expect(nikah.status, ItemStatus.notStarted);
      expect(nikah.badges, [ItemBadge.blocking]);
      expect(nikah.translationRequired && nikah.apostilleRequired, isTrue);
      expect(r.items.any((i) => i.status == ItemStatus.notApplicable && i.notApplicableReason != null), isTrue);
      expect(r.syncedAt, isNotEmpty);
    });

    test('free list: the paywall count is carried, not computed', () {
      final r = ChecklistResponse.fromJson(fixture('checklist_free'));
      expect(r.lockedCount, greaterThan(0));
      expect(r.items.length, lessThanOrEqualTo(3));
    });

    test('detail: purpose, who/where/timing, source, staleAfterDays, canWrite', () {
      final d = ChecklistItemDetail.fromJson(fixture('checklist_item_detail'));
      expect(d.purpose, 'Proof of marriage');
      expect(d.whoProvides, 'Applicant');
      expect(d.source!.url, 'https://example.test/src');
      expect(d.staleAfterDays, 30);
      expect(d.canWrite, isTrue);
    });

    test('a not-applicable item carries the reason and is read-only', () {
      final d = ChecklistItemDetail.fromJson(fixture('checklist_item_not_applicable'));
      expect(d.status, ItemStatus.notApplicable);
      expect(d.notApplicableReason, isNotEmpty);
      expect(d.canWrite, isFalse);
    });

    test('patched item and the journey', () {
      expect(ChecklistItem.fromJson(fixture('checklist_item_patched')).status, ItemStatus.inProgress);
      final j = JourneyResponse.fromJson(fixture('journey'));
      expect(j.currentStage, JourneyStage.documents);
      expect(j.stages, hasLength(8));
      expect(j.stages.map((s) => s.state), containsAll([StageState.done, StageState.current, StageState.upcoming]));
    });

    test('unknown status / badge / stage values never throw', () {
      final json = fixture('checklist_premium');
      final it = (json['items'] as List).first as Map<String, dynamic>;
      it['status'] = 'on_hold';
      it['badges'] = ['blocking', 'sparkly'];
      it['stage'] = 'visa_granted';
      final d = ChecklistResponse.fromJson(json).items.first;
      expect([d.status, d.stage], [ItemStatus.unknown, JourneyStage.unknown]);
      expect(d.badges, [ItemBadge.blocking, ItemBadge.unknown]);
    });
  });

  group('documents and Today', () {
    test('upload reservation, completed document, list with quota, detail with viewUrl', () {
      final r = UploadReservation.fromJson(fixture('document_upload_url'));
      expect(r.requiredHeaders, {'Content-Type': 'image/png'});
      expect(DocumentDto.fromJson(fixture('document_complete')).viewUrl, isNull);
      final list = DocumentList.fromJson(fixture('documents_list'));
      expect(list.items.single.checklistItemId, isNotNull);
      expect(list.quota.maxBytes, greaterThan(list.quota.usedBytes));
      expect(DocumentDto.fromJson(fixture('document_detail')).viewUrl, contains('/content?exp='));
    });

    test('Today: structured actions (no server prose) and the all-clear shape', () {
      final t = TodayResponse.fromJson(fixture('today_actions'));
      expect(t.allClear, isNull);
      expect(t.actions.first.kind, TodayKind.blocking);
      expect(t.actions.first.reason, TodayReason.blocksSubmission);
      expect(t.actions.first.deepLink, startsWith('/checklist/'));
      final clear = TodayResponse.fromJson(fixture('today_all_clear'));
      expect(clear.actions, isEmpty);
      expect(clear.allClear!.nextStage, JourneyStage.translation);
    });

    test('computedAt = null means "not computed yet", distinct from all-clear', () {
      final t = TodayResponse.fromJson({'actions': [], 'allClear': null, 'computedAt': null});
      expect(t.computedAt, isNull);
      expect(t.allClear, isNull);
    });
  });

  group('notifications', () {
    test('inbox rows carry a mandatory deep link; unread count by tab; preferences', () {
      final list = NotificationList.fromJson(fixture('notifications_update'));
      final n = list.items.single;
      expect(n.tab, NotificationTab.update);
      expect(n.deepLink, startsWith('/'));
      expect(n.readAt, isNull);
      expect(NotificationList.fromJson(fixture('notifications_empty_reminder')).items, isEmpty);
      final c = UnreadCount.fromJson(fixture('notifications_unread_count'));
      expect(c.total, c.byTab.reminder + c.byTab.update + c.byTab.activity);
      expect(NotificationPreferences.fromJson(fixture('notification_preferences')).push.update, isTrue);
    });
  });

  group('support', () {
    test('no thread yet / awaiting user with an unread reply', () {
      final none = SupportThreadView.fromJson(fixture('support_thread_none'));
      expect(none.status, SupportStatus.none);
      expect(none.allowedTopics, containsAll([SupportTopic.presales, SupportTopic.appProblem, SupportTopic.account]));
      expect(none.allowedTopics, isNot(contains(SupportTopic.payment)));
      final r = SupportThreadView.fromJson(fixture('support_thread_replied'));
      expect([r.status, r.unreadCount, r.slaDueAt], [SupportStatus.awaitingUser, 1, null]);
    });
    test('messages newest-first with sender types; sent message; attachment reservation', () {
      final m = SupportMessageList.fromJson(fixture('support_messages'));
      expect(m.items.map((e) => e.senderType), [SenderType.admin, SenderType.user]);
      expect(m.items.last.topic, SupportTopic.presales);
      expect(SupportMessage.fromJson(fixture('support_message_sent')).senderType, SenderType.user);
      expect(UploadReservation.fromJson(fixture('support_attachment_upload')).id, isNotEmpty);
    });
  });

  group('account and public', () {
    test('consents (unanswered then saved), devices, export request', () {
      expect(Consents.fromJson(fixture('consents_unanswered')).answered, isFalse);
      final saved = Consents.fromJson(fixture('consents_saved'));
      expect([saved.analytics, saved.crashReports, saved.marketingPush, saved.answered], [true, true, false, true]);
      final dev = DeviceSummary.fromJson((fixture('devices')['devices'] as List).first as Map<String, dynamic>);
      expect(dev.isCurrent, isTrue);
      expect(DataRequestAccepted.fromJson(fixture('data_export_requested')).status, DataRequestStatus.received);
    });
    test('How We Verify summary and Quick Check question set / result', () {
      final v = VerificationSummary.fromJson(fixture('verification_summary'));
      expect(v.requirementsTracked, greaterThan(0));
      expect(v.sourceLinkedPercent, 100);
      expect(v.lastSweepAt, isNull);
      final q = EligibilityQuestionSet.fromJson(fixture('eligibility_questions'));
      expect(q.version, 1);
      expect(q.questions.first.options.first.value, 'spouse');
      final r = EligibilityResult.fromJson(fixture('eligibility_result'));
      expect(r.typicalItems, isNotEmpty);
      expect(r.whatsappUrl, startsWith('https://wa.me/'));
    });
  });
}
