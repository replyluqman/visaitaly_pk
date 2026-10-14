import 'package:json_annotation/json_annotation.dart';

/// Every server enum has an `unknown` member and decodes to it for values this build does not know, so a new
/// server value never crashes an installed app (docs/FLUTTER-ARCHITECTURE.md, Models). Mirrors packages/shared.

@JsonEnum(fieldRename: FieldRename.snake)
enum OnboardingState {
  disclaimerPending,
  applicantsPending,
  stagePending,
  complete,
  unknown,
}

@JsonEnum(fieldRename: FieldRename.snake)
enum LegalDocType { disclaimer, terms, privacy, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum AccessLevel { free, premium, graceReadOnly, expired, unknown }

/// The eight canonical stages (PRD §12), in journey order.
@JsonEnum(fieldRename: FieldRename.snake)
enum JourneyStage {
  eligibility,
  nullaOsta,
  documents,
  translation,
  appointment,
  application,
  processing,
  decision,
  unknown,
}

@JsonEnum(fieldRename: FieldRename.snake)
enum NullaOstaStatus { notApplicable, notStarted, inProcess, received, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum ApplicantLocation { pakistan, italy, other, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum RelationshipCategory { spouse, child, parent, unknown }

/// Wire value for a request body (snake_case, same as the server). `unknown` is never sent.
String wire(Enum e) {
  final n = e.name;
  return n.replaceAllMapped(RegExp('[A-Z]'), (m) => '_${m[0]!.toLowerCase()}');
}

/// Checklist statuses (PRD §12). Only the first four are stored/writable; `notApplicable` is derived by the server.
@JsonEnum(fieldRename: FieldRename.snake)
enum ItemStatus { notStarted, inProgress, ready, issueFound, notApplicable, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum ItemBadge { blocking, needsReview, sourceUnderReview, unknown }

/// Statuses a client may write (everything except the derived ones).
const writableStatuses = [ItemStatus.notStarted, ItemStatus.inProgress, ItemStatus.ready, ItemStatus.issueFound];

@JsonEnum(fieldRename: FieldRename.snake)
enum TodayKind { expiring, blocking, todo, unknown }

/// Why a Today action is listed. The server holds no English: the client composes the sentence from this.
@JsonEnum(fieldRename: FieldRename.snake)
enum TodayReason { documentExpires, nullaOstaExpires, blocksSubmission, issueFound, inProgress, notStarted, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum NotificationTab { reminder, update, activity, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum SupportStatus { none, open, awaitingSupport, awaitingUser, closed, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum SupportTier { free, paid, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum SenderType { user, admin, system, unknown }

/// Support topics (PRD §10). Free accounts get the server-provided subset.
@JsonEnum(fieldRename: FieldRename.snake)
enum SupportTopic { payment, order, courier, refund, account, appProblem, presales, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum StageState { done, current, upcoming, unknown }

@JsonEnum(fieldRename: FieldRename.snake)
enum DataRequestStatus { received, processing, completed, rejected, failed, unknown }
