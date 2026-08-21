import { describe, expect, test } from "bun:test";
import { sseData, streamFromChunks } from "../src/http/sse.js";

async function collect(parts: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const data of sseData(streamFromChunks(parts))) out.push(data);
  return out;
}

describe("sseData", () => {
  test("parses well-formed events", async () => {
    expect(await collect(["data: {\"a\":1}\n\n", "data: DONE-ish"])).toEqual([
      '{"a":1}',
      "DONE-ish",
    ]);
  });

  test("handles block boundaries split across chunks", async () => {
    expect(await collect(["data: x\n", "\ndata: y\n\n"])).toEqual(["x", "y"]);
  });

  test("handles CRLF line endings", async () => {
    expect(await collect(["data: a\r\n\r\ndata: b\r\n\r\n"])).toEqual(["a", "b"]);
  });

  test("ignores comments and non-data fields", async () => {
    expect(await collect([": keepalive\nevent: ping\nid: 1\ndata: 1\n\n"])).toEqual(["1"]);
  });

  test("joins multi-line data fields", async () => {
    expect(await collect(["data: l1\ndata: l2\n\n"])).toEqual(["l1\nl2"]);
  });

  test("skips blocks without data", async () => {
    expect(await collect(["event: ping\n\n", "data: real\n\n"])).toEqual(["real"]);
  });

  test("flushes a trailing unterminated block", async () => {
    expect(await collect(["data: tail"])).toEqual(["tail"]);
  });
});
