// In-memory fake of the tiny @aws-sdk/client-s3 subset lib/_lib/media-storage.js
// actually uses (PutObjectCommand/GetObjectCommand/HeadObjectCommand/
// DeleteObjectCommand + S3Client#send). No real network/R2 calls in tests.
const store = new Map(); // key -> { body: Buffer, contentType: string }
let putCount = 0;
let forceMismatchedContentType = false;

export class PutObjectCommand {
  constructor(input) { this.input = input; }
}
export class GetObjectCommand {
  constructor(input) { this.input = input; }
}
export class HeadObjectCommand {
  constructor(input) { this.input = input; }
}
export class DeleteObjectCommand {
  constructor(input) { this.input = input; }
}

function notFoundError() {
  const err = new Error("NotFound");
  err.name = "NotFound";
  err.$metadata = { httpStatusCode: 404 };
  return err;
}

export class S3Client {
  constructor(_opts) {}

  async send(command) {
    if (command instanceof PutObjectCommand) {
      putCount += 1;
      store.set(command.input.Key, {
        body: Buffer.isBuffer(command.input.Body) ? command.input.Body : Buffer.from(command.input.Body),
        contentType: command.input.ContentType || null,
      });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const obj = store.get(command.input.Key);
      if (!obj) throw notFoundError();
      return {
        ContentLength: obj.body.length,
        ContentType: forceMismatchedContentType ? "application/octet-stream" : obj.contentType,
        Metadata: {},
      };
    }
    if (command instanceof GetObjectCommand) {
      const obj = store.get(command.input.Key);
      if (!obj) throw notFoundError();
      return { Body: (async function* () { yield obj.body; })() };
    }
    if (command instanceof DeleteObjectCommand) {
      store.delete(command.input.Key);
      return {};
    }
    throw new Error("FakeS3Client: comando não suportado");
  }

  // Test-only helpers — não fazem parte da API real do S3Client.
  static _reset() { store.clear(); putCount = 0; forceMismatchedContentType = false; }
  static _getObject(key) { return store.get(key) || null; }
  static _getPutCount() { return putCount; }
  static _forceMismatchedContentType(enabled) { forceMismatchedContentType = enabled; }
}
