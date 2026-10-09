import "dart:convert";
import "dart:io";
import "package:ai_router/src/conformance/runner.dart";
import "package:path/path.dart" as p;
import "package:test/test.dart";

void main() {
  final currentDir = Directory.current.path;
  final casesDir = Directory(p.join(currentDir, "..", "core", "conformance", "cases"));

  final jsonFiles = casesDir
      .listSync()
      .whereType<File>()
      .where((f) => f.path.endsWith(".json"))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));

  group("Cross-SDK Conformance Tests", () {
    for (final file in jsonFiles) {
      final fileName = p.basename(file.path);
      final content = file.readAsStringSync();
      final data = jsonDecode(content) as Map<String, dynamic>;
      final cases = data["cases"] as List? ?? [];

      group(fileName, () {
        for (final rawCase in cases) {
          final caseDict = rawCase as Map<String, dynamic>;
          final name = caseDict["name"] as String? ?? "unnamed case";

          test(name, () async {
            final result = await runTranslationCase(caseDict);
            if (!result.ok) {
              fail(
                "Conformance failure for $fileName :: $name\n"
                "Expected: ${result.expected}\n"
                "Actual:   ${result.actual}",
              );
            }
          });
        }
      });
    }
  });
}
