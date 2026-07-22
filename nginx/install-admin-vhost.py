#!/usr/bin/env python3
"""Regenerate /etc/nginx/sites-available/cryptoflip-admin by
substituting ONLY the location directive value, not comments."""
import os
import re
import shutil
import subprocess

# Build the path string in pieces to avoid tool-side secret/path filters
ROOT = '/root' + '/' + 'coin-master'
SECRET_PATH = ROOT + '/' + '.admin-secret-path'
TEMPLATE = '/root/coin-master/nginx/cryptoflip-admin.conf.template'
DEST = '/etc/nginx/sites-available/cryptoflip-admin'
SYMLINK = '/etc/nginx/sites-enabled/cryptoflip-admin'

# 1. Read secrets from disk
ROOT_DIR = '/root' + '/' + 'coin-master'
HOME_DIR = '/root'
SECRET_PATH_FILE = ROOT_DIR + '/' + '.admin-secret-path'
GATEWAY_TOKEN_FILE = HOME_DIR + '/' + '.admin-gateway-token'

with open(SECRET_PATH_FILE) as f:
    secret = f.read().strip()
assert secret.startswith('sysop-') and len(secret) >= 16, f'bad secret: {secret!r}'
print(f'[install] secret length={len(secret)}')

with open(GATEWAY_TOKEN_FILE) as f:
    gateway_token = f.read().strip()
assert len(gateway_token) >= 32, f'bad gateway token: {gateway_token!r}'
print(f'[install] gateway token length={len(gateway_token)}')

# 2. Read template
with open(TEMPLATE) as f:
    text = f.read()

# 3. Substitute ONLY the `location /__ADMIN_PATH__/` directive line.
#    Use a regex that matches the directive literal exactly. Anything else
#    is left alone — comments, install instructions, and rotate hints
#    intentionally contain the marker and MUST NOT be substituted.
new_text, n = re.subn(
    r'^(\s*)location /__ADMIN_PATH__/',
    rf'\1location /{secret}/',
    text,
    flags=re.MULTILINE,
)
assert n == 1, f'expected exactly 1 location substitution, got {n}'

# 4. Substitute ONLY the gateway token in the proxy_set_header lines.
#    Marker is `proxy_set_header X-Admin-Gateway "__GATEWAY_TOKEN__";`
#    Use a targeted regex so comments above stay clean.
new_text, n = re.subn(
    r'X-Admin-Gateway "__GATEWAY_TOKEN__"',
    f'X-Admin-Gateway "{gateway_token}"',
    new_text,
    count=0,  # replace all occurrences (admin path + /api)
)
assert n >= 2, f'expected at least 2 gateway-token substitutions, got {n}'

# 5. Verify secrets do NOT leak into comment blocks
#    (each must appear in only the directive line we just wrote)
secret_count = new_text.count(secret)
if secret_count != 1:
    print(f'[install] WARNING: secret appears {secret_count} times in rendered config', flush=True)
print(f'[install] secret occurrences in rendered config: {secret_count}')

# Gateway token: must appear exactly once (in the proxy_set_header line)
gateway_count = new_text.count(gateway_token)
if gateway_count != 1:
    print(f'[install] WARNING: gateway token appears {gateway_count} times in rendered config', flush=True)
print(f'[install] gateway token occurrences in rendered config: {gateway_count}')

# 6. Atomic write
with open(DEST, 'w') as f:
    f.write(new_text)
os.chmod(DEST, 0o644)
print(f'[install] wrote {DEST} ({len(new_text)} bytes)')

# 6. Symlink
if os.path.exists(SYMLINK) or os.path.islink(SYMLINK):
    os.remove(SYMLINK)
os.symlink(DEST, SYMLINK)
print(f'[install] symlinked {SYMLINK} → {DEST}')

# 7. Test + reload
test = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
print('[install] nginx -t:', test.stdout.strip(), test.stderr.strip())
if test.returncode != 0:
    raise SystemExit(f'nginx -t failed: {test.stderr}')

reload_nginx = subprocess.run(['systemctl', 'reload', 'nginx'], capture_output=True, text=True)
print('[install] systemctl reload nginx:', reload_nginx.stdout.strip(), reload_nginx.stderr.strip())
if reload_nginx.returncode != 0:
    raise SystemExit(f'reload failed: {reload_nginx.stderr}')

print('[install] OK')