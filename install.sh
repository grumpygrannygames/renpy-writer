#!/bin/sh
# Set up Ren'Py Writer on macOS or Linux.
#
# Written for somebody who has never opened a terminal. It asks for nothing,
# installs nothing system-wide, needs no administrator rights, and puts
# everything it downloads inside this folder. Deleting the folder removes it.
set -eu

root=$(cd "$(dirname "$0")" && pwd)
cd "$root"

say() { printf '  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }
fail() {
  printf '\nSetup stopped: %s\n\n' "$1" >&2
  printf 'Nothing was installed outside this folder.\n' >&2
  exit 1
}

printf "\nRen'Py Writer setup\n"
printf 'This takes a few minutes and needs an internet connection.\n'

command -v curl >/dev/null 2>&1 || fail "This needs a program called curl, which is not on this machine."
command -v tar >/dev/null 2>&1 || fail "This needs a program called tar, which is not on this machine."

# --------------------------------------------------------------- node
# Ren'Py Writer runs on a program called Node. Rather than install it on the
# machine, a copy is kept here and used only by this app.
node_dir="$root/.node"

if [ -x "$node_dir/bin/node" ]; then
  step 'Checking what is already here'
  say 'Found the copy from last time.'
else
  step "Downloading the parts Ren'Py Writer needs"
  say 'This is about 40 MB and goes into a folder called .node here.'

  version=$(curl -fsSL --max-time 60 https://nodejs.org/dist/index.json |
    tr '}' '\n' | grep '"lts":"' | grep -o '"version":"v22\.[0-9.]*"' |
    head -1 | cut -d'"' -f4) || fail 'Could not reach nodejs.org. Check your internet connection.'
  [ -n "${version:-}" ] || fail 'Could not work out which version to download.'

  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "This script does not know how to set up $(uname -s). Windows users: run install.cmd." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail "This script does not know how to set up $(uname -m)." ;;
  esac

  name="node-$version-$os-$arch"
  archive="${TMPDIR:-/tmp}/$name.tar.gz"
  say "Version $version"
  curl -fsSL --max-time 600 "https://nodejs.org/dist/$version/$name.tar.gz" -o "$archive" ||
    fail 'The download did not finish. Check your internet connection and try again.'

  # Checked against the list nodejs.org publishes, so a partial or altered
  # download is caught here rather than becoming a puzzling failure later.
  step 'Checking the download is intact'
  sums=$(curl -fsSL --max-time 60 "https://nodejs.org/dist/$version/SHASUMS256.txt") ||
    fail 'Could not fetch the checksum list from nodejs.org.'
  expected=$(printf '%s\n' "$sums" | grep " $name.tar.gz\$" | cut -d' ' -f1)
  if command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$archive" | cut -d' ' -f1)
  else
    actual=$(sha256sum "$archive" | cut -d' ' -f1)
  fi
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "$archive"
    fail 'The download did not match its checksum, so it was deleted. Try again.'
  fi
  say 'Good.'

  step 'Unpacking'
  staging="${TMPDIR:-/tmp}/renpywriter-node-$$"
  mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging"
  mv "$staging/$name" "$node_dir"
  rm -rf "$archive" "$staging"
fi

PATH="$node_dir/bin:$PATH"
export PATH

# --------------------------------------------------------------- app
step "Installing Ren'Py Writer"
say 'This is the long part. A few minutes is normal.'
npm install --no-audit --no-fund || fail 'Installing did not finish. Running setup again is safe.'

step 'Building'
npm run build || fail 'The build did not finish. Running setup again is safe.'

# --------------------------------------------------------------- launcher
step 'Making a shortcut'
launcher="$root/start-renpy-writer.sh"
cat > "$launcher" <<'LAUNCHER'
#!/bin/sh
# Starts Ren'Py Writer. Made by setup; safe to delete and remake.
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
PATH="$here/.node/bin:$PATH"
export PATH
exec npm start
LAUNCHER
chmod +x "$launcher"
say 'Made start-renpy-writer.sh in this folder.'

printf '\nDone.\n\n'
printf "  Open Ren'Py Writer by double-clicking start-renpy-writer.sh in this\n"
printf '  folder, or by running ./start-renpy-writer.sh\n\n'
