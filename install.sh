#!/bin/sh
# herdr web ui in one line, from a PC that may have none of it yet:
#
#   HERDR_WEB_UI_REF=<reviewed commit or tag> sh ./install.sh
#
# 1. Installs what is missing, for this user only and without sudo: checksum-pinned herdr into
#    ~/.local/bin, Bun into ~/.bun and Node 22 (the official build, checked
#    against its published SHA-256, into ~/.local/share/saurons-eye/node).
# 2. Installs herdr web ui as a herdr plugin, so it starts with herdr and Settings → Updates keeps it
#    current, and starts it now when herdr is running.
# 3. When Tailscale runs on this PC, serves the app to your tailnet (`tailscale serve`, on the first
#    free HTTPS port) and prints the address a phone opens as a QR code (scripts/plugin.ts phone).
# Run it again at any time: what is already there is kept, and step 3 is repeated.
#   HERDR_WEB_UI_REF=<branch or tag>   required reviewed commit or tag to install
set -eu

REPO="usergood/saurons-eye"
PLUGIN="usergood.saurons-eye"
BIN_DIR="$HOME/.local/bin"
NODE_DIR="$HOME/.local/share/saurons-eye/node"
# Official digests from nodejs.org/dist/v22.23.2/SHASUMS256.txt, as scripts/build-remote-bundle.ts pins them
NODE_VERSION="v22.23.2"

say() { printf '%s\n' "herdr web ui: $*"; }
# a clickable address in a terminal (OSC 8); $terminal is set once, since $(link …) runs in a pipe
# shellcheck disable=SC1003 # the backslashes end OSC 8 escapes (ESC \\), no quote is escaped
link() { if [ "$terminal" = 1 ]; then printf '\033]8;;%s\033\\%s\033]8;;\033\\' "$1" "$1"; else printf '%s' "$1"; fi; }
fail() { printf '%s\n' "herdr web ui: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "needs '$1', which is not installed. Install it and run this again."; }
# at_least 1.4.0 1.10.2: is the second dotted version the first or newer
at_least() {
  awk -v want="$1" -v have="$2" 'BEGIN { split(want, w, "."); split(have, h, ".");
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > w[i] + 0) exit 0; if (h[i] + 0 < w[i] + 0) exit 1 } exit 0 }'
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{ print $1 }'; }

fetch_pinned() {
  curl -fsSL --retry 3 --connect-timeout 10 --max-time 120 "$1" -o "$3"
  [ "$(sha256 "$3")" = "$2" ] || fail "prerequisite checksum mismatch; nothing from this download was executed"
}

install_herdr() {
  case "$platform" in
    linux-x64) herdr_asset=herdr-linux-x86_64; herdr_sha=18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7 ;;
    linux-arm64) herdr_asset=herdr-linux-aarch64; herdr_sha=4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0 ;;
    darwin-x64) herdr_asset=herdr-macos-x86_64; herdr_sha=db62d548ff3e832b087a96b1894a08d26be3905f1830309cd556783f215d4054 ;;
    darwin-arm64) herdr_asset=herdr-macos-aarch64; herdr_sha=5173a3e0ae42d5d1ab7ebfa5d5e6329f7c3d23f8e1a3677c7ce3231da2884157 ;;
    *) fail "unsupported prerequisite platform" ;;
  esac
  herdr_scratch=$(mktemp -d)
  trap 'rm -rf "$herdr_scratch"' EXIT INT TERM
  fetch_pinned "https://github.com/herdrdev/herdr/releases/download/v0.9.3/$herdr_asset" "$herdr_sha" "$herdr_scratch/herdr"
  chmod 755 "$herdr_scratch/herdr"
  mkdir -p "$BIN_DIR"
  mv "$herdr_scratch/herdr" "$BIN_DIR/herdr"
  rm -rf "$herdr_scratch"
}

