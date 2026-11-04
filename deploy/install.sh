#!/usr/bin/env bash
# Forkline installer and upgrader. Run as root, on the VPS, from a checkout of the repo:
#
#   sudo bash deploy/install.sh [--host TAILSCALE_IP] [--port 8800]   first install or upgrade
#   sudo bash deploy/install.sh --rollback                            go back to the previous build
#
# Safe to run again. It never overwrites /etc/forkline/forkline.json or forkline.env, and it never
# prints a secret. See deploy/RUNBOOK.md.
set -euo pipefail

SERVICE_USER=forkline
ROOT=/srv/forkline
ETC=/etc/forkline
CONFIG_FILE=$ETC/forkline.json
ENV_FILE=$ETC/forkline.env
UNIT_FILE=/etc/systemd/system/forkline.service
NODE_LINK=/opt/forkline-node
APP=$ROOT/app
STAGE=$ROOT/app.next
PREV=$ROOT/app.prev
DEFAULT_PORT=8800

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST_ARG=""
PORT_ARG=""
ROLLBACK=false
TMP_DIRS=()

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local dir
  for dir in ${TMP_DIRS[@]+"${TMP_DIRS[@]}"}; do rm -rf "$dir"; done
}
trap cleanup EXIT

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) [[ $# -ge 2 ]] || die "--host needs a value"; HOST_ARG="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die "--port needs a value"; PORT_ARG="$2"; shift 2 ;;
    --rollback) ROLLBACK=true; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Same rule as the config loader: loopback or a Tailscale address (100.64.0.0/10).
is_allowed_host() {
  local host="$1" a b c d
  case "$host" in localhost | 127.0.0.1 | ::1) return 0 ;; esac
  if [[ $host =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
    a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=0
    [[ $a -ge 64 && $a -le 127 && $b -le 255 && $c -le 255 && $d -le 255 ]] && return 0
  fi
  return 1
}

as_service() {
  # A clean environment: only what npm and node need, with HOME and the npm cache inside /srv/forkline.
  runuser -u "$SERVICE_USER" -- env -i \
    HOME="$ROOT/home" \
    PATH="$NODE_LINK/bin:/usr/local/bin:/usr/bin:/bin" \
    npm_config_cache="$ROOT/home/.npm" \
    npm_config_update_notifier=false \
    "$@"
}

# Reads one value from the env file without printing it. Prints nothing when unset.
env_value() {
  local name="$1" line
  line="$(grep -m1 "^${name}=" "$ENV_FILE" 2>/dev/null || true)"
  printf '%s' "${line#"${name}="}"
}

preflight() {
  [[ $EUID -eq 0 ]] || die "run as root: sudo bash deploy/install.sh"
  command -v systemctl > /dev/null && [[ -d /run/systemd/system ]] || die "this needs a systemd system"
  if ldd --version 2>&1 | grep -qi musl; then die "this needs a glibc Linux (Debian or Ubuntu), not musl"; fi
  case "$(uname -m)" in
    x86_64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  local file
  for file in package.json package-lock.json .nvmrc tsconfig.json tsconfig.build.json \
    config/forkline.example.json deploy/forkline.service deploy/forkline.env.example; do
    [[ -e $REPO/$file ]] || die "$REPO/$file is missing. Run this from a full checkout of the repo."
  done
  [[ -d $REPO/src ]] || die "$REPO/src is missing"
  NODE_VERSION="$(tr -d 'v \r\n' < "$REPO/.nvmrc")"
  [[ $NODE_VERSION =~ ^22\.[0-9]+\.[0-9]+$ ]] || die ".nvmrc must hold an exact 22.x.y version, found '$NODE_VERSION'"
}

install_packages() {
  local missing=() tool
  for tool in curl xz tar sha256sum runuser; do
    command -v "$tool" > /dev/null || missing+=("$tool")
  done
  [[ -e /etc/ssl/certs/ca-certificates.crt ]] || missing+=(ca-certificates)
  [[ ${#missing[@]} -eq 0 ]] && return 0
  command -v apt-get > /dev/null || die "missing: ${missing[*]}. Install them with your package manager and run again."
  log "installing packages: ca-certificates curl xz-utils util-linux"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl xz-utils util-linux
}

install_node() {
  local dir="/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  if [[ -x $dir/bin/node && "$("$dir/bin/node" --version)" == "v$NODE_VERSION" ]]; then
    log "node v$NODE_VERSION already installed"
  else
    log "downloading node v$NODE_VERSION"
    local tmp base file
    tmp="$(mktemp -d)"; TMP_DIRS+=("$tmp")
    base="https://nodejs.org/dist/v${NODE_VERSION}"
    file="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    curl -fsSL -o "$tmp/$file" "$base/$file"
    curl -fsSL -o "$tmp/SHASUMS256.txt" "$base/SHASUMS256.txt"
    (cd "$tmp" && grep " ${file}\$" SHASUMS256.txt | sha256sum -c -) || die "node download failed its SHA-256 check"
    rm -rf "$dir"
    tar -xJf "$tmp/$file" -C /opt --no-same-owner
    [[ "$("$dir/bin/node" --version)" == "v$NODE_VERSION" ]] || die "installed node is not v$NODE_VERSION"
  fi
  ln -sfn "$dir" "$NODE_LINK"
}

ensure_user_and_dirs() {
  if ! id -u "$SERVICE_USER" > /dev/null 2>&1; then
    log "creating user $SERVICE_USER"
    useradd --system --user-group --home-dir "$ROOT/home" --no-create-home \
      --shell "$(command -v nologin || echo /usr/sbin/nologin)" --comment "Forkline service" "$SERVICE_USER"
  fi
  install -d -o root -g root -m 0755 "$ROOT"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$ROOT/work" "$ROOT/claude-config" "$ROOT/home"
  install -d -o root -g root -m 0755 "$ETC"

  # The Claude Code working directory must be empty and not inside a git folder.
  local dir="$ROOT/work"
  while [[ $dir != / ]]; do
    [[ ! -e $dir/.git ]] || die "$dir is a git folder; Forkline's work directory must not be inside one"
    dir="$(dirname "$dir")"
  done
  if [[ -n "$(ls -A "$ROOT/work")" ]]; then
    warn "$ROOT/work is not empty. Claude Code reads its folder, so empty it: sudo find $ROOT/work -mindepth 1 -delete"
  fi
}

stage_code() {
  log "copying code to $STAGE"
  rm -rf "$STAGE"
  install -d -o root -g root -m 0755 "$STAGE"
  # An allow-list, so private captures, reference repos, secrets and git history never reach the VPS.
  tar -C "$REPO" -cf - src package.json package-lock.json tsconfig.json tsconfig.build.json .nvmrc \
    config/forkline.example.json | tar -C "$STAGE" -xf - --no-same-owner
  {
    printf 'deployed %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if command -v git > /dev/null && git -C "$REPO" rev-parse --short HEAD > /dev/null 2>&1; then
      printf 'commit %s\n' "$(git -C "$REPO" rev-parse --short HEAD)"
      if [[ -n "$(git -C "$REPO" status --porcelain 2> /dev/null)" ]]; then printf 'working tree had uncommitted changes\n'; fi
    fi
  } > "$STAGE/DEPLOYED"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$STAGE"
}

build_code() {
  log "installing dependencies from the lockfile (npm ci)"
  (cd "$STAGE" && as_service npm ci --no-audit --no-fund)
  log "building"
  (cd "$STAGE" && as_service npm run build)
  # Only runtime dependencies stay on the VPS.
  (cd "$STAGE" && as_service npm prune --omit=dev --no-audit --no-fund)
  [[ -f $STAGE/dist/main.js ]] || die "build did not produce dist/main.js"
  [[ -x $STAGE/node_modules/@anthropic-ai/claude-agent-sdk-linux-${NODE_ARCH}/claude ]] \
    || die "the bundled Claude Code binary is missing (claude-agent-sdk-linux-${NODE_ARCH}); npm ci may have skipped optional packages"
}

ensure_config() {
  if [[ -e $CONFIG_FILE ]]; then
    log "keeping existing $CONFIG_FILE"
    [[ -z $HOST_ARG && -z $PORT_ARG ]] || warn "--host and --port are ignored because $CONFIG_FILE exists; edit it by hand"
    return 0
  fi
  local host="$HOST_ARG" port="${PORT_ARG:-$DEFAULT_PORT}"
  if [[ -z $host ]] && command -v tailscale > /dev/null; then
    host="$(tailscale ip -4 2> /dev/null | head -n1 || true)"
  fi
  [[ -n $host ]] || die "cannot find this machine's Tailscale IP. Install and start Tailscale, or pass --host 100.x.y.z"
  is_allowed_host "$host" || die "--host '$host' must be loopback or a Tailscale address (100.64.0.0 to 100.127.255.255)"
  [[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || die "--port must be 1 to 65535"
  log "writing $CONFIG_FILE (listening on $host:$port)"
  "$NODE_LINK/bin/node" -e '
    const fs = require("node:fs");
    const [src, host, port] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(src, "utf8"));
    config.listen = { host, port: Number(port) };
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  ' "$STAGE/config/forkline.example.json" "$host" "$port" > "$CONFIG_FILE.tmp"
  chown root:root "$CONFIG_FILE.tmp"; chmod 0644 "$CONFIG_FILE.tmp"
  mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
}

ensure_env_file() {
  if [[ -e $ENV_FILE ]]; then
    log "keeping existing $ENV_FILE"
    chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
    return 0
  fi
  log "creating $ENV_FILE with a new API key"
  local key
  key="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  (
    umask 077
    sed "s|^FORKLINE_API_KEY=.*|FORKLINE_API_KEY=${key}|" "$REPO/deploy/forkline.env.example" > "$ENV_FILE.tmp"
  )
  chown root:root "$ENV_FILE.tmp"; chmod 0600 "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
}

# Loads the config with the new build's own loader. Node reads the env file itself, so secrets never
# appear on a command line. Prints the loader's message (which never contains secret values) on failure.
CHECK_MESSAGE=""
check_config() {
  local out
  if out="$(FORKLINE_CONFIG=$CONFIG_FILE "$NODE_LINK/bin/node" --env-file="$ENV_FILE" --input-type=module -e '
    const { loadConfig } = await import(process.argv[1]);
    try { loadConfig(); } catch (error) { console.error(error.message); process.exit(1); }
  ' "$STAGE/dist/config.js" 2>&1)"; then
    CHECK_MESSAGE=""
    return 0
  fi
  CHECK_MESSAGE="$out"
  return 1
}

install_unit() {
  install -o root -g root -m 0644 "$REPO/deploy/forkline.service" "$UNIT_FILE"
  systemctl daemon-reload
}

service_url() {
  # shellcheck disable=SC2016 # the ${...} below is JavaScript, not shell
  "$NODE_LINK/bin/node" -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(`http://${c.listen.host}:${c.listen.port}`);
  ' "$CONFIG_FILE"
}

health_check() {
  local url header
  url="$(service_url)"
  header="$(mktemp)"; TMP_DIRS+=("$header")
  chmod 0600 "$header"
  printf 'Authorization: Bearer %s\n' "$(env_value FORKLINE_API_KEY)" > "$header"
  for _ in {1..10}; do
    if curl -fsS --max-time 3 -H "@$header" "$url/health" > /dev/null 2>&1; then
      log "health check passed at $url/health"
      return 0
    fi
    sleep 2
  done
  return 1
}

do_rollback() {
  [[ -d $PREV ]] || die "no previous build at $PREV"
  log "rolling back"
  systemctl stop forkline 2> /dev/null || true
  rm -rf "$STAGE"
  mv "$APP" "$STAGE"
  mv "$PREV" "$APP"
  mv "$STAGE" "$PREV"
  systemctl start forkline
  log "rolled back; the build that was running is kept at $PREV"
}

main() {
  preflight
  if $ROLLBACK; then do_rollback; return 0; fi
  install_packages
  install_node
  ensure_user_and_dirs
  stage_code
  build_code
  ensure_config
  ensure_env_file

  local ready=true was_active=false first_install=true
  [[ -d $APP ]] && first_install=false
  if ! check_config; then
    ready=false
    if ! $first_install || [[ -e $UNIT_FILE ]]; then
      printf '%s\n' "$CHECK_MESSAGE" >&2
      die "the config does not load with the new build. Nothing was changed; the running service is untouched. Fix $CONFIG_FILE or $ENV_FILE and run again."
    fi
  fi

  install_unit
  systemctl is-active --quiet forkline && was_active=true
  $was_active && systemctl stop forkline
  if [[ -d $APP ]]; then
    rm -rf "$PREV"
    mv "$APP" "$PREV"
  fi
  mv "$STAGE" "$APP"
  systemctl enable forkline > /dev/null 2>&1

  if ! $ready; then
    log "installed, but not started yet. The config does not load:"
    printf '%s\n' "$CHECK_MESSAGE" | sed 's/^/    /'
    cat << EOF

Next: put the Claude token into $ENV_FILE (RUNBOOK.md step 5), then run:
    sudo systemctl start forkline
The bundled Claude Code binary for "setup-token" is:
    $APP/node_modules/@anthropic-ai/claude-agent-sdk-linux-${NODE_ARCH}/claude
EOF
    return 0
  fi

  systemctl restart forkline
  if health_check; then
    log "forkline is running. Logs: journalctl -u forkline -f -o cat"
  else
    systemctl --no-pager --lines=15 status forkline || true
    die "the service did not answer /health. Look at: journalctl -u forkline -n 50 -o cat   Go back with: sudo bash deploy/install.sh --rollback"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
