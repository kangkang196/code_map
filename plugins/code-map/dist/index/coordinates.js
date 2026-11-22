// Coordinate conversions between raw UTF-8 bytes, UTF-16 offsets and 1-based lines.
// Parsers disagree on offset units: the TypeScript compiler reports UTF-16 code-unit
// offsets into a BOM-stripped string. The pinned web-tree-sitter JavaScript API also
// reports UTF-16 offsets for string input. Both are normalised to raw-file UTF-8 byte offsets
// (left-closed, right-open) plus 1-based inclusive line numbers.
const BOM = [0xef, 0xbb, 0xbf];
export function decodeSource(raw) {
    let bomLength = 0;
    if (raw.length >= 3 && raw[0] === BOM[0] && raw[1] === BOM[1] && raw[2] === BOM[2]) {
        bomLength = 3;
    }
    const body = bomLength === 3 ? raw.subarray(3) : raw;
    const text = new TextDecoder('utf-8').decode(body);
    return { raw, bomLength, text };
}
export function encodeUtf8(text) {
    return new TextEncoder().encode(text);
}
export function utf8ByteLength(text) {
    return encodeUtf8(text).byteLength;
}
/**
 * Per-file coordinate mapper. Build once, reuse for every declaration in the file.
 *
 * `utf16ToByte` maps a UTF-16 offset into {@link SourceText.text} to a raw-file byte
 * offset. `lineStartByte` gives the raw byte offset where each 1-based line begins.
 */
export class CoordinateMapper {
    utf16ToByteMap;
    lineStarts;
    constructor(source, utf16ToByteMap, lineStarts) {
        this.source = source;
        this.utf16ToByteMap = utf16ToByteMap;
        this.lineStarts = lineStarts;
    }
    source;
    static build(source) {
        const text = source.text;
        const map = new Int32Array(text.length + 1);
        let bytes = source.bomLength;
        for (let i = 0; i < text.length; i++) {
            map[i] = bytes;
            const code = text.charCodeAt(i);
            if (code < 0x80) {
                bytes += 1;
            }
            else if (code < 0x800) {
                bytes += 2;
            }
            else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
                const next = text.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    // Surrogate pair: 4 bytes, advances two UTF-16 units.
                    map[i + 1] = bytes + 4;
                    bytes += 4;
                    i++;
                    continue;
                }
                bytes += 3;
            }
            else {
                bytes += 3;
            }
        }
        map[text.length] = bytes;
        // Line starts are recorded as UTF-16 offsets, then translated to raw bytes.
        const lineStartsUtf16 = [0];
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 0x0a) {
                lineStartsUtf16.push(i + 1);
            }
        }
        const lineStarts = lineStartsUtf16.map((o) => map[o] ?? 0);
        return new CoordinateMapper(source, map, lineStarts);
    }
    /** Convert a UTF-16 offset into {@link SourceText.text} to a raw-file byte offset. */
    utf16ToByte(offset) {
        if (offset <= 0)
            return this.source.bomLength;
        if (offset >= this.utf16ToByteMap.length)
            return this.utf16ToByteMap[this.utf16ToByteMap.length - 1] ?? 0;
        return this.utf16ToByteMap[offset] ?? 0;
    }
    /** Number of lines (1-based count). */
    get lineCount() {
        return this.lineStarts.length;
    }
    /** 1-based line number containing the given raw-file byte offset. */
    lineOfByte(byteOffset) {
        let lo = 0;
        let hi = this.lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if ((this.lineStarts[mid] ?? 0) <= byteOffset)
                lo = mid;
            else
                hi = mid - 1;
        }
        return lo + 1;
    }
    /** 1-based line number for a UTF-16 offset into the decoded text. */
    lineOfUtf16(offset) {
        return this.lineOfByte(this.utf16ToByte(offset));
    }
    /** Inclusive 1-based line range for a raw-file byte span [startByte, endByte). */
    linesOfByteRange(startByte, endByte) {
        const startLine = this.lineOfByte(startByte);
        const clampedEnd = Math.max(startByte, endByte - 1);
        const endLine = this.lineOfByte(clampedEnd);
        return { startLine, endLine };
    }
    /** Raw bytes for a byte span, useful for tests and signature extraction. */
    sliceBytes(startByte, endByte) {
        return this.source.raw.subarray(startByte, endByte);
    }
    /** Decoded text for a byte span. */
    sliceText(startByte, endByte) {
        return new TextDecoder('utf-8').decode(this.sliceBytes(startByte, endByte));
    }
}
