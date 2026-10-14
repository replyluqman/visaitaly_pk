import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

class PickedFile {
  const PickedFile({required this.name, required this.bytes, required this.mime});
  final String name;
  final Uint8List bytes;
  final String mime;
}

/// Seam over the platform file picker so screens and tests never touch a plugin.
abstract class FilePickerGateway {
  /// null = the user cancelled. Throws [FileTooLargeToRead] rather than loading something huge into memory.
  Future<PickedFile?> pick({bool imagesOnly = false});
}

class FileTooLargeToRead implements Exception {
  const FileTooLargeToRead();
}

String? mimeForExtension(String? ext) => switch (ext?.toLowerCase()) {
      'jpg' || 'jpeg' => 'image/jpeg',
      'png' => 'image/png',
      'pdf' => 'application/pdf',
      _ => null,
    };

class PlatformFilePicker implements FilePickerGateway {
  /// A MEMORY guard, not a policy: the real per-file and per-account limits are server config and come back as
  /// UPLOAD_TOO_LARGE / UPLOAD_QUOTA_EXCEEDED. This only stops a pathological file from being read into RAM.
  static const memoryGuardBytes = 64 * 1024 * 1024;

  @override
  Future<PickedFile?> pick({bool imagesOnly = false}) async {
    final res = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: imagesOnly ? const ['jpg', 'jpeg', 'png'] : const ['jpg', 'jpeg', 'png', 'pdf'],
    );
    if (res.isEmpty) return null;
    final f = res.first;
    final mime = mimeForExtension(f.extension);
    if (mime == null) return null;
    final size = await f.length();
    if (size != null && size > memoryGuardBytes) throw const FileTooLargeToRead();
    return PickedFile(name: f.name, bytes: await f.readAsBytes(), mime: mime);
  }
}

final filePickerProvider = Provider<FilePickerGateway>((ref) => PlatformFilePicker());
