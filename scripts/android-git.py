#!/usr/bin/env python3
"""
Put git, built for Android, into the Android app.

The phone app syncs with real git, because only real git can copy a game
without its artwork (a partial clone with a sparse checkout -- the same trick
the server's copy uses). The Termux project publishes git built for Android;
this fetches that build and the libraries it needs, checks each download
against the hash in Termux's own index, and lays them out so Android will
install them:

  - Android only installs native code named lib*.so, and only lets a program
    run from where it installs them. So git becomes libgit.so and its https
    helper libgitremotehttps.so; the app links them back under git's names.
  - A few libraries are versioned (libssl.so.3). Those names would not be
    packaged, so each is renamed (libssl3.so) and every reference to it is
    rewritten in place -- the new names are shorter, so nothing moves.

Uses only the Python standard library. Run from the repository root:

    python scripts/android-git.py
"""
import hashlib
import io
import lzma
import os
import re
import shutil
import struct
import sys
import tarfile
import urllib.request

REPO = 'https://packages.termux.dev/apt/termux-main/'
ABIS = {'aarch64': 'arm64-v8a', 'x86_64': 'x86_64'}
PACKAGES = ['git', 'libcurl', 'libnghttp2', 'libnghttp3', 'libngtcp2', 'libssh2',
            'openssl', 'zlib', 'libiconv', 'pcre2', 'ca-certificates']
PREFIX = 'data/data/com.termux/files/usr/'

# What goes into the app, and under which name.
FILES = {
    'bin/git': 'libgit.so',
    'libexec/git-core/git-remote-https': 'libgitremotehttps.so',
    'lib/libcurl.so': 'libcurl.so',
    'lib/libnghttp2.so': 'libnghttp2.so',
    'lib/libnghttp3.so': 'libnghttp3.so',
    'lib/libngtcp2.so': 'libngtcp2.so',
    'lib/libngtcp2_crypto_ossl.so': 'libngtcp2_crypto_ossl.so',
    'lib/libssh2.so': 'libssh2.so',
    'lib/libpcre2-8.so': 'libpcre2-8.so',
    'lib/libiconv.so': 'libiconv.so',
    'lib/libz.so.1': 'libz1.so',
    'lib/libssl.so.3': 'libssl3.so',
    'lib/libcrypto.so.3': 'libcrypto3.so',
}
RENAMES = {'libz.so.1': 'libz1.so', 'libssl.so.3': 'libssl3.so', 'libcrypto.so.3': 'libcrypto3.so'}
SYSTEM = {'libc.so', 'libdl.so', 'libm.so', 'liblog.so'}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JNI = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'jniLibs')
ASSETS = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'git')


def fetch(url):
    with urllib.request.urlopen(url) as r:
        return r.read()


def index(arch):
    text = fetch(f'{REPO}dists/stable/main/binary-{arch}/Packages').decode('utf-8')
    found = {}
    for block in text.split('\n\n'):
        fields = dict(re.findall(r'^([A-Za-z0-9-]+): (.*)$', block, re.M))
        if 'Package' in fields:
            found[fields['Package']] = fields
    return found


def ar_members(data):
    if data[:8] != b'!<arch>\n':
        raise ValueError('not a .deb')
    pos = 8
    while pos < len(data):
        name = data[pos:pos + 16].decode().strip().rstrip('/')
        size = int(data[pos + 48:pos + 58].decode().strip())
        yield name, data[pos + 60:pos + 60 + size]
        pos += 60 + size + (size & 1)


def contents(deb):
    """Every file in a .deb, by path, with links followed inside the package."""
    for name, body in ar_members(deb):
        if not name.startswith('data.tar'):
            continue
        if name.endswith('.xz'):
            body = lzma.decompress(body)
        elif name.endswith('.zst'):
            raise SystemExit('A package is zstd-compressed; this script only reads xz.')
        t = tarfile.open(fileobj=io.BytesIO(body))
        members = {m.name.lstrip('./'): m for m in t.getmembers()}
        out = {}
        for path, m in members.items():
            seen = 0
            while m.issym() and seen < 10:
                target = os.path.normpath(os.path.join(os.path.dirname(path), m.linkname)).replace('\\', '/')
                m = members.get(target, m)
                seen += 1
            if m.isfile():
                out[path] = t.extractfile(m).read()
        return out
    return {}


def dynstr(data):
    """Offset and size of the dynamic string table, and the dynamic entries."""
    if data[:4] != b'\x7fELF' or data[4] != 2 or data[5] != 1:
        raise ValueError('not a 64-bit little-endian ELF file')
    shoff, = struct.unpack_from('<Q', data, 0x28)
    shentsize, shnum, _ = struct.unpack_from('<HHH', data, 0x3A)
    sections = [struct.unpack_from('<IIQQQQI', data, shoff + i * shentsize) for i in range(shnum)]
    dyn = next(s for s in sections if s[1] == 6)
    strtab = sections[dyn[6]]
    entries = []
    for off in range(dyn[4], dyn[4] + dyn[5], 16):
        tag, val = struct.unpack_from('<qQ', data, off)
        if tag == 0:
            break
        entries.append((tag, val))
    return strtab[4], strtab[5], entries


def names(data):
    start, _, entries = dynstr(data)
    def at(o):
        return data[start + o:data.index(b'\0', start + o)].decode()
    return [at(v) for t, v in entries if t == 1], next((at(v) for t, v in entries if t == 14), None)


def rename_references(data):
    """Rewrite each versioned library name, in place, where the linker reads it."""
    data = bytearray(data)
    start, size, _ = dynstr(data)
    table = bytes(data[start:start + size])
    for old, new in RENAMES.items():
        assert len(new) < len(old)
        needle = b'\0' + old.encode() + b'\0'
        pos = table.find(needle)
        while pos != -1:
            at = start + pos + 1
            data[at:at + len(old)] = new.encode().ljust(len(old), b'\0')
            pos = table.find(needle, pos + 1)
    return bytes(data)


def main():
    for arch, abi in ABIS.items():
        packages = index(arch)
        tree = {}
        for name in PACKAGES:
            info = packages[name]
            deb = fetch(REPO + info['Filename'])
            if hashlib.sha256(deb).hexdigest() != info['SHA256']:
                raise SystemExit(f'{name} for {arch} does not match its published hash. Nothing was changed.')
            tree.update(contents(deb))
            print(f'{arch}: {name} {info["Version"]}')

        out = os.path.join(JNI, abi)
        shutil.rmtree(out, ignore_errors=True)
        os.makedirs(out)
        shipped = set(FILES.values())
        for source, target in FILES.items():
            data = rename_references(tree[PREFIX + source])
            needed, _ = names(data)
            missing = [n for n in needed if n not in shipped and n not in SYSTEM]
            if missing:
                raise SystemExit(f'{source} needs {missing}, which are not being shipped.')
            with open(os.path.join(out, target), 'wb') as f:
                f.write(data)

        if arch == 'aarch64':
            os.makedirs(ASSETS, exist_ok=True)
            with open(os.path.join(ASSETS, 'cert.pem'), 'wb') as f:
                f.write(tree[PREFIX + 'etc/tls/cert.pem'])

    print('git for Android is in', os.path.relpath(JNI, ROOT))


if __name__ == '__main__':
    sys.exit(main())
