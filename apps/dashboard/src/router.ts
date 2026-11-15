import { useEffect, useState } from 'react';

export type Route =
  { page: 'overview' } | { page: 'history' } | { page: 'settings' } | { page: 'job'; id: string };

/** Hash routes: #/ · #/history · #/settings · #/jobs/<id>. Unknown routes show the overview. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  if (path === '/history') return { page: 'history' };
  if (path === '/settings') return { page: 'settings' };
  const job = /^\/jobs\/([^/?#]+)$/.exec(path);
  if (job?.[1]) return { page: 'job', id: decodeURIComponent(job[1]) };
  return { page: 'overview' };
}

export const jobHref = (id: string) => `#/jobs/${encodeURIComponent(id)}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
