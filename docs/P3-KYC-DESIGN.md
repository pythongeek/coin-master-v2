
DEPOSIT-SIDE KYC: Regulatory & Industry Context
==============================================

1. FATF Travel Rule (most important!)
   - Applies to crypto transfers >= USD 1,000 in many jurisdictions
   - Requires originator + beneficiary info to travel with the transfer
   - Implemented by: FATF VASP licensees globally
   - Applies to: centralized exchanges, custodial wallets
   - Enforcement: Bank of England, FinCEN, MAS, etc.
   - CryptoFlip is CUSTODIAL (holds user balances in shared wallets)
     --> we ARE subject to this if we serve UK/US/SG/etc users

2. FinCEN (US) MSB Rules
   - Money Service Business must collect customer info on all transactions
   - Suggested threshold: USD 3,000 aggregate in 24h
   - SAR (Suspicious Activity Report) for unusual patterns
   - CTR (Currency Transaction Report) for > USD 10,000 in one day

3. EU 5AMLD / 6AMLD (MiCA)
   - Strong customer verification for ANY deposit
   - Travel rule applies to all transfers regardless of size
   - Strict: no anonymous deposits allowed

4. Self-exclusion / responsible gambling
   - Self-excluded users must NOT be able to deposit (losing money is the harm)
   - This is true even for small deposits
   - UKGC / MGA / Curacao enforce this

5. Sanctions / PEP screening
   - OFAC, UN, EU sanctions lists must be checked
   - Should happen BEFORE crediting balance
   - Block sanctioned countries (IR, KP, SY, CU already in risk service)

INDUSTRY PATTERNS
==================
- Coinbase: KYC required for ALL deposits (no anonymous tier for fiat)
              For crypto deposits: KYC required if > $0 to prevent illegal use
- Binance: Tiered. <$10K/day requires basic KYC (email + ID). >$10K requires address proof.
- Kraken: KYC required from $0 (no anonymous tier)
- Stake.com (iGaming): KYC required to deposit > $0
- Roobet (iGaming): KYC required at $0 deposit for full features
- Bet365: KYC required before first deposit

RECOMMENDED CRYPTOFLIP TIERS (iGaming, BD market, global exposure)
====================================================================

| Daily deposit USD | KYC required | Tier | Reasoning |
|---|---|---|---|
| < 50 | None | tier0 | Lets users try the platform; iGaming best practice for casual play |
| 50 - 499 | Basic (email + DOB + country) | tier1 | FATF risk threshold; stop anonymous deposits here |
| 500 - 9,999 | ID + selfie + address | tier2 | Travel Rule lower limit + FinCEN MSB threshold |
| >= 10,000 | Full (ID + selfie + address + source-of-funds) | tier3 | CTR territory; FinCEN + MiCA enforcement |

Plus: self-excluded users blocked at ANY amount
Plus: sanctioned-country users blocked at ANY amount (already in P4 risk service for withdrawals; need to apply to deposits too)
Plus: age >= 18 always required (already in KYC tier 1)

ENFORCEMENT LAYERS (in priority order, from request entry to credit)
====================================================================

1. Self-exclusion check (block)  <-- HARD BLOCK, no override
2. Sanctioned country check (block) <-- HARD BLOCK
3. Age check (block)  <-- HARD BLOCK (age < 18)
4. Daily amount tier check (block or require KYC upgrade)
5. KYC tier sufficient check (block if required tier not met)
6. Daily cumulative cap (already exists, raise with KYC tier)

GRANDFATHERING (existing users)
===============================
- Existing users at P3 deploy time get a 30-day grace period
- They can keep depositing at their current KYC level until grace ends
- Daily digest email to KYC-incomplete users warning them
- Forced upgrade prompts when they hit the new tier thresholds

ADMIN OVERRIDES
===============
- super_admin can force-credit deposits to any user (existing 'manual adjust' tool, scope it)
- Per-user "KYC override" flag (super_admin sets with reason, expires after 90 days)
- Global "kyc_enforcement_mode" config: off (legacy) / warn (soft block) / strict (hard block)
  Default: warn for first 30 days, then strict
