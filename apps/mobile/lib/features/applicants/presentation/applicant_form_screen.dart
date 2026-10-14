import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/providers.dart';
import '../../../core/session/session_state.dart';
import '../../../core/ui/error_text.dart';
import '../data/applicants_repository.dart';
import '../data/dto/applicant_dto.dart';
import 'applicants_controller.dart';

/// Screen 6 — Applicant Profile Setup. Repeats per applicant during onboarding; also used from the dashboard.
/// `relationshipCategory` is never sent — the server derives it.
class ApplicantFormScreen extends ConsumerStatefulWidget {
  const ApplicantFormScreen({required this.onboarding, super.key});
  final bool onboarding;

  @override
  ConsumerState<ApplicantFormScreen> createState() => _ApplicantFormScreenState();
}

class _ApplicantFormScreenState extends ConsumerState<ApplicantFormScreen> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  String? _relationship;
  String? _dob; // YYYY-MM-DD, never a DateTime
  ApplicantLocation _location = ApplicantLocation.pakistan;
  NullaOstaStatus _nulla = NullaOstaStatus.notStarted;
  bool _submitted = false;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  static String _ymd(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

  Future<void> _pickDob() async {
    final now = DateTime.now();
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime(now.year - 30),
      firstDate: DateTime(1900),
      lastDate: now,
    );
    if (picked != null) setState(() => _dob = _ymd(picked));
  }

  Future<void> _submit(List<RelationshipOption> rels) async {
    setState(() => _submitted = true);
    final rel = rels.where((r) => r.code == _relationship).firstOrNull;
    if (!_form.currentState!.validate() || rel == null) return;
    if (rel.requiresDob && _dob == null) return;
    await ref.read(addApplicantControllerProvider.notifier).submit(NewApplicant(
          displayName: _name.text,
          relationshipCode: rel.code,
          currentLocation: _location,
          dateOfBirth: _dob,
          nullaOstaStatus: _nulla,
          // Once onboarding is complete the server requires a stage up front; during onboarding Screen 7 sets it.
          currentStage: widget.onboarding ? null : JourneyStage.eligibility,
        ));
    if (!widget.onboarding && mounted && !ref.read(addApplicantControllerProvider).hasError) context.pop();
  }

  String _locationLabel(AppLocalizations l, ApplicantLocation v) => switch (v) {
        ApplicantLocation.pakistan => l.locationPakistan,
        ApplicantLocation.italy => l.locationItaly,
        _ => l.locationOther,
      };

  String _nullaLabel(AppLocalizations l, NullaOstaStatus v) => switch (v) {
        NullaOstaStatus.notStarted => l.nullaNotStarted,
        NullaOstaStatus.inProcess => l.nullaInProcess,
        NullaOstaStatus.received => l.nullaReceived,
        NullaOstaStatus.notApplicable => l.nullaNotApplicable,
        NullaOstaStatus.unknown => l.nullaUnknown,
      };

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final rels = ref.watch(relationshipsProvider);
    final save = ref.watch(addApplicantControllerProvider);
    final server = fieldErrors(save.error ?? '');
    final session = ref.watch(sessionControllerProvider);
    final progress = (widget.onboarding && session is SessionReady && session.me.applicants.declaredCount != null)
        ? l.applicantProgress(session.me.applicants.total + 1, session.me.applicants.declaredCount!)
        : null;

    return PopScope(
      canPop: !widget.onboarding,
      child: Scaffold(
        appBar: AppBar(title: Text(l.applicantTitle), automaticallyImplyLeading: !widget.onboarding),
        body: SafeArea(
          child: rels.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Text(errorText(l, e)),
                FilledButton(onPressed: () => ref.invalidate(relationshipsProvider), child: Text(l.commonRetry)),
              ]),
            ),
            data: (list) {
              final rel = list.where((r) => r.code == _relationship).firstOrNull;
              return Form(
                key: _form,
                child: ListView(
                  padding: const EdgeInsets.all(24),
                  children: [
                    if (progress != null) Padding(padding: const EdgeInsets.only(bottom: 12), child: Text(progress, key: const Key('progress'))),
                    TextFormField(
                      key: const Key('name'),
                      controller: _name,
                      maxLength: 80,
                      decoration: InputDecoration(labelText: l.applicantName, errorText: server['displayName']),
                      validator: (v) => (v == null || v.trim().isEmpty) ? l.applicantNameRequired : null,
                    ),
                    DropdownButtonFormField<String>(
                      key: const Key('relationship'),
                      initialValue: _relationship,
                      decoration: InputDecoration(labelText: l.applicantRelationship, errorText: server['relationshipCode']),
                      items: [for (final r in list) DropdownMenuItem(value: r.code, child: Text(r.label))],
                      onChanged: (v) => setState(() {
                        _relationship = v;
                        _dob = null;
                      }),
                      validator: (v) => v == null ? l.applicantRelationshipRequired : null,
                    ),
                    if (rel?.requiresDob ?? false) ...[
                      const SizedBox(height: 16),
                      OutlinedButton(
                        key: const Key('dob'),
                        onPressed: _pickDob,
                        child: Text(_dob ?? l.applicantDobPick),
                      ),
                      if ((_submitted && _dob == null) || server['dateOfBirth'] != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(server['dateOfBirth'] ?? l.applicantDobRequired,
                              key: const Key('dobError'), style: TextStyle(color: Theme.of(context).colorScheme.error)),
                        ),
                    ],
                    const SizedBox(height: 16),
                    Text(l.applicantLocation),
                    RadioGroup<ApplicantLocation>(
                      groupValue: _location,
                      onChanged: (x) => setState(() => _location = x ?? _location),
                      child: Column(children: [
                        for (final v in const [ApplicantLocation.pakistan, ApplicantLocation.italy, ApplicantLocation.other])
                          RadioListTile<ApplicantLocation>(key: Key('loc_${v.name}'), title: Text(_locationLabel(l, v)), value: v),
                      ]),
                    ),
                    DropdownButtonFormField<NullaOstaStatus>(
                      key: const Key('nulla'),
                      initialValue: _nulla,
                      decoration: InputDecoration(labelText: l.applicantNullaOsta),
                      items: [
                        for (final v in const [NullaOstaStatus.notStarted, NullaOstaStatus.inProcess, NullaOstaStatus.received])
                          DropdownMenuItem(value: v, child: Text(_nullaLabel(l, v))),
                      ],
                      onChanged: (v) => setState(() => _nulla = v ?? _nulla),
                    ),
                    if (save.hasError) Padding(padding: const EdgeInsets.only(top: 12), child: Text(errorText(l, save.error!), key: const Key('formError'))),
                    const SizedBox(height: 24),
                    FilledButton(
                      key: const Key('save'),
                      onPressed: save.isLoading ? null : () => _submit(list),
                      child: Text(widget.onboarding ? l.commonContinue : l.commonSave),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
