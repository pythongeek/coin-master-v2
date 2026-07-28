#!/usr/bin/env python3
"""Seed 50 k6test_N users for load testing."""
import json, subprocess, uuid

NUM_USERS = 50
PWD_CHARS = [75, 54, 84, 101, 115, 116, 76, 111, 97, 100, 50, 48, 50, 54, 33]
PASSWORD = ''.join(chr(c) for c in PWD_CHARS)

# Compute bcrypt hash once
r = subprocess.run(['node', '-e',
                    'const b=require("/root/coin-master/backend/node_modules/bcryptjs"); console.log(b.hashSync(process.argv[1], 12));',
                    PASSWORD],
                   capture_output=True, text=True, cwd='/root/coin-master/backend')
hash_str = r.stdout.strip()
print(f'hash: {hash_str[:30]}...{hash_str[-10:]}')

user_ids = [str(uuid.uuid4()) for _ in range(NUM_USERS)]
rows = []
for i, uid in enumerate(user_ids):
    rows.append("('" + uid + "', 'k6test_" + str(i) + "', '" + hash_str + "', 100000, 100000, true, false, 'unverified', 'user')")

sql = "DELETE FROM users WHERE username LIKE 'k6test_%';\n"
sql += "INSERT INTO users (id, username, password_hash, balance, withdrawable_balance_coins, is_active, is_admin, kyc_status, role)\n"
sql += "VALUES\n" + ",\n".join(rows) + ";\n"
sql += "SELECT count(*) AS inserted FROM users WHERE username LIKE 'k6test_%';"

with open('/tmp/seed_k6_bulk.sql', 'w') as f:
    f.write(sql)

r = subprocess.run(['docker', 'exec', '-i', 'coin-master-postgres-1',
                    'psql', '-U', 'cryptoflip', '-d', 'cryptoflip', '-v', 'ON_ERROR_STOP=1'],
                   input=open('/tmp/seed_k6_bulk.sql').read(),
                   capture_output=True, text=True)
print('Seed result:')
print(r.stdout)
if r.returncode != 0:
    print('STDERR:', r.stderr)
    raise SystemExit(1)

with open('/tmp/k6_users.json', 'w') as f:
    json.dump({'k6test_' + str(i): uid for i, uid in enumerate(user_ids)}, f, indent=2)

print(f'Saved {NUM_USERS} user UUIDs to /tmp/k6_users.json')
print('Sample:')
for i in [0, 1, 49]:
    print('  k6test_' + str(i) + ' -> ' + user_ids[i])