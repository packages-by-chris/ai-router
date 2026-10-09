import "dart:async";
import "dart:convert";

/// Minimal SSE parser over byte streams. Yields the payload of every `data:`
/// field. Event/id/retry fields and `:` comments are ignored (OpenAI-style
/// streams only use `data`). Handles CRLF, multi-line data fields, and
/// block boundaries split across network chunks.
Stream<String> sseData(Stream<List<int>> byteStream) async* {
  String buffer = "";
  const decoder = Utf8Decoder(allowMalformed: true);

  await for (final chunk in byteStream) {
    buffer += decoder.convert(chunk);

    while (true) {
      final boundary = _nextBoundary(buffer);
      if (boundary == null) break;
      final block = buffer.substring(0, boundary.index);
      buffer = buffer.substring(boundary.index + boundary.length);
      final data = _extractData(block);
      if (data != null) yield data;
    }
  }

  final tail = _extractData(buffer);
  if (tail != null) yield tail;
}

class _Boundary {
  final int index;
  final int length;
  const _Boundary(this.index, this.length);
}

_Boundary? _nextBoundary(String buf) {
  final lf = buf.indexOf("\n\n");
  final crlf = buf.indexOf("\r\n\r\n");
  if (lf == -1 && crlf == -1) return null;
  if (crlf == -1 || (lf != -1 && lf < crlf)) return _Boundary(lf, 2);
  return _Boundary(crlf, 4);
}

String? _extractData(String block) {
  final lines = block.split(RegExp(r"\r?\n"));
  final dataLines = <String>[];
  for (final line in lines) {
    if (line.startsWith("data:")) {
      var value = line.substring(5);
      if (value.startsWith(" ")) value = value.substring(1);
      dataLines.add(value);
    }
  }
  if (dataLines.isEmpty) return null;
  return dataLines.join("\n");
}

/// Helper for tests and conformance fixtures: byte stream from chunk strings.
Stream<List<int>> streamFromChunks(List<String> parts) async* {
  for (final part in parts) {
    yield utf8.encode(part);
  }
}
