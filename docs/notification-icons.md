# Notification icons behind an authenticated proxy

Push and hidden-tab notifications referred to the bundled Eye and Android badge
by HTTP URL. Those images could become unavailable during an update, offline,
or when a background fetch could not use the proxy's authentication. The files
still existed on the server, but Chrome could fall back to its generic icon.

Bundle the same PNG bytes as data URLs in the service worker and client. A
notification then carries its own image references without another authenticated
network request. Keep the existing icon artwork and white-on-transparent badge,
and leave application/proxy authentication unchanged.

Run `bun scripts/generate-notification-icons.ts` after changing either source
PNG. The unit check verifies generated consumers remain synchronized. Browser
QA delivers an owned synthetic push to the real worker, captures its platform
notification call, then decodes both images while proxy icon requests return 403.
No notification is sent to a live phone. Android's final OS rendering still needs
the owner to check a subsequent notification after reloading the installed app.
