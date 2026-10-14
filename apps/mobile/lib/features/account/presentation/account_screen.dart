import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/design/glass_surface.dart';
import '../../../core/design/perf_tier.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/providers.dart';
import '../../../core/session/session_state.dart';
import '../../../core/ui/app_bar.dart';
import '../../../core/ui/error_text.dart';
import '../../../core/ui/format.dart';
import 'account_controller.dart';

/// Screen 29 — Account / Settings. Language (English only until the Urdu content-complete flag exists),
/// notification preferences, privacy consents, active devices, legal versions, data export, deletion, sign out.
class AccountScreen extends ConsumerWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final tier = ref.watch(perfTierProvider);
    final version = ref.watch(appInfoProvider).appVersion;

    ref.listen(accountActionsProvider, (prev, next) {
      if (prev?.isLoading == true && next.hasError) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(errorText(l, next.error!))));
      }
    });

    Widget heading(String t) => Padding(padding: const EdgeInsets.fromLTRB(0, Sp.l, 0, Sp.s), child: Text(t, style: VipType.headline));

    return Scaffold(
      appBar: GlassAppBar(title: l.accountTitle),
      body: ListView(padding: const EdgeInsets.all(Sp.gutter), children: [
        ListTile(
          key: const Key('language'),
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.language),
          title: Text(l.accountLanguage),
          subtitle: Text(l.accountLanguageValue),
        ),
        SwitchListTile(
          key: const Key('reduceEffects'),
          contentPadding: EdgeInsets.zero,
          title: Text(l.accountVisualEffects),
          subtitle: Text(l.accountVisualEffectsNote),
          value: tier == PerfTier.solid,
          onChanged: (v) => ref.read(perfTierProvider.notifier).setUserReduced(v),
        ),
        heading(l.accountNotifications),
        const _PushSection(),
        heading(l.accountPrivacy),
        const _ConsentSection(),
        heading(l.accountDevices),
        const _DevicesSection(),
        heading(l.accountLegal),
        const _LegalSection(),
        const SizedBox(height: Sp.l),
        const _ExportSection(),
        const SizedBox(height: Sp.l),
        OutlinedButton.icon(
          key: const Key('signOutAccount'),
          onPressed: () => ref.read(sessionControllerProvider.notifier).signOut(),
          icon: const Icon(Icons.logout),
          label: Text(l.accountSignOut),
        ),
        const SizedBox(height: Sp.s),
        TextButton.icon(
          key: const Key('deleteAccount'),
          style: TextButton.styleFrom(foregroundColor: p.statusIssueFound),
          onPressed: () => _confirmDelete(context, ref),
          icon: const Icon(Icons.delete_forever_outlined),
          label: Text(l.accountDelete),
        ),
        const SizedBox(height: Sp.l),
        Center(child: Text(l.accountVersion(version), style: VipType.caption.copyWith(color: p.textSecondary))),
      ]),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final l = AppLocalizations.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text(l.accountDeleteTitle),
        content: Text(l.accountDeleteBody),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: Text(l.commonCancel)),
          TextButton(key: const Key('confirmDeleteAccount'), onPressed: () => Navigator.pop(c, true), child: Text(l.accountDeleteConfirm)),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    final actions = ref.read(accountActionsProvider.notifier);
    var outcome = await actions.deleteAccount();
    // A destructive action needs a fresh sign-in: ask for the password, re-authenticate, repeat.
    while (outcome == DeleteOutcome.needsReauth || outcome == DeleteOutcome.wrongPassword) {
      if (!context.mounted) return;
      final pw = await _askPassword(context, wrong: outcome == DeleteOutcome.wrongPassword);
      if (pw == null) return;
      outcome = await actions.deleteAccount(password: pw);
    }
    if (outcome == DeleteOutcome.done && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.accountDeleting)));
    }
  }

  Future<String?> _askPassword(BuildContext context, {required bool wrong}) {
    final l = AppLocalizations.of(context);
    final c = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(l.accountReauthTitle),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(l.accountReauthBody),
          if (wrong) Padding(padding: const EdgeInsets.only(top: Sp.s), child: Text(l.accountReauthWrong, key: const Key('reauthWrong'))),
          TextField(key: const Key('reauthPassword'), controller: c, obscureText: true, decoration: InputDecoration(labelText: l.loginPassword)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: Text(l.commonCancel)),
          TextButton(key: const Key('reauthSubmit'), onPressed: () => Navigator.pop(ctx, c.text), child: Text(l.commonContinue)),
        ],
      ),
    );
  }
}

class _PushSection extends ConsumerWidget {
  const _PushSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final prefs = ref.watch(pushPrefsProvider);
    final busy = ref.watch(accountActionsProvider).isLoading;
    final actions = ref.read(accountActionsProvider.notifier);
    return prefs.when(
      loading: () => const LinearProgressIndicator(),
      error: (e, _) => TextButton(onPressed: () => ref.invalidate(pushPrefsProvider), child: Text(l.commonRetry)),
      data: (v) => Column(children: [
        SwitchListTile(key: const Key('pushReminder'), contentPadding: EdgeInsets.zero, title: Text(l.tabReminders), value: v.push.reminder, onChanged: busy ? null : (x) => actions.setPush(reminder: x)),
        SwitchListTile(key: const Key('pushUpdate'), contentPadding: EdgeInsets.zero, title: Text(l.tabUpdates), value: v.push.update, onChanged: busy ? null : (x) => actions.setPush(update: x)),
        SwitchListTile(key: const Key('pushActivity'), contentPadding: EdgeInsets.zero, title: Text(l.tabActivity), value: v.push.activity, onChanged: busy ? null : (x) => actions.setPush(activity: x)),
      ]),
    );
  }
}

