# KMS Migration Guide — Hot Wallet Key Custody

**Audit ref:** `PROD_AUDIT_2026-08-07.md` → W6, C6, ACCESS-2
**Severity:** CRITICAL (compliance gate)
**Status:** Guard implemented in S1-W6-KMS; full migration pending

---

## The problem

The hot-wallet private key is currently stored as
`HOT_WALLET_PRIVATE_KEY_ENCRYPTED` in a single env var. The encryption
is AES-256-GCM with a single `ENCRYPTION_KEY` env var. If either
leaks, the attacker can decrypt the hot-wallet key and drain the
wallet in one round trip.

The S1-W6-KMS guard makes this deployment-fatal in production:

```
FATAL: Production deployment requires KMS_PROVIDER to be set to
aws-kms | fireblocks | hashicorp-vault.
```

The bypass flag is `ALLOW_INSECURE_HOT_WALLET=true`. It exists ONLY
for pre-beta testing with zero real funds. It logs a loud warning
on every payout attempt.

---

## Option A: AWS KMS (recommended for self-hosted)

1. **Create a KMS Customer Managed Key** in AWS.
   - Key spec: SYMMETRIC_DEFAULT, key usage ENCRYPT_DECRYPT
   - Key policy: grant `kms:Decrypt` to the Hetzner instance's IAM role

2. **Re-encrypt `HOT_WALLET_PRIVATE_KEY_ENCRYPTED`** with the KMS key:
   - The encrypted blob is stored in AWS Secrets Manager (not .env)
   - Decryption happens via `KMS.decrypt()` in `services/secret-vault.ts`
   - Plaintext key is held in a NodeJS `Buffer` only for the duration
     of one payout, then `.fill(0)` scrubs it (P1-09)

3. **IAM setup**:
   - EC2 instance profile OR explicit access key
   - `kms:Decrypt` only on the specific key ARN
   - Audit via CloudTrail

4. **Cost**: ~$1/month per key, plus $0.03 per 10k decrypt calls
   (negligible at our payout rate)

5. **Migration steps**:
   1. Generate new KMS key
   2. Re-encrypt `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` using `kms encrypt`
   3. Store the new blob in AWS Secrets Manager
   4. Update `services/secret-vault.ts` to use AWS SDK `KMS.decrypt()`
   5. Deploy to staging, run `npm run test:integration` to verify
      a real payout round-trips
   6. Deploy to production during a maintenance window
   7. Revoke old `ENCRYPTION_KEY` from `.env`
   8. Set `KMS_PROVIDER=aws-kms` in production
   9. Set `ALLOW_INSECURE_HOT_WALLET=false` (or remove)

---

## Option B: Fireblocks (recommended for production with real users)

1. **Create an MPC wallet** via Fireblocks API
   - Replaces the single hot-wallet key with threshold signature
   - No single party can sign — requires quorum of operators
2. **Replace TronGrid direct broadcast** with Fireblocks transaction API
3. **Plaintext key never exists** in our server memory at all
4. **Requires** Fireblocks enterprise account (contact sales)

Best when audit/compliance requires multi-party key custody from day 1.

---

## Option C: HashiCorp Vault (self-hosted KMS)

1. **Install Vault** on a separate hardened instance
2. **Enable Transit secrets engine** for key wrapping:
   ```
   vault secrets enable transit
   vault write -f transit/keys/hot-wallet
   ```
3. **Integrate via Vault SDK** in `services/secret-vault.ts`
4. **Pros**: full control, no cloud lock-in
5. **Cons**: you operate the security boundary (patching, HA, audit)

Use when cloud-provider KMS is not an option (regulatory, sovereignty).

---

## Migration checklist (any option)

- [ ] Generate new key in KMS
- [ ] Re-encrypt `HOT_WALLET_PRIVATE_KEY_ENCRYPTED` with new KMS key
- [ ] Update `services/secret-vault.ts` to use KMS SDK
- [ ] Deploy to staging, run end-to-end payout test
- [ ] Deploy to production during maintenance window
- [ ] Revoke old `ENCRYPTION_KEY` from `.env`
- [ ] Set `KMS_PROVIDER=<chosen>` in production
- [ ] Set `ALLOW_INSECURE_HOT_WALLET=false` (or remove)
- [ ] Verify: log line "Hot wallet using single-key AES-GCM in production" no longer appears

## Current state (S1-W6-KMS, this commit)

- `KMS_PROVIDER` env var (default `'env'`)
- `ALLOW_INSECURE_HOT_WALLET` env var (default `'false'`)
- Production guard in `services/withdrawal-payout.ts`:
  - `NODE_ENV=production && KMS_PROVIDER=env && ALLOW_INSECURE_HOT_WALLET!=true` → **FATAL throw**
  - `NODE_ENV=production && KMS_PROVIDER=env && ALLOW_INSECURE_HOT_WALLET=true` → loud console.warn on every payout
  - `NODE_ENV=production && KMS_PROVIDER=aws-kms | fireblocks | hashicorp-vault` → silent, normal operation
  - `NODE_ENV!=production` → silent (dev/test bypass)

The guard is a runtime check, not a build-time check. The first payout
attempt is what triggers the FATAL. For true pre-deploy safety, set
the env in the CI/CD pipeline BEFORE the container starts.
