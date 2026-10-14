import '../l10n/app_localizations.dart';
import '../models/enums.dart';

String journeyLabel(AppLocalizations l, JourneyStage? s) => switch (s) {
      JourneyStage.eligibility => l.journeyEligibility,
      JourneyStage.nullaOsta => l.journeyNullaOsta,
      JourneyStage.documents => l.journeyDocuments,
      JourneyStage.translation => l.journeyTranslation,
      JourneyStage.appointment => l.journeyAppointment,
      JourneyStage.application => l.journeyApplication,
      JourneyStage.processing => l.journeyProcessing,
      JourneyStage.decision => l.journeyDecision,
      _ => l.journeyUnknown,
    };