class _ConsentSection extends ConsumerWidget {
  const _ConsentSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final consents = ref.watch(consentsProvider);
    final busy = ref.watch(accountActionsProvider).isLoading;
    final actions = ref.read(accountActionsProvider.notifier);
    return consents.when(
      loading: () => const LinearProgressIndicator(),
      error: (e, _) => TextButton(onPressed: () => ref.invalidate(consentsProvider), child: Text(l.commonRetry)),
      data: (c) => Column(children: [
        SwitchListTile(key: const Key('consentAnalytics'), contentPadding: EdgeInsets.zero, title: Text(l.consentAnalytics), value: c.analytics, onChanged: busy ? null : (x) => actions.setConsent(analytics: x)),
        SwitchListTile(key: const Key('consentCrash'), contentPadding: EdgeInsets.zero, title: Text(l.consentCrash), value: c.crashReports, onChanged: busy ? null : (x) => actions.setConsent(crashReports: x)),
        SwitchListTile(key: const Key('consentMarketing'), contentPadding: EdgeInsets.zero, title: Text(l.consentMarketing), value: c.marketingPush, onChanged: busy ? null : (x) => actions.setConsent(marketingPush: x)),
      ]),
    );
  }
}

class _DevicesSection extends ConsumerWidget {
  const _DevicesSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    final locale = Localizations.localeOf(context).toLanguageTag();
    final devices = ref.watch(devicesProvider);
    final session = ref.watch(sessionControllerProvider);
    final max = session is SessionReady ? session.me.devices.maxActive : null;
    return devices.when(
      loading: () => const LinearProgressIndicator(),
      error: (e, _) => TextButton(onPressed: () => ref.invalidate(devicesProvider), child: Text(l.commonRetry)),
      data: (list) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (max != null) Text(l.accountDevicesNote(max), style: VipType.caption.copyWith(color: p.textSecondary)),
        for (final d in list)
          ListTile(
            key: Key('device_${d.deviceId}'),
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.phone_android),
            title: Text(d.model ?? d.platform),
            subtitle: Text(formatInstant(d.lastSeenAt, locale)),
            trailing: d.isCurrent
                ? Chip(label: Text(l.accountThisDevice))
                : TextButton(key: Key('signOutDevice_${d.deviceId}'), onPressed: () => ref.read(accountActionsProvider.notifier).signOutDevice(d.deviceId), child: Text(l.accountSignOutDevice)),
          ),
      ]),
    );
  }
}

class _LegalSection extends ConsumerWidget {
  const _LegalSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final legal = ref.watch(currentLegalProvider);
    return legal.when(
      loading: () => const LinearProgressIndicator(),
      error: (e, _) => TextButton(onPressed: () => ref.invalidate(currentLegalProvider), child: Text(l.commonRetry)),
      data: (res) => Column(children: [
        for (final d in res.documents)
          ListTile(
            key: Key('legal_${d.docType.name}'),
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.description_outlined),
            title: Text(d.title),
            subtitle: Text('v${d.version}${d.accepted ? ' · ${l.accountLegalAccepted}' : ''}'),
            onTap: () async {
              final doc = await ref.read(legalRepositoryProvider).document(d.docType.name);
              if (!context.mounted) return;
              await showDialog<void>(
                context: context,
                builder: (c) => Dialog(
                  child: GlassSurface(
                    strong: true,
                    padding: const EdgeInsets.all(Sp.l),
                    child: SingleChildScrollView(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(doc.title, style: VipType.title),
                      const SizedBox(height: Sp.m),
                      Text(doc.bodyMd),
                    ])),
                  ),
                ),
              );
            },
          ),
      ]),
    );
  }
}

class _ExportSection extends ConsumerWidget {
  const _ExportSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context);
    final busy = ref.watch(accountActionsProvider).isLoading;
    final actions = ref.read(accountActionsProvider.notifier);
    ref.watch(accountActionsProvider); // rebuild when a request id appears
    final id = actions.exportRequestId;
    final status = id == null ? null : ref.watch(exportStatusProvider(id));

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      OutlinedButton.icon(
        key: const Key('requestExport'),
        onPressed: busy ? null : actions.requestExport,
        icon: const Icon(Icons.download_outlined),
        label: Text(l.accountExport),
      ),
      if (status != null)
        status.when(
          loading: () => const Padding(padding: EdgeInsets.all(Sp.s), child: LinearProgressIndicator()),
          error: (e, _) => Text(errorText(l, e)),
          data: (s) => Padding(
            padding: const EdgeInsets.only(top: Sp.s),
            child: switch (s.status) {
              DataRequestStatus.completed when s.downloadUrl != null => FilledButton.tonal(
                  key: const Key('exportDownload'),
                  onPressed: () => ref.read(urlOpenerProvider)(Uri.parse(s.downloadUrl!)),
                  child: Text('${l.accountExportReady} ${l.accountExportDownload}'),
                ),
              DataRequestStatus.completed || DataRequestStatus.rejected || DataRequestStatus.failed =>
                Text(s.status == DataRequestStatus.completed ? l.accountExportExpired : l.accountExportFailed, key: const Key('exportNote')),
              _ => Row(children: [
                  Expanded(child: Text(l.accountExportRequested, key: const Key('exportPending'))),
                  IconButton(onPressed: () => ref.invalidate(exportStatusProvider(id!)), icon: const Icon(Icons.refresh)),
                ]),
            },
          ),
        ),
    ]);
  }
}

