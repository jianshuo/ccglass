// Lightweight, side-channel HTTP/1.x response parser.
//
// Fed a copy of the raw response bytes, it detects when the HTTP message is
// complete according to the protocol rules (Content-Length or chunked
// Transfer-Encoding), without interfering with the byte-for-byte forwarding
// path. It does NOT decode the body for forwarding — it only tracks framing so
// the caller can finalize the captured record promptly on keep-alive
// connections (where the socket "end" event may never fire).
//
// Also exposes the decoded body (chunked unwrapped) for storage/display.

const HEADERS = 0;
const BODY_LENGTH = 1;     // Content-Length framing
const BODY_CHUNK_SIZE = 2; // chunked: reading the size line
const BODY_CHUNK_DATA = 3; // chunked: reading `size` bytes of data
const BODY_CHUNK_CRLF = 4; // chunked: reading the trailing CRLF after data
const DONE = 5;

export class ResponseParser {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.state = HEADERS;
    this.status = null;
    this.headers = {};
    this.complete = false;

    // Content-Length framing
    this.contentLength = -1;
    this.bodyBytesSeen = 0;

    // chunked framing
    this.chunkRemaining = 0;

    // decoded body parts (chunked unwrapped; identity passes through as-is)
    this.bodyParts = [];
  }

  /** Feed bytes. Returns true once the full HTTP message has been seen. */
  feed(chunk) {
    if (this.complete) return true;
    this.buf = Buffer.concat([this.buf, chunk]);
    this._run();
    return this.complete;
  }

  /** The decoded response body (chunked unwrapped) as a string. */
  decodedBody() {
    return Buffer.concat(this.bodyParts).toString("utf8");
  }

  _run() {
    let progress = true;
    while (progress && !this.complete) {
      progress = false;

      if (this.state === HEADERS) {
        const end = this.buf.indexOf("\r\n\r\n");
        if (end < 0) return; // need more
        const headerStr = this.buf.slice(0, end).toString("utf8");
        this._parseHeaders(headerStr);
        this.buf = this.buf.slice(end + 4);

        const te = (this.headers["transfer-encoding"] || "").toLowerCase();
        if (te.includes("chunked")) {
          this.state = BODY_CHUNK_SIZE;
        } else if (this.contentLength >= 0) {
          this.state = BODY_LENGTH;
          if (this.contentLength === 0) this.state = DONE;
        } else {
          // No length and not chunked: framing is connection-close.
          // We cannot know completion until the socket ends. Stay in a
          // pass-through state that just collects body bytes.
          this.state = BODY_LENGTH;
          this.contentLength = Infinity;
        }
        progress = true;
      } else if (this.state === BODY_LENGTH) {
        if (this.buf.length > 0) {
          const take = this.contentLength === Infinity
            ? this.buf.length
            : Math.min(this.buf.length, this.contentLength - this.bodyBytesSeen);
          this.bodyParts.push(this.buf.slice(0, take));
          this.bodyBytesSeen += take;
          this.buf = this.buf.slice(take);
          progress = take > 0;
        }
        if (this.contentLength !== Infinity && this.bodyBytesSeen >= this.contentLength) {
          this.state = DONE;
          progress = true;
        }
      } else if (this.state === BODY_CHUNK_SIZE) {
        const nl = this.buf.indexOf("\r\n");
        if (nl < 0) return; // need more
        const sizeLine = this.buf.slice(0, nl).toString("utf8").trim();
        // Ignore chunk extensions after ';'
        const sizeHex = sizeLine.split(";")[0].trim();
        const size = parseInt(sizeHex, 16);
        this.buf = this.buf.slice(nl + 2);
        if (isNaN(size)) {
          // Malformed — give up parsing further (stay incomplete).
          return;
        }
        if (size === 0) {
          this.state = DONE; // terminator chunk; ignore trailers
          progress = true;
        } else {
          this.chunkRemaining = size;
          this.state = BODY_CHUNK_DATA;
          progress = true;
        }
      } else if (this.state === BODY_CHUNK_DATA) {
        if (this.buf.length === 0) return;
        const take = Math.min(this.buf.length, this.chunkRemaining);
        this.bodyParts.push(this.buf.slice(0, take));
        this.buf = this.buf.slice(take);
        this.chunkRemaining -= take;
        if (this.chunkRemaining === 0) this.state = BODY_CHUNK_CRLF;
        progress = take > 0;
      } else if (this.state === BODY_CHUNK_CRLF) {
        if (this.buf.length < 2) return; // need the trailing \r\n
        this.buf = this.buf.slice(2);
        this.state = BODY_CHUNK_SIZE;
        progress = true;
      }

      if (this.state === DONE) this.complete = true;
    }
  }

  _parseHeaders(headerStr) {
    const lines = headerStr.split("\r\n");
    const statusMatch = lines[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
    this.status = statusMatch ? parseInt(statusMatch[1]) : null;
    for (let i = 1; i < lines.length; i++) {
      const colon = lines[i].indexOf(":");
      if (colon > 0) {
        const k = lines[i].slice(0, colon).trim().toLowerCase();
        const v = lines[i].slice(colon + 1).trim();
        this.headers[k] = v;
      }
    }
    if (this.headers["content-length"] != null) {
      const n = parseInt(this.headers["content-length"], 10);
      if (!isNaN(n)) this.contentLength = n;
    }
  }
}
