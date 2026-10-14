import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../app/routes.dart';
import '../../../core/design/glass_surface.dart';
import '../../../core/design/tokens.dart';
import '../../../core/l10n/app_localizations.dart';

/// What a locked item / Today leads to until checkout exists (Modules 6–7 are blocked on the currency decision):
/// an honest explanation plus the two things that ARE available — how verification works, and a pre-sales question.
/// It deliberately has no price and no purchase button.
Future<void> showPaywallPreview(BuildContext context) => showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (ctx) => const PaywallPreviewSheet(),
    );

class PaywallPreviewSheet extends StatelessWidget {
  const PaywallPreviewSheet({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = context.vip;
    return GlassSurface(
      blur: Blur.sheet,
      borderRadius: const BorderRadius.vertical(top: Radius.circular(Rad.xl)),
      strong: true, // text-heavy: a solid surface even on the full tier, never glass on glass
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(Sp.xxl),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Row(children: [
              Icon(Icons.lock_outline, color: p.terracotta),
              const SizedBox(width: Sp.s),
              Expanded(child: Text(l.paywallTitle, style: VipType.title)),
            ]),
            const SizedBox(height: Sp.m),
            Text(l.paywallBody, style: VipType.body),
            const SizedBox(height: Sp.m),
            Text(l.paywallNoPurchase, key: const Key('paywallNoPurchase'), style: VipType.caption.copyWith(color: p.textSecondary)),
            const SizedBox(height: Sp.xl),
            FilledButton(
              key: const Key('paywallVerify'),
              onPressed: () {
                Navigator.of(context).pop();
                context.push(Routes.verify);
              },
              child: Text(l.paywallVerify),
            ),
            const SizedBox(height: Sp.s),
            OutlinedButton(
              key: const Key('paywallAsk'),
              onPressed: () {
                Navigator.of(context).pop();
                context.push(Routes.support);
              },
              child: Text(l.paywallAsk),
            ),
          ]),
        ),
      ),
    );
  }
}
