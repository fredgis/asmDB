package main

import "net/http"

// withSecurityHeaders sets the response headers that are safe to apply to every
// route, including the static site.
//
// This origin serves the console, which holds an instance bearer token and
// offers one-click delete and token rotation. Without frame-ancestors an
// attacker could frame those controls and overlay bait, and a signed-in operator
// would destroy or re-key a database believing they clicked something else.
//
// A full Content-Security-Policy belongs here too, but it is deliberately not
// set yet: the console loads MSAL from a CDN and a wrong script-src would break
// sign-in rather than fail visibly. That one wants Report-Only first, so it is
// left out of this change instead of being guessed at.
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Both spellings: X-Frame-Options for older browsers, the CSP directive
		// for current ones. Nothing embeds this origin, so DENY costs nothing.
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", "frame-ancestors 'none'")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
