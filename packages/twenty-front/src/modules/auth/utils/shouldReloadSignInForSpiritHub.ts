import { AppPath } from 'twenty-shared/types';

// The same spelling rules the server's spirit-hub middleware applies to
// /welcome, so both sides agree on which page is the sign-in page.
const normalizePathname = (pathname: string): string =>
  pathname
    .replace(/\/{2,}/g, '/')
    .replace(/(.)\/$/, '$1')
    .toLowerCase();

// The server sends a full load of /welcome to the Spirit Hub's sign-in when
// the Hub is set up. A sign-in page reached inside the app never asks the
// server, so it takes one full load. When the document itself was a load of
// /welcome, the server already chose to serve it: no Hub, so no reload loop.
export const shouldReloadSignInForSpiritHub = ({
  pathname,
  search,
  documentPathname,
}: {
  pathname: string;
  search: string;
  documentPathname: string;
}): boolean =>
  normalizePathname(pathname) === AppPath.SignInUp &&
  new URLSearchParams(search).get('local') !== '1' &&
  normalizePathname(documentPathname) !== AppPath.SignInUp;
