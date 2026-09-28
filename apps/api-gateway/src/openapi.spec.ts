const createDocument = jest.fn();
const setup = jest.fn();

jest.mock('@nestjs/swagger', () => {
  const actual =
    jest.requireActual<typeof import('@nestjs/swagger')>('@nestjs/swagger');

  return {
    ...actual,
    SwaggerModule: {
      createDocument: (...args: unknown[]) => createDocument(...args),
      setup: (...args: unknown[]) => setup(...args),
    },
  };
});

import type { OpenAPIObject } from '@nestjs/swagger';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ERROR_CODES } from '@contracts/errors/error-codes';

import { OPENAPI_PATH, setupOpenApi } from './openapi';

describe('setupOpenApi', () => {
  const app = {} as NestFastifyApplication;

  const config = () =>
    createDocument.mock.calls[0][1] as Omit<OpenAPIObject, 'paths'>;
  const document = () => setup.mock.calls[0][2] as OpenAPIObject;

  beforeEach(() => {
    createDocument.mockReset().mockReturnValue({ paths: {} });
    setup.mockReset();

    setupOpenApi(app);
  });

  it('builds the document from the running application', () => {
    expect(createDocument).toHaveBeenCalledWith(app, expect.any(Object), {
      operationIdFactory: expect.any(Function),
    });
  });

  it('titles and versions the API', () => {
    expect(config().info.title).toBe('File Converter API');
    expect(config().info.version).toBe('1.0');
  });

  /**
   * A browser authenticates with a cookie, not a bearer header. Declaring it
   * is what makes "Try it out" work against a real session rather than
   * silently sending nothing.
   */
  it('declares the cookie scheme a browser actually uses', () => {
    expect(config().components?.securitySchemes).toMatchObject({
      access_token: { type: 'apiKey', in: 'cookie', name: 'access_token' },
    });
  });

  it('declares bearer too, for callers that are not browsers', () => {
    expect(config().components?.securitySchemes).toMatchObject({
      bearer: { type: 'http', scheme: 'bearer' },
    });
  });

  it('names a tag for every surface', () => {
    expect(config().tags?.map((tag) => tag.name)).toEqual([
      'auth',
      'users',
      'admin',
      'health',
    ]);
  });

  /**
   * The error codes are a contract in their own right, and no DTO carries
   * them — so they are attached to the schema the envelope refers to.
   */
  it('publishes the closed set of error codes', () => {
    const schema = document().components?.schemas?.ErrorCode as {
      enum: string[];
    };

    expect(schema.enum).toEqual(Object.values(ERROR_CODES));
    expect(schema.enum).toContain(ERROR_CODES.INVALID_CREDENTIALS);
  });

  it('serves the document and its JSON under a stable path', () => {
    expect(setup).toHaveBeenCalledWith(
      OPENAPI_PATH,
      app,
      expect.any(Object),
      expect.objectContaining({ jsonDocumentUrl: `${OPENAPI_PATH}/json` }),
    );
  });

  /**
   * So a generated client reads `listUsers()` rather than
   * `UsersController_listUsers_v1`.
   */
  it('names operations after the methods that serve them', () => {
    const { operationIdFactory } = createDocument.mock.calls[0][2] as {
      operationIdFactory: (controller: string, method: string) => string;
    };

    expect(operationIdFactory('UsersController', 'listUsers')).toBe(
      'listUsers',
    );
  });

  it('survives a document that arrives with no components at all', () => {
    createDocument.mockReturnValue({ paths: {} });

    expect(() => setupOpenApi(app)).not.toThrow();
  });
});
