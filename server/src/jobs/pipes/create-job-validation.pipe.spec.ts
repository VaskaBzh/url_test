import { BadRequestException, Logger } from '@nestjs/common';
import { CreateJobValidationPipe } from './create-job-validation.pipe';

describe('CreateJobValidationPipe', () => {
  let validationPipe: CreateJobValidationPipe;
  let warningLogger: jest.SpyInstance;
  let debugLogger: jest.SpyInstance;

  beforeEach(() => {
    warningLogger = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    debugLogger = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    validationPipe = new CreateJobValidationPipe();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    { expectedMessage: 'body must be an object', payload: null },
    { expectedMessage: 'body must be an object', payload: [] },
    { expectedMessage: 'body must be an object', payload: 'invalid' },
    { expectedMessage: 'urls must be an array', payload: {} },
    {
      expectedMessage: 'urls must be an array',
      payload: { urls: 'http://localhost' },
    },
    {
      expectedMessage: 'urls must contain at least one item',
      payload: { urls: [] },
    },
    {
      expectedMessage: 'urls[0] must be a string',
      payload: { urls: [42] },
    },
    {
      expectedMessage: 'urls[0] must not be blank',
      payload: { urls: ['   '] },
    },
    {
      expectedMessage: 'urls[0] must be an absolute URL',
      payload: { urls: ['/relative'] },
    },
    {
      expectedMessage: 'urls[0] must use http or https',
      payload: { urls: ['ftp://localhost/file'] },
    },
    {
      expectedMessage: 'urls[0] must not contain credentials',
      payload: { urls: ['https://user:secret@example.com'] },
    },
  ])(
    'returns a stable bad-request response for $expectedMessage',
    ({ expectedMessage, payload }) => {
      expectBadRequest(validationPipe, payload, expectedMessage);
      expect(warningLogger).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects a payload with more than fifty URLs', () => {
    const urls = Array.from(
      { length: 51 },
      (_, urlIndex) => `http://localhost/${urlIndex}`,
    );

    expectBadRequest(
      validationPipe,
      { urls },
      'urls must contain at most 50 items',
    );
  });

  it('rejects a URL longer than the contract limit', () => {
    expectBadRequest(
      validationPipe,
      { urls: [`http://localhost/${'a'.repeat(2_049)}`] },
      'urls[0] must contain at most 2048 characters',
    );
  });

  it('normalizes valid URLs while preserving order and duplicates', () => {
    const result = validationPipe.transform({
      ignoredField: 'backward-compatible',
      urls: [
        '  http://localhost:3000/path?key=value  ',
        'https://127.0.0.1/resource',
        'http://localhost:3000/path?key=value',
      ],
    });

    expect(result).toEqual({
      urls: [
        'http://localhost:3000/path?key=value',
        'https://127.0.0.1/resource',
        'http://localhost:3000/path?key=value',
      ],
    });
    expect(debugLogger).toHaveBeenCalledWith(
      expect.stringContaining('"urlCount":3'),
    );
  });

  it('does not expose rejected URL values in warnings or errors', () => {
    const sensitiveUrl = 'ftp://user:secret@localhost/file?token=private';

    expectBadRequest(
      validationPipe,
      { urls: [sensitiveUrl] },
      'urls[0] must use http or https',
    );
    const warningOutput = warningLogger.mock.calls.flat().join(' ');
    expect(warningOutput).not.toContain(sensitiveUrl);
    expect(warningOutput).not.toContain('secret');
    expect(warningOutput).not.toContain('private');
  });
});

function expectBadRequest(
  validationPipe: CreateJobValidationPipe,
  payload: unknown,
  expectedMessage: string,
): void {
  try {
    validationPipe.transform(payload);
    throw new Error('Expected validation to reject the payload');
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      error: 'Bad Request',
      message: expectedMessage,
      statusCode: 400,
    });
  }
}
