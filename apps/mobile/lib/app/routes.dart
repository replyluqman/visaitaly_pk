/// All route paths in one place (and the deep-link whitelist), so features can navigate without importing the router.
abstract final class Routes {
  static const splash = '/splash';
  static const update = '/update';
  static const login = '/login';
  static const eligibility = '/eligibility';
  static const legal = '/legal';
  static const count = '/onboarding/count';
  static const applicant = '/onboarding/applicant';
  static const stage = '/onboarding/stage';

  // bottom-nav tabs
  static const home = '/home';
  static const today = '/today';
  static const documents = '/documents';
  static const account = '/account';

  // pushed screens
  static const addApplicant = '/applicants/new';
  static const notifications = '/notifications';
  static const support = '/support';
  static const verify = '/verify';
  static String caseView(String applicantId) => '/applicants/$applicantId';
  static String journey(String applicantId) => '/applicants/$applicantId/journey';
  static String item(String itemId) => '/checklist/$itemId';
}

const _uuid = r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
final _deepLinks = <RegExp>[
  RegExp('^/checklist/$_uuid\$'),
  RegExp('^/applicants/$_uuid\$'),
  RegExp('^/applicants/$_uuid/journey\$'),
  RegExp(r'^/(documents|support|verify|today|notifications|account|home)$'),
];

/// Notification / Today deep links come from the server. Only app-relative paths of a known shape are followed —
/// anything else returns null and the caller stays where it is.
String? safeDeepLink(String? link) {
  if (link == null) return null;
  return _deepLinks.any((p) => p.hasMatch(link)) ? link : null;
}
