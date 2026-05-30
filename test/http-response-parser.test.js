import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseParser } from "../src/http-response-parser.js";

test("parser completes on Content-Length body", () => {
  const p = new ResponseParser();
  const done = p.feed(Buffer.from(
    "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"
  ));
  assert.strictEqual(done, true);
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.decodedBody(), "hello");
});

test("parser completes on chunked terminator", () => {
  const p = new ResponseParser();
  const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
    "5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
  const done = p.feed(Buffer.from(raw));
  assert.strictEqual(done, true);
  assert.strictEqual(p.decodedBody(), "hello world");
});

test("parser handles chunk split across feeds (TCP fragmentation)", () => {
  const p = new ResponseParser();
  // "data: {\"hello\":\"world\"}\n\n" is 25 bytes = 0x19
  assert.strictEqual(p.feed(Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")), false);
  assert.strictEqual(p.feed(Buffer.from("19\r\ndata: {\"hello\":\"world\"}\n\n")), false);
  assert.strictEqual(p.feed(Buffer.from("\r\n0\r")), false); // terminator split here
  assert.strictEqual(p.feed(Buffer.from("\n\r\n")), true);
  assert.strictEqual(p.decodedBody(), "data: {\"hello\":\"world\"}\n\n");
});

test("parser does not falsely complete on body containing 0\\r\\n", () => {
  const p = new ResponseParser();
  // chunk data legitimately contains "0\r\n" inside
  const body = "a0\r\nb"; // 5 bytes
  const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
    "5\r\n" + body + "\r\n";
  assert.strictEqual(p.feed(Buffer.from(raw)), false, "should not be complete yet");
  assert.strictEqual(p.feed(Buffer.from("0\r\n\r\n")), true);
  assert.strictEqual(p.decodedBody(), "a0\r\nb");
});

test("parser completes immediately on Content-Length: 0", () => {
  const p = new ResponseParser();
  const done = p.feed(Buffer.from("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"));
  assert.strictEqual(done, true);
  assert.strictEqual(p.status, 204);
  assert.strictEqual(p.decodedBody(), "");
});

test("parser handles SSE chunked stream", () => {
  const p = new ResponseParser();
  assert.strictEqual(p.feed(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n")), false);
  // first SSE event
  const ev1 = "data: {\"delta\":\"hi\"}\n\n";
  assert.strictEqual(p.feed(Buffer.from(ev1.length.toString(16) + "\r\n" + ev1 + "\r\n")), false);
  // DONE event
  const ev2 = "data: [DONE]\n\n";
  assert.strictEqual(p.feed(Buffer.from(ev2.length.toString(16) + "\r\n" + ev2 + "\r\n")), false);
  // terminator
  assert.strictEqual(p.feed(Buffer.from("0\r\n\r\n")), true);
  assert.strictEqual(p.decodedBody(), ev1 + ev2);
});

test("parser handles chunk extensions", () => {
  const p = new ResponseParser();
  const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" +
    "5;foo=bar\r\nhello\r\n0\r\n\r\n";
  assert.strictEqual(p.feed(Buffer.from(raw)), true);
  assert.strictEqual(p.decodedBody(), "hello");
});
