import { readDocType } from './ebml-header';

// EBML header (ID 1A45DFA3) whose children are given as raw bytes.
function ebmlHeader(...children: number[][]): Buffer {
  const body = children.flat();
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length, ...body]);
}

const ascii = (text: string) => [...Buffer.from(text, 'ascii')];
const EBML_VERSION = [0x42, 0x86, 0x81, 0x01];

describe('readDocType', () => {
  it('reads the DocType of a WebM header', () => {
    const header = ebmlHeader(EBML_VERSION, [
      0x42,
      0x82,
      0x84,
      ...ascii('webm'),
    ]);

    expect(readDocType(header)).toBe('webm');
  });

  it('reads a DocType past byte 64 with a two-byte size', () => {
    const voidElement = [0xec, 0x80 | 80, ...new Array<number>(80).fill(0)];
    const docType = [0x42, 0x82, 0x40, 0x08, ...ascii('matroska')];
    const header = ebmlHeader(EBML_VERSION, voidElement, docType);

    expect(header.indexOf(Buffer.from([0x42, 0x82]))).toBeGreaterThan(64);
    expect(readDocType(header)).toBe('matroska');
  });

  it('returns null for bytes that are not an EBML header', () => {
    expect(readDocType(Buffer.from('ftypisom'))).toBeNull();
  });

  it('returns null when the header is cut before the DocType ends', () => {
    const header = ebmlHeader([0x42, 0x82, 0x84, ...ascii('webm')]);

    expect(readDocType(header.subarray(0, header.length - 2))).toBeNull();
  });
});
