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
            quality: '80',
            background: ' #000 ',
          },
          IMAGES,
        ).options,
      ).toEqual({ width: 512, quality: 80, background: '#000' });
    });

    it.each([
      [{ width: '1e3' }, 'width must be a whole number'],
      [{ height: '-5' }, 'height must be a whole number'],
      [{ quality: '0' }, 'quality must not be less than 1'],
      [{ quality: '101' }, 'quality must not be greater than 100'],
      [
        { background: 'x'.repeat(65) },
        'background must be shorter than or equal to 64 characters',
      ],
    ])('refuses a separate field of the wrong shape: %j', (field, message) => {
      // Every rule the value breaks is reported: `-5` is not a whole number
      // in the form's sense and is under the minimum.
      expect(
        failure({ targetFormat: 'png', ...field }, IMAGES).details,
      ).toContain(message);
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
        'options.a, options.c: each option must be a short string, a number or a boolean, under a short name',
      ]);

      const many = Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`k${index}`, index]),
      );

      expect(
        failure({ targetFormat: 'png', options: JSON.stringify(many) }).details,
      ).toEqual(['options may have at most 16 keys']);
    });

    it('refuses an empty or over-long key, naming both', () => {
      const [message] = failure({
        targetFormat: 'png',
        options: JSON.stringify({ '': 1, ['k'.repeat(33)]: 2 }),
      }).details as string[];

      expect(message).toMatch(/^options\., options\.k{33}: /);
    });

    it('is validated by class-validator, like every other input', () => {
      expect(
        failure({ targetFormat: 'png', save: 'maybe', mode: 'x' }).details,
      ).toEqual([
        'property mode should not exist',
        'save must be true or false',
      ]);
    });
  });
});
