import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/paging.dart';
import '../../../core/providers.dart';
import '../data/dto/document_dto.dart';

/// "My Documents" (Screen 14): all files across applicants, newest first. `applicantId` null = everyone.
class DocumentsNotifier extends PagedNotifier<DocumentDto> {
  DocumentsNotifier(this.applicantId);
  final String? applicantId;

  @override
  Future<PageResult<DocumentDto>> fetchPage(String? cursor) async {
    final r = await ref.read(documentsRepositoryProvider).list(applicantId: applicantId, cursor: cursor);
    return PageResult(r.items, r.nextCursor, meta: r.quota);
  }
}

final documentsProvider =
    NotifierProvider.autoDispose.family<DocumentsNotifier, PagedState<DocumentDto>, String?>(DocumentsNotifier.new);

extension DocQuota on PagedState<DocumentDto> {
  QuotaDto? get quota => meta as QuotaDto?;
}
