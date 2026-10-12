import { AppError } from '@core/errors/app-error';
import { ERROR_CODES } from '@contracts/errors/error-codes';
import { parseFields, type ConvertRoute } from './convert-fields';

const IMAGES: ConvertRoute = {
  family: 'image',
  flatOptions: ['quality', 'width', 'height', 'background'],
};

const failure = (fields: Record<string, string>, route?: ConvertRoute) => {
  try {
    parseFields(fields, route);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);

    return error as AppError;
  }

  throw new Error('expected a refusal');
};

describe('parseFields', () => {
  it('normalises the target and reads save', () => {
    expect(parseFields({ targetFormat: ' YAML ' })).toEqual({
      targetFormat: 'yaml',
      save: false,
    });
    expect(parseFields({ targetFormat: 'xml', save: 'TRUE' })).toEqual({
      targetFormat: 'xml',
      save: true,
    });
    expect(parseFields({ targetFormat: 'xml', save: '0' }).save).toBe(false);
  });

  it('refuses a missing or malformed target', () => {
    expect(failure({}).code).toBe(ERROR_CODES.VALIDATION_FAILED);
    expect(failure({ targetFormat: '../json' }).details).toEqual([
      'targetFormat must be a format name, such as "json"',
    ]);
  });

  it('refuses a save that is not a boolean', () => {
    expect(failure({ targetFormat: 'json', save: 'yes' }).details).toEqual([
      'save must be true or false',
    ]);
  });

  it('refuses fields it does not know, as the JSON routes do', () => {
    expect(
      failure({ targetFormat: 'json', sourceFormat: 'csv' }).details,
    ).toEqual(['property sourceFormat should not exist']);
  });

  describe('options', () => {
    it('reads them as a JSON object on any route', () => {
      expect(
        parseFields({
          targetFormat: 'jpeg',
          options: '{"quality":80,"background":"#fff","flag":true}',
        }).options,
      ).toEqual({ quality: 80, background: '#fff', flag: true });
    });

    it('reads them as separate fields where the route allows, numbers as numbers', () => {
      expect(
        parseFields(
          {
            targetFormat: 'png',
            width: ' 512 ',
            height: '1e3',
            background: '#000',
          },
          IMAGES,
        ).options,
      ).toEqual({ width: 512, height: '1e3', background: '#000' });
    });

    it('leaves them out when there are none', () => {
      expect(parseFields({ targetFormat: 'png' }, IMAGES)).not.toHaveProperty(
        'options',
      );
    });

    it('does not take separate fields where the route does not', () => {
      expect(failure({ targetFormat: 'png', quality: '80' }).details).toEqual([
        'property quality should not exist',
      ]);
    });

    it('refuses both ways at once', () => {
      expect(
        failure(
          { targetFormat: 'jpeg', quality: '80', options: '{"quality":70}' },
          IMAGES,
        ).details,
      ).toEqual([
        'send options either as the options field or as separate fields (quality), not both',
      ]);
    });

    it.each(['not json', '[1,2]', '"text"', 'null'])(
      'refuses options that are not a JSON object: %s',
      (options) => {
        expect(failure({ targetFormat: 'png', options }).details).toEqual([
          'options must be a JSON object, such as {"quality":80}',
        ]);
      },
    );

    it('refuses nested values, long strings and too many keys', () => {
      expect(
        failure({
          targetFormat: 'png',
          options: JSON.stringify({ a: { b: 1 }, c: 'x'.repeat(65), d: 1 }),
        }).details,
      ).toEqual([
        'options.a must be a short string, a number or a boolean',
        'options.c must be a short string, a number or a boolean',
      ]);

      const many = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${index}`, index]),
      );

      expect(
        failure({ targetFormat: 'png', options: JSON.stringify(many) }).details,
      ).toEqual(['options may have at most 16 keys']);
    });

    it('refuses an empty or over-long key', () => {
      expect(
        failure({
          targetFormat: 'png',
          options: JSON.stringify({ '': 1, ['k'.repeat(33)]: 2 }),
        }).details,
      ).toHaveLength(2);
    });
  });
});
