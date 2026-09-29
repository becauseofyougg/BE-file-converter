import { prettyTransport } from './logger.module';

describe('prettyTransport', () => {
  it('pretty-prints when pino-pretty is installed', () => {
    expect(prettyTransport(() => '/node_modules/pino-pretty/index.js')).toEqual(
      { target: 'pino-pretty', options: { singleLine: true } },
    );
  });

  /**
   * The images prune dev dependencies but compose runs them as
   * `development`. Asking pino for a missing transport crashed every service
   * at boot — plain JSON is the right answer there.
   */
  it('falls back to plain JSON when it has been pruned', () => {
    expect(
      prettyTransport(() => {
        throw new Error("Cannot find module 'pino-pretty'");
      }),
    ).toBeUndefined();
  });

  it('finds the real one in a development checkout', () => {
    expect(prettyTransport()).toBeDefined();
  });
});
