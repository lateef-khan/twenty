import { type Request, type Response } from 'express';

import { spiritHubMiddleware } from 'src/engine/core-modules/spirit-hub/spirit-hub.middleware';

const HUB_ORIGIN = 'http://hub.spirit.localhost:5299';
const HUB_LOGIN_URL =
  'http://hub.spirit.localhost:5299/chat/login.html?app=crm';

type RecordedResponse = {
  headers: Record<string, string>;
  redirectedTo?: string;
  status?: number;
  body?: string;
};

const buildResponse = () => {
  const recorded: RecordedResponse = { headers: {} };
  const response = {
    recorded,
    setHeader: (name: string, value: string) => {
      recorded.headers[name.toLowerCase()] = value;
    },
    redirect: (status: number, url: string) => {
      recorded.status = status;
      recorded.redirectedTo = url;
    },
    type: (): unknown => response,
    send: (body: string) => {
      recorded.body = body;
    },
  };

  return response;
};

const run = (path: string, query: Record<string, string> = {}) => {
  const response = buildResponse();
  const next = jest.fn();

  spiritHubMiddleware(
    { method: 'GET', path, query } as unknown as Request,
    response as unknown as Response,
    next,
  );

  return { response: response.recorded, next };
};

describe('spiritHubMiddleware', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.SPIRIT_HUB_ORIGIN = HUB_ORIGIN;
    process.env.SPIRIT_HUB_LOGIN_URL = HUB_LOGIN_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('lets the hub frame a front-end page', () => {
    const { response, next } = run('/objects/people');

    expect(response.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' http://hub.spirit.localhost:5299",
    );
    expect(next).toHaveBeenCalled();
  });

  it('leaves API responses to the API', () => {
    const { response, next } = run('/graphql');

    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('sends the sign-in page to the hub sign-in', () => {
    const { response, next } = run('/welcome');

    expect(response.status).toBe(302);
    expect(response.redirectedTo).toBe(HUB_LOGIN_URL);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['//welcome', '/welcome/', '/Welcome'])(
    'sends %s to the hub sign-in too',
    (path) => {
      expect(run(path).response.redirectedTo).toBe(HUB_LOGIN_URL);
    },
  );

  it('shows Twenty sign-in with local=1', () => {
    const { response, next } = run('/welcome', { local: '1' });

    expect(response.redirectedTo).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('serves a sign-out page that tells the hub', () => {
    const { response, next } = run('/spirit/sign-out');

    expect(response.body).toContain('mutation SignOut { signOut }');
    expect(response.body).toContain(
      "window.parent.postMessage({ type: 'hub:signed-out', app: 'crm' }, hub)",
    );
    expect(response.body).toContain(`const hub = "${HUB_ORIGIN}";`);
    expect(response.headers['content-security-policy']).toBe(
      "frame-ancestors 'self' http://hub.spirit.localhost:5299",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps an origin inside the sign-out script', () => {
    process.env.SPIRIT_HUB_ORIGIN = 'http://hub.test</script><script>alert(1)';

    const { response } = run('/spirit/sign-out');

    expect(response.body).not.toContain('</script><script>alert(1)');
    expect(response.body).toContain(
      'const hub = "http://hub.test\\u003c/script>\\u003cscript>alert(1)";',
    );
  });
});
