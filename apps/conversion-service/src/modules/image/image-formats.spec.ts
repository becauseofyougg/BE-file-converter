import { looksLikeSvg, rasterSignature } from './image-formats';

describe('rasterSignature', () => {
  it('knows PNG and JPEG by their first bytes', () => {
    expect(
      rasterSignature(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe('png');
    expect(rasterSignature(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('nothing else, and nothing too short to tell', () => {
    expect(rasterSignature(Buffer.from('GIF89a'))).toBeNull();
    expect(rasterSignature(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(rasterSignature(Buffer.alloc(0))).toBeNull();
  });
});

describe('looksLikeSvg', () => {
  it.each([
    '<svg/>',
    '  \n<svg width="1">',
    '<?xml version="1.0"?><svg>',
    '<!-- a --><!-- b --><svg>',
    '<!DOCTYPE svg [ <!ENTITY a "b"> ]><svg>',
    '<s:svg xmlns:s="http://www.w3.org/2000/svg">',
  ])('yes: %s', (text) => {
    expect(looksLikeSvg(Buffer.from(text))).toBe(true);
  });

  it.each(['<svgx/>', '<html><svg/></html>', 'svg', '{"svg":1}', ''])(
    'no: %s',
    (text) => {
      expect(looksLikeSvg(Buffer.from(text))).toBe(false);
    },
  );
});
