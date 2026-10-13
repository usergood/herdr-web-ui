// BEGIN BUNDLED_NOTIFICATION_ICONS
const NOTIFICATION_ICON = "data:image/png;base64,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";
const NOTIFICATION_BADGE = "data:image/png;base64,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";
// END BUNDLED_NOTIFICATION_ICONS

// Service worker for Saurons eye. Policy: navigations are network-first (so a
// fresh build always wins when online) falling back to the cached shell when
// offline; static assets (hashed bundles, icons, favicons) are cache-first since
// they are content-addressed or rarely change. The web manifest is not: its URL
// never changes and the browser rereads it to update the installed app, so a
// cached copy would pin every install to its first manifest. API and websocket
// traffic is never intercepted so live workspace data is always fresh.
// Nothing is precached. The typefaces are /assets/ files too (src/fonts/fonts.css): Pretendard
// comes as 92 chunks split by unicode-range and the browser asks only for those whose characters
// a page draws, so each is cached as it is first fetched and a phone that has shown Korean once
// draws it offline. Never list them for install: that would download all 3 MB on every device.
// A new CACHE_NAME starts empty for the same reason, so the cache of the name before it is kept
// until this one holds a shell: the page that brought this worker was loaded through the old
// one, and its shell, bundles and font chunks are all there. Deleted at activation, the first
// reload without a network would find no shell at all. Nothing is copied across, so no hashed
// file of an old build outlives the first navigation that reaches the server.
const CACHE_NAME = "saurons-eye-v2";

const CACHE_FIRST_PATHS = new Set([
  "/favicon.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
]);

function isCacheFirst(pathname) {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) return true;
  return CACHE_FIRST_PATHS.has(pathname);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // no cache is deleted here: see CACHE_NAME
  event.waitUntil(self.clients.claim());
});

/** The shell just fetched is this cache's "/", and only then do the caches of other names go. */
async function keepShell(response) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put("/", response);
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
}

/** The shell to start from offline: this cache's, else the one a cache not yet deleted holds. */
async function cachedShell() {
  const cache = await caches.open(CACHE_NAME);
  return (await cache.match("/")) || (await caches.match("/"));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        let response;
        try {
          response = await fetch(request);
        } catch (err) {
          return (await cachedShell()) || Response.error();
        }
        if (response.ok) {
          // not awaited: the page gets its shell as it comes, and the worker lives until the
          // copy is kept (a put reads the whole body). A bundle asked for meanwhile may still
          // be answered by the old cache: a hashed file is the same file in either, and only
          // what the network gave is put in this one. A cache that cannot be written does not
          // cost the page.
          event.waitUntil(keepShell(response.clone()).catch(() => undefined));
        }
        return response;
      })(),
    );
    return;
  }

  if (isCacheFirst(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE_NAME);
        const own = await cache.match(request);
        if (own) return own;
        const older = await caches.match(request);
        if (older) {
          // a file only the cache of the name before still holds, asked for while the new shell's
          // copy is being kept: it is kept here too, so keepShell's retirement of that cache does
          // not take the only copy of a file the new shell uses
          event.waitUntil(cache.put(request, older.clone()).catch(() => undefined));
          return older;
        }
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

// Web push (server/push.ts sends, shared/protocol.ts PushPayload is the JSON). Every
// push shows a notification: Safari revokes a subscription whose pushes stay silent.
// A window of the app that is visible right now already shows the change in its
// sidebar, so the notification then arrives without sound or vibration.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((client) => client.visibilityState === "visible");
      await self.registration.showNotification(payload.title || "Saurons eye", {
        body: payload.body || "",
        tag: payload.tag || "herdr",
        renotify: !watching,
        silent: watching,
        data: { pane_id: payload.pane_id || null, machine_id: payload.machine_id || "local" },
        icon: NOTIFICATION_ICON,
        // Android's status bar and small icon: white on transparent, or Chrome's bell
        badge: NOTIFICATION_BADGE,
      });
    })(),
  );
});

// Tap: bring the app forward on that pane - an open window is told which pane
// (App listens), a closed app opens on /?pane=<id>.
let latestNotificationClick = 0;
let latestNotificationSelection = null;
self.addEventListener("notificationclick", (event) => {
  const click = ++latestNotificationClick;
  event.notification.close();
  const paneId = event.notification.data ? event.notification.data.pane_id : null;
  const machineId = event.notification.data?.machine_id || "local";
  // Remember the intent before any lookup: an older focus can finish while this one
  // is still finding its window.
  latestNotificationSelection = paneId ? { type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat" } : null;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (click !== latestNotificationClick) return;
      const url = paneId ? `/?machine=${encodeURIComponent(machineId)}&pane=${encodeURIComponent(paneId)}&view=chat` : "/";
      const selectLatest = (client) => { if (client && latestNotificationSelection) client.postMessage(latestNotificationSelection); };
      const open = async () => {
        // An opening can also finish after a newer tap. Repair that returned
        // window, while its URL still selects the original pane on a cold start.
        selectLatest(await self.clients.openWindow(url));
      };
      const target = windows.find((client) => client.focused) || windows[0];
      if (target) {
        const select = () => { if (paneId) target.postMessage({ type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat" }); };
        // Name the pane before focus(): a focus() that iOS refuses or resolves late must not
        // swallow it. A page frozen in the background may need the selection again
        // once its focus completes.
        select();
        try {
          await target.focus();
        } catch (err) {
          // that window cannot be brought forward: open the app on the pane instead
          if (click === latestNotificationClick) await open();
          return;
        }
        // Different windows finish focus independently. A late older focus can put
        // its window in front after a newer tap focused another one. Give whichever
        // window just came forward the latest selection, without another focus loop.
        selectLatest(target);
        return;
      }
      await open();
    })(),
  );
});

// The browser rotated the subscription (Firefox does; Chrome rarely): hand the server
// the new endpoint and drop the old one, or pushes stop until the app is next opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  const post = (method, body) =>
    fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let fresh = event.newSubscription;
      if (!fresh) {
        const key = previous && previous.options.applicationServerKey
          ? previous.options.applicationServerKey
          : (await (await fetch("/api/push")).json()).public_key;
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await post("POST", { subscription: fresh.toJSON() });
      if (previous) await post("DELETE", { endpoint: previous.endpoint });
    })(),
  );
});
