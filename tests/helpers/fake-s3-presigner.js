// Fake of @aws-sdk/s3-request-presigner — returns a plausible (but not
// really fetchable) HTTPS URL, since unit tests never need to actually GET
// it: sendAudio() only passes the string through as audio.link to the Meta
// payload. Real reachability is checked separately by
// scripts/r2-audio-link-diagnostic.js against a real R2 bucket.
export async function getSignedUrl(_client, command, { expiresIn } = {}) {
  const key = command?.input?.Key || "unknown-key";
  return `https://fake-r2.local/${encodeURIComponent(key)}?X-Amz-Expires=${expiresIn || 3600}&X-Amz-Signature=fake`;
}
