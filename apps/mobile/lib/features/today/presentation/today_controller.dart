import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/providers.dart';
import '../../documents/data/dto/document_dto.dart';

/// Today (Screen 9). Premium only: free/expired accounts get PREMIUM_REQUIRED, which the screen shows as the paywall
/// preview rather than an error.
final todayProvider = FutureProvider.autoDispose<TodayResponse>((ref) => ref.watch(todayRepositoryProvider).today());
