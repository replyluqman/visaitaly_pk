import 'package:dio/dio.dart';

import 'fakes.dart';

/// A stateful stand-in for the API's onboarding state machine, built from the REAL captured fixtures. It
/// answers the way the server does (state recomputed after each write), so flow tests exercise the app's
/// reaction to server state rather than a script of canned replies.
class FakeServer {
  FakeServer({this.canWrite = true, this.maxApplicants = 10});

  String onboardingState = 'disclaimer_pending';
  bool legalPending = true;
  int? declared;
  bool canWrite;
  int maxApplicants;
  final List<Map<String, dynamic>> applicants = [];
  final List<RequestLog> log = [];
  int _n = 0;

  /// One-shot overrides: path → response, consumed on first use.
  final Map<String, ({int status, Object? body, Map<String, String>? headers})> failures = {};

  Map<String, dynamic> me() {
    final m = fixture('me_complete');
    (m['user'] as Map<String, dynamic>)['onboardingState'] = onboardingState;
    m['legal'] = {'requiresAcceptance': legalPending, 'pendingDocTypes': legalPending ? ['disclaimer'] : <String>[]};
    m['applicants'] = {
      'declaredCount': declared,
      'total': applicants.length,
      'awaitingStage': applicants.where((a) => a['currentStage'] == null).length,
    };
    return m;
  }

  void _recompute() {
    if (legalPending) {
      onboardingState = 'disclaimer_pending';
    } else if (declared == null || applicants.length < declared!) {
      onboardingState = 'applicants_pending';
    } else if (applicants.any((a) => a['currentStage'] == null)) {
      onboardingState = 'stage_pending';
    } else {
      onboardingState = 'complete';
    }
  }

  Map<String, dynamic> _applicant(Map<String, dynamic> body) {
    final base = (fixture('applicants_list')['applicants'] as List).first as Map<String, dynamic>;
    final rel = (fixture('relationships')['relationships'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((r) => r['code'] == body['relationshipCode']);
    return {
      ...base,
      'id': 'a${++_n}',
      'displayName': body['displayName'],
      'relationshipCode': body['relationshipCode'],
      'relationshipLabel': rel['label'],
      'relationshipCategory': rel['category'],
      'dateOfBirth': body['dateOfBirth'],
      'currentLocation': body['currentLocation'],
      'currentStage': body['currentStage'],
      'caseGeneratedAt': body['currentStage'] == null ? null : base['caseGeneratedAt'],
      'nullaOsta': {'status': body['nullaOstaStatus'] ?? 'not_started', 'issueDate': null, 'expiryDate': null, 'daysRemaining': null},
      'access': {'level': canWrite ? 'free' : 'grace_read_only', 'canWrite': canWrite, 'accessUntil': null, 'graceUntil': null},
    };
  }

  ({int status, Object? body, Map<String, String>? headers}) handle(RequestOptions o) {
    final key = '${o.method} ${o.path}';
    log.add(RequestLog(o.method, o.path, o.data));
    final fail = failures.remove(key);
    if (fail != null) return fail;
    final path = o.path;
    final data = o.data is Map ? Map<String, dynamic>.from(o.data as Map) : <String, dynamic>{};

    if (key == 'POST /v1/auth/session') {
      return reply(201, {...me(), 'session': {'evictedDeviceIds': <String>[], 'isNewUser': false}});
    }
    if (key == 'GET /v1/me') return reply(200, me());
    if (key == 'GET /v1/legal/current') {
      final cur = fixture('legal_current');
      for (final d in (cur['documents'] as List).cast<Map<String, dynamic>>()) {
        d['accepted'] = !legalPending;
      }
      cur['requiresAcceptance'] = legalPending;
      return reply(200, cur);
    }
    if (path.startsWith('/v1/legal/current/')) return reply(200, fixture('legal_document'));
    if (key == 'POST /v1/legal/accept') {
      legalPending = false;
      _recompute();
      return reply(200, {'acceptedVersionIds': data['versionIds'], 'onboardingState': onboardingState});
    }
    if (key == 'PATCH /v1/onboarding/applicant-count') {
      declared = data['declaredApplicantCount'] as int;
      _recompute();
      return reply(200, {'declaredApplicantCount': declared, 'onboardingState': onboardingState});
    }
    if (key == 'GET /v1/reference/relationships') return reply(200, fixture('relationships'));
    if (key == 'GET /v1/applicants') return reply(200, {'applicants': applicants, 'maxApplicants': maxApplicants});
    if (key == 'POST /v1/applicants') {
      if (applicants.length >= maxApplicants) return reply(409, errorBody('APPLICANT_LIMIT_REACHED'));
      final a = _applicant(data);
      applicants.add(a);
      _recompute();
      return reply(201, {'applicant': a, 'onboardingState': onboardingState});
    }
    final stage = RegExp(r'^/v1/applicants/([^/]+)/stage$').firstMatch(path);
    if (stage != null && o.method == 'PATCH') {
      final a = applicants.firstWhere((x) => x['id'] == stage.group(1));
      a['currentStage'] = data['currentStage'];
      a['caseGeneratedAt'] = '2026-10-14T01:31:09.243Z';
      _recompute();
      return reply(200, {'applicant': a, 'onboardingState': onboardingState});
    }
    final one = RegExp(r'^/v1/applicants/([^/]+)$').firstMatch(path);
    if (one != null && o.method == 'PATCH') {
      final a = applicants.firstWhere((x) => x['id'] == one.group(1));
      if (data['nullaOstaStatus'] != null) {
        a['nullaOsta'] = {...(a['nullaOsta'] as Map<String, dynamic>), 'status': data['nullaOstaStatus']};
      }
      return reply(200, a);
    }
    return reply(404, errorBody('NOT_FOUND'));
  }
}

class RequestLog {
  RequestLog(this.method, this.path, this.data);
  final String method;
  final String path;
  final Object? data;
}
