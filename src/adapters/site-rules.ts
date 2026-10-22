/** Optional, local URL aliases only. Generic media discovery never depends on these rules. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

export function isYouTubeHost(hostname: string): boolean {
  return YOUTUBE_HOSTS.has(hostname.toLowerCase());
}

/** No network expansion, guessed mobile aliases, or changes to signed media URLs. */
export function applyVideoSiteRules(input: URL): URL {
  const url = new URL(input.href);
  const host = url.hostname.toLowerCase();
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    url.hostname = 'www.youtube.com';
  } else if (host === 'm.bilibili.com') {
    url.hostname = 'www.bilibili.com';
  } else if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.replace(/^\/+|\/+$/g, '');
    // YouTube IDs are a single URL-safe segment; never decode a path into a new origin.
    if (/^[\w-]+$/.test(id)) {
      url.hostname = 'www.youtube.com';
      url.pathname = '/watch';
      url.searchParams.set('v', id);
    }
  }
  return url;
}
