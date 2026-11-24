const EBML_HEADER_ID = 0x1a45dfa3;
const DOC_TYPE_ID = 0x4282;

interface Vint {
  value: number;
  length: number;
}

// EBML variable-size integer: the position of the first set bit of the first
// byte gives its length. Element IDs keep that marker bit, sizes drop it.
function readVint(buf: Buffer, at: number, keepMarker: boolean): Vint | null {
  if (at >= buf.length) return null;
  const first = buf[at];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > buf.length) return null;

  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + buf[at + i];
  return { value, length };
}

/**
 * DocType of a Matroska file ('webm' or 'matroska'), read from the EBML header
 * at the start of the file. Null when the bytes are not an EBML header or the
 * header is cut before the DocType.
 */
export function readDocType(buf: Buffer): string | null {
  const header = readVint(buf, 0, true);
  if (header?.value !== EBML_HEADER_ID) return null;
  const headerSize = readVint(buf, header.length, false);
  if (!headerSize) return null;

  let at = header.length + headerSize.length;
  const end = at + headerSize.value;
  while (at < end) {
    const id = readVint(buf, at, true);
    const size = id && readVint(buf, at + id.length, false);
    if (!id || !size) return null;

    const dataStart = at + id.length + size.length;
    if (id.value === DOC_TYPE_ID) {
      if (dataStart + size.value > buf.length) return null;
      const docType = buf.subarray(dataStart, dataStart + size.value);
      return docType.toString('ascii').replace(/\0+$/, '');
    }
    at = dataStart + size.value;
  }
  return null;
}