install_bun() {
  need unzip
  case "$platform" in
    linux-x64) bun_asset=bun-linux-x64-baseline; bun_sha=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
    linux-arm64) bun_asset=bun-linux-aarch64; bun_sha=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
    darwin-x64) bun_asset=bun-darwin-x64-baseline; bun_sha=bad5bbd6cf14d0980d115f5954c9ff904df619d5e994d2da1ffccd3f316300b0 ;;
    darwin-arm64) bun_asset=bun-darwin-aarch64; bun_sha=90987a3a16d7db556d886ac3d551e7b6d3edf0a1cf43acaed622e8676be1d12f ;;
    *) fail "unsupported prerequisite platform" ;;
  esac
  bun_scratch=$(mktemp -d)
  trap 'rm -rf "$bun_scratch"' EXIT INT TERM
  fetch_pinned "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/$bun_asset.zip" "$bun_sha" "$bun_scratch/bun.zip"
  unzip -q "$bun_scratch/bun.zip" -d "$bun_scratch"
  chmod 755 "$bun_scratch/$bun_asset/bun"
  mkdir -p "$HOME/.bun/bin" "$BIN_DIR"
  mv "$bun_scratch/$bun_asset/bun" "$HOME/.bun/bin/bun"
  [ -e "$BIN_DIR/bun" ] || ln -s "$HOME/.bun/bin/bun" "$BIN_DIR/bun"
  PATH="$HOME/.bun/bin:$PATH"; export PATH
  rm -rf "$bun_scratch"
}

