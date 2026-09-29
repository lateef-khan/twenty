import { shouldReloadSignInForSpiritHub } from '@/auth/utils/shouldReloadSignInForSpiritHub';

describe('shouldReloadSignInForSpiritHub', () => {
  it('reloads a sign-in page reached inside the app', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/welcome',
        search: '',
        documentPathname: '/',
      }),
    ).toBe(true);
  });

  it('reloads after a session is lost on a record page', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/welcome',
        search: '',
        documentPathname: '/objects/people',
      }),
    ).toBe(true);
  });

  it('keeps a sign-in page the server itself served', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/welcome',
        search: '',
        documentPathname: '/welcome',
      }),
    ).toBe(false);
  });

  it('keeps a sign-in page the server served under another spelling', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/welcome',
        search: '',
        documentPathname: '//Welcome/',
      }),
    ).toBe(false);
  });

  it('keeps the local sign-in', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/welcome',
        search: '?local=1',
        documentPathname: '/',
      }),
    ).toBe(false);
  });

  it('keeps an invite page', () => {
    expect(
      shouldReloadSignInForSpiritHub({
        pathname: '/invite/abc',
        search: '',
        documentPathname: '/',
      }),
    ).toBe(false);
  });
});
