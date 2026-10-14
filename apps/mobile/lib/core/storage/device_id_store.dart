import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

/// The device id is a random UUIDv4 generated once and kept in secure storage — never a hardware id
/// (Play policy; ANDROID_ID resets on reinstall and would silently burn device slots). It is the only thing
/// stored there: the app holds no API secrets.
abstract class DeviceIdStore {
  Future<String> getOrCreate();
}

class SecureDeviceIdStore implements DeviceIdStore {
  SecureDeviceIdStore([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();
  static const _key = 'device_id';
  final FlutterSecureStorage _storage;
  String? _cached;

  @override
  Future<String> getOrCreate() async {
    final cached = _cached;
    if (cached != null) return cached;
    var id = await _storage.read(key: _key);
    if (id == null || !Uuid.isValidUUID(fromString: id)) {
      id = const Uuid().v4();
      await _storage.write(key: _key, value: id);
    }
    return _cached = id;
  }
}