# After a first install, on a PC with a desktop: opens the app in the browser, which is where its
# Install button is. Over SSH, or with no desktop, it says how to reach the app instead of opening
# one nobody sees. Nothing here can fail the install, and nothing reads stdin.
open_app() {
  [ "$new_install" = 1 ] || return 0
  origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
  [ -n "$origin" ] || return 0
  hostport=${origin#*://}
  hostport=${hostport%%/*}
  host=${hostport%:*}
  case "$hostport" in *:*) port=${hostport##*:} ;; *) port=80 ;; esac
  loopback=0
  case "$host" in 127.0.0.1 | localhost) loopback=1 ;; esac
  opener=""
  if [ -z "${CI:-}" ] && [ -z "${HERDR_WEB_NO_OPEN:-}" ] && [ -z "${SSH_CONNECTION:-}" ] && [ -z "${SSH_TTY:-}" ] && [ "$loopback" = 1 ]; then
    if [ "$os" = darwin ]; then
      ! command -v open >/dev/null 2>&1 || opener=open
    elif [ -n "${BROWSER:-}" ] && command -v "$BROWSER" >/dev/null 2>&1; then
      opener=$BROWSER
    elif command -v xdg-open >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; then
      opener=xdg-open
    fi
  fi
  echo
  if [ -n "$opener" ]; then
    "$opener" "$origin" </dev/null >/dev/null 2>&1 &
    say "opened $origin in your browser: click Install in the address bar to add the app"
  elif [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ]; then
    say "from your own PC, tunnel to this one and open the app there: ssh -L $port:127.0.0.1:$port <this-pc>"
    say "the phone address above also opens it"
  elif [ "$loopback" = 1 ]; then
    say "open $origin in your browser and click Install in the address bar to add the app"
  else
    say "open $origin in your browser"
  fi
}

install_node() {
  case "$platform" in
    linux-x64) node_sha=b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a ;;
    linux-arm64) node_sha=013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30 ;;
    darwin-x64) node_sha=58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026 ;;
    darwin-arm64) node_sha=61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6 ;;
  esac
  say "installing Node $NODE_VERSION into $NODE_DIR"
  tmp=$(mktemp -d)
  archive="$tmp/node.tar.gz"
  curl -fsSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$platform.tar.gz" -o "$archive"
  [ "$(sha256 "$archive")" = "$node_sha" ] || { rm -rf "$tmp"; fail "the Node download does not match its published SHA-256; nothing was installed"; }
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR" "$BIN_DIR"
  tar -xzf "$archive" -C "$NODE_DIR" --strip-components=1
  rm -rf "$tmp"
  # an older node elsewhere on the PATH would still win in a new shell, so this one goes first in ours
  [ -e "$BIN_DIR/node" ] || ln -s "$NODE_DIR/bin/node" "$BIN_DIR/node"
  installed_here="$installed_here node"
}

# herdr's checkout stays at the version first installed: Settings → Updates builds each newer release
# in the app's state dir and runs it from there (server/updater.ts, current.json). The directory of the
# code that runs now, so the phone step is the running version's, not the first install's.
running_code() {
  state="${HERDR_WEB_STATE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-web-ui}"
  head=$(git -C "$1" rev-parse HEAD 2>/dev/null || true)
  # shellcheck disable=SC2016 # JavaScript, not shell
  bun -e '
    const [root, state, head] = process.argv.slice(1);
    const { readdirSync, readFileSync } = await import("node:fs");
    let found = root;
    try {
      for (const name of readdirSync(`${state}/updates`)) {
        try {
          const saved = JSON.parse(readFileSync(`${state}/updates/${name}/current.json`, "utf8"));
          if (saved.source_revision === head && String(saved.directory).startsWith(`${state}/updates/${name}/release-`)) found = saved.directory;
        } catch {}
      }
    } catch {}
    console.log(found);
  ' "$1" "$state" "$head"
}

main() {
  [ -n "${HERDR_WEB_UI_REF:-}" ] || fail "set HERDR_WEB_UI_REF to the reviewed Saurons eye commit or tag before installing."
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) fail "runs on Linux and macOS; this is $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "runs on x64 and arm64; this is $(uname -m)" ;;
  esac
  platform="$os-$arch"
  terminal=0
  [ ! -t 1 ] || terminal=1
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
    fail "the terminal addon has no build for musl (Alpine); use a glibc distribution"
  fi
  need curl
  need git
  need tar

  original_path="$PATH"
  installed_here=""
  PATH="$BIN_DIR:$HOME/.bun/bin:$NODE_DIR/bin:$PATH"
  export PATH

  if ! command -v herdr >/dev/null 2>&1; then
    say "installing herdr (https://herdr.dev) into $BIN_DIR"
    install_herdr
    command -v herdr >/dev/null 2>&1 || fail "herdr did not install; see https://herdr.dev/docs/install/"
    installed_here="$installed_here herdr"
  fi
  herdr_version=$(herdr --version 2>/dev/null | awk '{ print $2 }')
  at_least 0.9.0 "${herdr_version:-0}" \
    || fail "needs herdr 0.9.0 or newer; this is ${herdr_version:-unknown}. Update it (https://herdr.dev/docs/install/), restart herdr, and run this again."

  if command -v bun >/dev/null 2>&1; then
    bun_version=$(bun --version)
    if ! at_least 1.4.0 "$bun_version"; then
      say "updating Bun $bun_version to pinned 1.4.2"
      install_bun
    fi
  else
    need unzip
    say "installing Bun (https://bun.sh) into ~/.bun"
    install_bun
    command -v bun >/dev/null 2>&1 || fail "Bun did not install; see https://bun.sh"
    # Bun's installer adds ~/.bun/bin to a shell's rc file only when it can tell which shell, and
    # herdr runs the app with the PATH it was started with: next to herdr, it is found either way
    mkdir -p "$BIN_DIR"
    [ -e "$BIN_DIR/bun" ] || ln -s "$HOME/.bun/bin/bun" "$BIN_DIR/bun"
    installed_here="$installed_here bun"
  fi

  node_major=$(node --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\).*/\1/p')
  [ "${node_major:-0}" -ge 18 ] || install_node

  new_install=0
  if herdr plugin list 2>/dev/null | grep -q "$PLUGIN "; then
    say "already installed as a herdr plugin; Settings → Updates keeps it current"
  else
    need git
    ref=${HERDR_WEB_UI_REF:-}
    [ -n "$ref" ] || fail "set HERDR_WEB_UI_REF to the reviewed Saurons eye commit or tag to install."
    say "installing the herdr plugin at $ref (herdr clones and builds it: about a minute)"
    # herdr previews the whole manifest first; on success its last word is enough, on failure all of it
    log=$(mktemp)
    if herdr plugin install "$REPO" --ref "$ref" --yes </dev/null >"$log" 2>&1; then
      new_install=1
      grep '^Installed ' "$log" || true
      rm -f "$log"
    else
      cat "$log" >&2
      rm -f "$log"
      fail "herdr could not install the plugin; its output is above"
    fi
  fi

  root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "'"$PLUGIN"'")?.plugin_root ?? "")')
  [ -n "$root" ] || fail "herdr does not list the plugin after installing it; see: herdr plugin list"

  if herdr status server --json 2>/dev/null | grep -q '"running":true'; then
    # the action only queues the start (its output goes to herdr's plugin log), so wait for it here
    herdr plugin action invoke "$PLUGIN.start" >/dev/null </dev/null
    tries=0
    until bun "$root/scripts/plugin.ts" status </dev/null | grep -q '^running'; do
      tries=$((tries + 1))
      [ "$tries" -lt 25 ] || {
        say "did not start within 25 s; see: herdr plugin log list"
        # the start ran inside herdr, so what it said is in herdr's plugin log, not on this terminal
        # shellcheck disable=SC2016 # JavaScript, not shell
        herdr plugin log list 2>/dev/null </dev/null | bun -e 'const logs = JSON.parse(await Bun.stdin.text()).result.logs.filter((log) => log.plugin_id === process.argv[1] && log.stderr); if (logs.length > 0) console.error(logs.at(-1).stderr.trim())' "$PLUGIN" || true
        break
      }
      sleep 1
    done
  else
    say "herdr is not running, so neither is the app yet: it starts with herdr. Run: herdr"
  fi

  echo
  code=$(running_code "$root")
  if grep -q '"phone"' "$code/scripts/plugin.ts" 2>/dev/null; then
    bun "$code/scripts/plugin.ts" phone </dev/null || true
  else
    # a release from before the phone step: the address the running app already knows, as a QR code
    origin=$(bun "$root/scripts/plugin.ts" status </dev/null | awk '$1 == "running" { print $2 }')
    url=""
    [ -z "$origin" ] || url=$(curl -fsS --max-time 5 "$origin/api/access" 2>/dev/null | bun -e 'try { console.log(JSON.parse(await Bun.stdin.text()).tailscale?.serving_url ?? "") } catch { console.log("") }')
    [ -z "$origin" ] || say "on this PC: $(link "$origin")"
    if [ -n "$url" ]; then
      say "on your phone: $(link "$url")"
      # the app's own QR library, there since 0.3.11 for Settings → Phone
      if [ -d "$code/node_modules/qrcode-generator" ]; then
        # shellcheck disable=SC2016 # JavaScript, not shell
        (cd "$code" && bun -e 'const { default: qr } = await import("qrcode-generator"); const c = qr(0, "M"); c.addData(process.argv[1]); c.make(); console.log(c.createASCII(1, 1))' "$url") || true
      fi
    else
      say "no phone address yet, and this version cannot set one up: update it in Settings → Updates, then run this again"
    fi
  fi

  open_app

  case ":$original_path:" in
    *":$BIN_DIR:"*) ;;
    *)
      if [ -z "$installed_here" ]; then
        :
      elif grep -qs '\.local/bin' "$HOME/.profile" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.zprofile" "$HOME/.zshrc"; then
        echo
        say "installed$installed_here into $BIN_DIR. Open a new terminal before running herdr, so it finds them."
      else
        echo
        say "installed$installed_here into $BIN_DIR, which your shell does not put on its PATH. Add it, for example:"
        # shellcheck disable=SC2016 # the line to paste, $HOME and $PATH unexpanded
        printf '    echo '\''export PATH="$HOME/.local/bin:$PATH"'\'' >> ~/.profile\n'
        say "and start herdr from a new terminal, so it and the app find them."
      fi
      ;;
  esac


}

# the whole script is read before anything runs: under `curl | sh`, a command that reads stdin
# must not swallow the rest of it
main "$@"
