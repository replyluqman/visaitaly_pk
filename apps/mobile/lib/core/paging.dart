import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'network/api_error.dart';

/// One page from a keyset-paginated endpoint.
class PageResult<T> {
  const PageResult(this.items, this.nextCursor, {this.meta});
  final List<T> items;
  final String? nextCursor;

  /// Endpoint-specific extras (e.g. the checklist's lockedCount).
  final Object? meta;
}

class PagedState<T> {
  const PagedState({
    this.items = const [],
    this.nextCursor,
    this.loadingFirst = true,
    this.loadingMore = false,
    this.error,
    this.meta,
  });
  final List<T> items;
  final String? nextCursor;
  final bool loadingFirst;
  final bool loadingMore;
  final ApiError? error;
  final Object? meta;

  bool get hasMore => nextCursor != null;
  bool get isEmpty => !loadingFirst && error == null && items.isEmpty;

  PagedState<T> copyWith({
    List<T>? items,
    Object? nextCursor = _keep,
    bool? loadingFirst,
    bool? loadingMore,
    Object? error = _keep,
    Object? meta = _keep,
  }) =>
      PagedState(
        items: items ?? this.items,
        nextCursor: identical(nextCursor, _keep) ? this.nextCursor : nextCursor as String?,
        loadingFirst: loadingFirst ?? this.loadingFirst,
        loadingMore: loadingMore ?? this.loadingMore,
        error: identical(error, _keep) ? this.error : error as ApiError?,
        meta: identical(meta, _keep) ? this.meta : meta,
      );

  static const _keep = Object();
}

/// Cursor pagination, as every list endpoint speaks it. The cursor is opaque — never parsed or built here.
/// A failed "load more" keeps the rows already shown and exposes the error so the footer can offer retry.
abstract class PagedNotifier<T> extends Notifier<PagedState<T>> {
  Future<PageResult<T>> fetchPage(String? cursor);

  @override
  PagedState<T> build() {
    Future.microtask(loadFirst);
    return PagedState<T>();
  }

  Future<void> loadFirst() async {
    state = state.copyWith(loadingFirst: true, error: null);
    try {
      final page = await fetchPage(null);
      state = PagedState(items: page.items, nextCursor: page.nextCursor, loadingFirst: false, meta: page.meta);
    } on ApiError catch (e) {
      state = state.copyWith(loadingFirst: false, error: e);
    }
  }

  Future<void> loadMore() async {
    if (state.loadingFirst || state.loadingMore || !state.hasMore) return;
    state = state.copyWith(loadingMore: true, error: null);
    try {
      final page = await fetchPage(state.nextCursor);
      state = state.copyWith(items: [...state.items, ...page.items], nextCursor: page.nextCursor, loadingMore: false, meta: page.meta ?? state.meta);
    } on ApiError catch (e) {
      state = state.copyWith(loadingMore: false, error: e);
    }
  }

  Future<void> refresh() => loadFirst();

  /// Optimistic local edit (e.g. a row marked read) without refetching the page.
  void replaceWhere(bool Function(T) test, T Function(T) update) {
    state = state.copyWith(items: [for (final i in state.items) test(i) ? update(i) : i]);
  }
}
