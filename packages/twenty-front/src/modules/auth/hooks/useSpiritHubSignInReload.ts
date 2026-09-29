import { shouldReloadSignInForSpiritHub } from '@/auth/utils/shouldReloadSignInForSpiritHub';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const getDocumentPathname = (): string => {
  const [navigation] = performance.getEntriesByType('navigation');

  return navigation !== undefined
    ? new URL(navigation.name).pathname
    : window.location.pathname;
};

export const useSpiritHubSignInReload = () => {
  const { pathname, search } = useLocation();

  useEffect(() => {
    if (
      shouldReloadSignInForSpiritHub({
        pathname,
        search,
        documentPathname: getDocumentPathname(),
      })
    ) {
      window.location.replace(`${pathname}${search}`);
    }
  }, [pathname, search]);
};
