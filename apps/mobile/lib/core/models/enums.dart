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
