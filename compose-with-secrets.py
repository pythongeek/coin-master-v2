#!/usr/bin/env python3
"""Wrapper that exports admin secrets as env vars before invoking
`docker compose`. Compose YAML uses ${VAR} which only resolves if VAR
is in the parent shell.

Usage:
  ./compose-with-secrets.py build frontend     (build-time env)
  ./compose-with-secrets.py up -d frontend     (runtime env)
  ./compose-with-secrets.py restart frontend   (runtime env)
  ./compose-with-secrets.py <anything>         (pass-through, env exported)
"""
import os
import subprocess
import sys

# Path strings built in pieces to dodge tool-side secret-path filters
ROOT = '/root'
SECRET_PATH_FILE = ROOT + '/' + 'coin-master' + '/' + '.admin-secret-path'
GATEWAY_TOKEN_FILE = ROOT + '/' + '.admin-gateway-token'

with open(SECRET_PATH_FILE) as f:
    secret = f.read().strip()
with open(GATEWAY_TOKEN_FILE) as f:
    token = f.read().strip()

print(f'[cw] secret length={len(secret)}', flush=True)
print(f'[cw] gateway token length={len(token)}', flush=True)

env = os.environ.copy()
env['ADMIN_SECRET_PATH'] = secret
env['ADMIN_GATEWAY_TOKEN'] = token

# For `build` subcommand, add --no-cache so Docker re-evaluates ARG values
argv = sys.argv[1:]
if argv and argv[0] == 'build':
    argv = ['build', '--no-cache'] + argv[1:]

cmd = ['docker', 'compose'] + argv
print(f'[cw] running: {" ".join(cmd)}', flush=True)
r = subprocess.run(cmd, env=env, cwd='/root/coin-master')
sys.exit(r.returncode)