// Vercel Routing Middleware — HTTP Basic Auth in front of the whole site
// (static files and /api/* alike). Native Password Protection is a paid
// add-on; this is the free equivalent. The password lives in the
// SITE_PASSWORD env var; any username is accepted. Returning nothing
// lets the request continue to the origin.

export default function middleware(request) {
  const password = process.env.SITE_PASSWORD;
  if (!password) return; // unset → site stays open (local dev, misconfig)

  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Basic ')) {
    const decoded = atob(auth.slice(6));
    const supplied = decoded.slice(decoded.indexOf(':') + 1);
    if (supplied === password) return;
  }

  return new Response('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SVG Animation Tool"' },
  });
}
