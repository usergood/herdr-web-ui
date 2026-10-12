# Install Saurons eye on Android

Open the app's **HTTPS address in normal Chrome**, sign in, reload, and choose Chrome's menu → Install app (the wording can also be Add to home screen → Install). A launcher shortcut alone is different from Chrome's installed WebAPK. Open the installed Saurons eye app and enable Alerts; notification permission is requested inside the app, not granted by installation. In Android Settings → Apps, confirm that Saurons eye appears as an installed application and check its notification permission. [Chrome installation help](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid), [WebAPKs and permissions](https://web.dev/articles/webapks)

The bundled eye artwork supplies normal and maskable 192/512 px install icons, an Apple touch icon, favicons, a sharing image and a white-on-transparent Android notification badge. Both server-push and browser-held alerts use the eye assets. The manifest keeps its stable `/` identity. Existing WebAPKs learn name/icon changes on Chrome's update schedule; removing an old launcher shortcut and installing the actual app may be needed to replace that shortcut. Reinstallation is not a reason to clear site data or discard drafts. [WebAPK updates](https://web.dev/articles/webapks#updating_the_webapk), [Stable app identity](https://developer.chrome.com/docs/capabilities/pwa-manifest-id)

## Authenticated Docker proxies

The inspected deployment has Cloudflare Tunnel → Traefik HTTPS/BasicAuth → nginx → a Unix-socket relay → the host's port 7317. Docker and internal HTTP forwarding do not make the browser's HTTPS origin insecure. Traefik applies BasicAuth to the whole hostname, including the web manifest, icons and service worker.

The failure was reproduced twice with an owned BasicAuth proxy and real Chromium: the authenticated page loaded, but Chrome requested its manifest without authorization and received 401. The application had a manifest; the HTML link did not tell Chrome to carry credentials. Adding `crossorigin="use-credentials"` fixed the fetch while retaining the proxy's authentication. The same-origin manifest also needs that attribute when it requires credentials. [Manifest credentials](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest#deploying_a_manifest)

No BasicAuth exemption or Docker/Traefik configuration change is needed for this fix. Keep the manifest, icons, `/sw.js`, API and WebSocket at the same app origin and preserve HTTPS/streaming/WebSocket forwarding. The manifest and worker must be served as their actual files, rather than a login HTML page or the SPA fallback. The manifest MIME type is `application/manifest+json`. Plain HTTP using a LAN IP cannot supply the normal secure-origin install/push behavior. [Chrome install criteria](https://web.dev/articles/install-criteria)

## Verify a deployment

- After authenticating, confirm Chrome's Application → Manifest panel shows Saurons eye, standalone display, and valid normal/maskable icons. Application → Service Workers should show an activated worker for `/`.
- For an anonymous request, the protected deployment may correctly return 401. Check the authenticated browser's manifest request when diagnosing installation; an unauthenticated curl alone does not establish whether the fixed manifest link works.
- Use Settings → Alerts → Test notification → Send test from the installed app, then check a real phone notification's attribution/icon and tap-to-pane behavior. Android/Chrome/OEM presentation is controlled by the browser and OS; an app name or `Notification.icon` alone does not create an Android app identity. [WebAPK identity](https://web.dev/articles/webapks)

The regression uses an isolated normal Chromium profile and temporary application state through a BasicAuth proxy. It checks a credentialed manifest, normal/maskable icon decoding, service-worker activation, zero Chrome installability errors, the Android badge's white/transparent pixels, and a still-protected API. Linux headless notification display did not retain a native notification during a separate debug-push experiment; no Android notification-delivery or OS-attribution claim is made from that experiment.

```sh
bun run check run --build bun scripts/pwa-install-regression.ts
bun scripts/generate-brand.ts
```

The exporter uses the checked-in SVG sources and the project's Chromium dependency; it requires no ffmpeg. It regenerates the complete bundled artwork set. Changing icons requires a new asset query version in the HTML/manifest/client/worker and a new service-worker cache name together.
