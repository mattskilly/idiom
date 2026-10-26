import type { ReferenceImageMediaType } from "../schemas/reference.js";

export const MAX_REFERENCE_ENCODED_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_IMAGE_DIMENSION = 8_000;

export type ReferenceImageDimensions = { width: number; height: number };

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngDimensions(source: Buffer): ReferenceImageDimensions | undefined {
  if (
    source.length < 24 ||
    !source.subarray(0, 8).equals(PNG_SIGNATURE) ||
    source.toString("ascii", 12, 16) !== "IHDR"
  )
    return undefined;
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}

function gifDimensions(source: Buffer): ReferenceImageDimensions | undefined {
  if (source.length < 10) return undefined;
  const header = source.toString("ascii", 0, 6);
  if (header !== "GIF87a" && header !== "GIF89a") return undefined;
  return { width: source.readUInt16LE(6), height: source.readUInt16LE(8) };
}

function webpDimensions(source: Buffer): ReferenceImageDimensions | undefined {
  if (
    source.length < 16 ||
    source.toString("ascii", 0, 4) !== "RIFF" ||
    source.toString("ascii", 8, 12) !== "WEBP"
  )
    return undefined;
  // Chunk payloads all begin at byte 20: 12..15 fourcc, 16..19 chunk size.
  switch (source.toString("ascii", 12, 16)) {
    case "VP8X": {
      if (source.length < 30) return undefined;
      return {
        width: source.readUIntLE(24, 3) + 1,
        height: source.readUIntLE(27, 3) + 1,
      };
    }
    case "VP8L": {
      if (source.length < 25 || source[20] !== 0x2f) return undefined;
      const bits = source.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    case "VP8 ": {
      if (
        source.length < 30 ||
        source[23] !== 0x9d ||
        source[24] !== 0x01 ||
        source[25] !== 0x2a
      )
        return undefined;
      return {
        width: source.readUInt16LE(26) & 0x3fff,
        height: source.readUInt16LE(28) & 0x3fff,
      };
    }
    default:
      return undefined;
  }
}

function jpegDimensions(source: Buffer): ReferenceImageDimensions | undefined {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8)
    return undefined;
  let offset = 2;
  while (offset + 1 < source.length) {
    if (source[offset] !== 0xff) return undefined;
    let marker = source[offset + 1] as number;
    offset += 2;
    // Any number of 0xff fill bytes may precede the marker code.
    while (marker === 0xff && offset < source.length) {
      marker = source[offset] as number;
      offset += 1;
    }
    // Standalone markers carry no length field.
    if (
      marker === 0x01 ||
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (offset + 2 > source.length) return undefined;
    const length = source.readUInt16BE(offset);
    if (length < 2) return undefined;
    // SOF0..SOF15 carry the frame dimensions; DHT, JPG, and DAC share the range.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 7 > source.length) return undefined;
      return {
        width: source.readUInt16BE(offset + 5),
        height: source.readUInt16BE(offset + 3),
      };
    }
    // Entropy-coded scan data follows SOS; no frame header can be read past it.
    if (marker === 0xda) return undefined;
    offset += length;
  }
  return undefined;
}

export function referenceImageDimensions(
  source: Buffer,
  mediaType: ReferenceImageMediaType,
): ReferenceImageDimensions | undefined {
  switch (mediaType) {
    case "image/png":
      return pngDimensions(source);
    case "image/jpeg":
      return jpegDimensions(source);
    case "image/webp":
      return webpDimensions(source);
    case "image/gif":
      return gifDimensions(source);
    default:
      return undefined;
  }
}

export function referenceImageLimitIssue(
  source: Buffer,
  mediaType: ReferenceImageMediaType,
): string | undefined {
  const dimensions = referenceImageDimensions(source, mediaType);
  if (
    dimensions !== undefined &&
    (dimensions.width > MAX_REFERENCE_IMAGE_DIMENSION ||
      dimensions.height > MAX_REFERENCE_IMAGE_DIMENSION)
  )
    return `${dimensions.width}x${dimensions.height}px exceeds ${MAX_REFERENCE_IMAGE_DIMENSION}x${MAX_REFERENCE_IMAGE_DIMENSION}px`;

  const encodedBytes = Math.ceil(source.byteLength / 3) * 4;
  if (encodedBytes > MAX_REFERENCE_ENCODED_BYTES)
    return `base64 size ${encodedBytes} bytes exceeds ${MAX_REFERENCE_ENCODED_BYTES} bytes`;
  return undefined;
}

/** The media type the leading bytes declare, regardless of file name. */
export function sniffImageMediaType(
  source: Buffer,
): ReferenceImageMediaType | "image/svg+xml" | undefined {
  if (source.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff)
    return "image/jpeg";
  if (
    source.toString("ascii", 0, 4) === "RIFF" &&
    source.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  const header = source.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  if (
    /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source.toString("utf8", 0, 512))
  )
    return "image/svg+xml";
  return undefined;
}
