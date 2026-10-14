import 'package:flutter/material.dart';

import '../../../core/design/components.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';
import '../../../core/models/enums.dart';
import '../../../core/ui/app_bar.dart';
import '../data/dto/checklist_dto.dart';

/// One checklist row (list card — tint, no blur). Not-applicable rows are greyed WITH the reason, never hidden.
class ChecklistRow extends StatelessWidget {
  const ChecklistRow({required this.item, required this.onTap, super.key});
  final ChecklistItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    final l = AppLocalizations.of(context);
    final na = item.status == ItemStatus.notApplicable;
    final style = statusStyle(context, item.status);
    return Opacity(
      opacity: na ? 0.65 : 1,
      child: TintCard(
        key: Key('item_${item.id}'),
        onTap: onTap,
        semanticLabel: '${item.title}, ${style.label}',
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(child: Text(item.title, style: VipType.headline)),
            const SizedBox(width: Sp.s),
            StatusChip(item.status),
          ]),
          if (na && item.notApplicableReason != null) ...[
            const SizedBox(height: Sp.xs),
            Text(item.notApplicableReason!, key: const Key('naReason'), style: VipType.caption.copyWith(color: p.textSecondary)),
          ],
          if (item.badges.isNotEmpty || item.translationRequired || item.apostilleRequired || item.documentCount > 0) ...[
            const SizedBox(height: Sp.s),
            Wrap(spacing: Sp.s, runSpacing: Sp.xs, crossAxisAlignment: WrapCrossAlignment.center, children: [
              for (final b in item.badges) BadgePill(b),
              if (item.translationRequired) _Flag(Icons.translate, l.filterTranslation),
              if (item.apostilleRequired) _Flag(Icons.approval, l.filterApostille),
              if (item.documentCount > 0) _Flag(Icons.attach_file, '${item.documentCount}'),
            ]),
          ],
        ]),
      ),
    );
  }
}

class _Flag extends StatelessWidget {
  const _Flag(this.icon, this.label);
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final p = context.vip;
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Icon(icon, size: 16, color: p.textSecondary),
      const SizedBox(width: Sp.xs),
      Text(label, style: VipType.caption.copyWith(color: p.textSecondary)),
    ]);
  }
}

/// Free tier: "+18 more documents". A static placeholder (no live blur) and one tap target to the paywall preview.
class LockedRows extends StatelessWidget {
  const LockedRows({required this.count, required this.onTap, super.key});
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    return TintCard(
      key: const Key('lockedRows'),
      onTap: onTap,
      child: Column(children: [
        for (var i = 0; i < 2; i++)
          Padding(
            padding: const EdgeInsets.only(bottom: Sp.s),
            child: Container(
              height: 14,
              decoration: BoxDecoration(color: p.strokeHairline, borderRadius: BorderRadius.circular(Rad.pill)),
            ),
          ),
        const SizedBox(height: Sp.xs),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          Icon(Icons.lock_outline, size: 18, color: p.terracotta),
          const SizedBox(width: Sp.s),
          Text(l.caseLockedMore(count), style: VipType.headline.copyWith(color: p.terracotta)),
        ]),
        const SizedBox(height: Sp.xs),
        Text(l.caseLockedBody, style: VipType.caption.copyWith(color: p.textSecondary), textAlign: TextAlign.center),
      ]),
    );
  }
}
