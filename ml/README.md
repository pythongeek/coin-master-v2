# ML Risk Pipeline — Operator Runbook

This is the short, linear doc for whoever runs the train-and-deploy loop.
Read `notebooks/01_train_xgboost_labelled_fraud.ipynb` for the full code.

## TL;DR

```
┌──────────────────────┐         ┌──────────────────────┐         ┌──────────────────────┐
│  Free Kaggle/Colab   │         │       Developer       │         │     Admin Panel      │
├──────────────────────┤         ├──────────────────────┤         ├──────────────────────┤
│ 1. Open notebook in   │         │ 4. docker cp .onnx   │         │ 6. Admin → ML Risk   │
│    Kaggle or Colab    │         │    into container     │         │    Center → Register │
│ 2. Set DATABASE_URL    │ ──→   │ 5. Verify file lands  │ ──→    │    model (paste the  │
│    in secrets         │  tar    │    at /app/ml/…       │  curl   │    4 file contents) │
│ 3. Run all cells;     │  ball  │                       │ /files │ 7. Click Activate    │
│    download bundle    │         │                       │         │ 8. Admin Settings →  │
│    tarball            │         │                       │         │    ml_enabled=true   │
└──────────────────────┘         └──────────────────────┘         └──────────────────────┘
```

## What the trainer delivers

A bundle containing exactly four files:

| File | Extension | What it is | Where admin pastes it |
|------|-----------|------------|------------------------|
| `xgboost_v<SEMVER>.onnx` | binary | ONNX model | file path input of "Register model" |
| `xgboost_v<SEMVER>.metrics.json` | JSON | `{"auc":0.94, "precision_fraud":0.31, "f1_fraud":0.45, ...}` | "metrics" field (or POST `training_metrics` column via SQL) |
| `xgboost_v<SEMVER>.feature_importance.json` | JSON | `[{"name":"has_known_fraud","gain":42.3}, ...]` | "feature_importance" field |
| `xgboost_v<SEMVER>.feature_columns.json` | JSON | `["account_age_hours", "kyc_verified", ...]` (exact 32-element order) | "feature_columns" field |

**SEMVER rules:**
- `<SEMVER>` = `MAJOR.MINOR.PATCH`
- bump `MAJOR` when retrain approach changes (e.g. switch to LightGBM)
- bump `MINOR` when trained on materially more data (>3× rows)
- bump `PATCH` for ordinary weekly retrains
- **never reuse an old version**, even if the contents change

## Step 1 — Trainer does (in Kaggle/Colab)

1. Open `notebooks/01_train_xgboost_labelled_fraud.ipynb`:
   - **Kaggle:** https://www.kaggle.com/code/new → upload the .ipynb → Add-ons → Secrets → add `DATABASE_URL`
   - **Colab:** https://colab.research.google.com → File → Upload notebook → pick the .ipynb → click 🔑 → add `DATABASE_URL`

2. The DATABASE_URL is the same one the backend container uses. Format:
   ```
   postgresql://cryptoflip:***@<host>:5432/cryptoflip
   ```
   Get it from `/root/coin-master/.env` line `DATABASE_URL=`.

3. Run all cells (Kaggle: `Run All` button, Colab: `Runtime → Run all`).

4. After the last cell, download the file `xgboost_v<SEMVER>_bundle.tar.gz` from the file pane.

5. Send the tarball to the developer (just zip+drop it; it's < 50 MB).

**Trainer does NOT register the model themselves. The notebook ends without a curl, on purpose.**

## Step 2 — Developer does (host-side staging)

```bash
# 1. Untar
tar xzf xgboost_v1.0.0_bundle.tar.gz
ls artifacts/xgboost_v1.0.0/
# xgboost_v1.0.0.onnx
# xgboost_v1.0.0.metrics.json
# xgboost_v1.0.0.feature_importance.json
# xgboost_v1.0.0.feature_columns.json

# 2. Stage the .onnx file inside the backend container
docker cp artifacts/xgboost_v1.0.0/xgboost_v1.0.0.onnx \
  coin-master-backend-1:/app/ml/xgboost_v1.0.0.onnx

# 3. Verify it landed
docker exec -i coin-master-backend-1 ls -la /app/ml/
docker exec -i coin-master-backend-1 du -h /app/ml/xgboost_v1.0.0.onnx

# 4. (optional) Smoke-load the .onnx in the container to confirm it parses
docker exec -i coin-master-backend-1 node -e "
  const ort = require('onnxruntime-node');
  ort.InferenceSession.create('/app/ml/xgboost_v1.0.0.onnx').then(s => {
    console.log('model loaded OK; input=' + s.inputNames[0] + '; output=' + s.outputNames[0]);
  }).catch(e => { console.error('LOAD FAIL:', e.message); process.exit(1); });
"
# expected:
# > model loaded OK; input=float_input; output=label
```

If `LOAD FAIL` — the .onnx file is corrupt or was built with an incompatible opset. Ask the trainer to rebuild with op sets 17 (default in the notebook).

## Step 3 — Admin does (browser-only, no shell)

1. Log in as super_admin.
2. Sidebar → **ML Risk Center**.
3. Top right → click **Register model**. Fill in:

   | Field | Value | Where it comes from |
   |-------|-------|----------------------|
   | name | `xgboost_v` | matches the `NAME` in the notebook |
   | version | `1.0.0` | matches `SEMVER` you bumped to |
   | provider | `onnx` | (not "mock") |
   | file path | `/app/ml/xgboost_v1.0.0.onnx` | where you `docker cp`ed it |
   | notes | free text — paste the training window summary here |

4. Click **Register row**. The model appears with status `uploaded`.

5. Click **Activate** on the new row. The panel calls `clearModelCache()` automatically; the next `recalculateRisk()` call hits the live ONNX.

   - Watch for the active-model indicator at the top: "active: <id…>".

6. **ml-enabled ON?** The panel's **Live config** section already has the right defaults loaded. Set `ml_enabled=true` and click **Save config**.

7. Verify: open `Admin → Live Stats` (or run a one-shot):

```bash
docker exec -i coin-master-backend-1 node -e "
const { recalculateRisk } = require('/app/dist/services/ai-risk-engine');
const { query } = require('/app/dist/config/database');
(async () => {
  const u = await query(\"SELECT id FROM users WHERE username='admin' LIMIT 1\");
  const r = await recalculateRisk(u.rows[0].id, { ml: true });
  console.log('blended=', r.score, 'tier=', r.tier);
  const p = await query(\"SELECT ml_prob, blended_score, flag_action FROM ml_predictions WHERE user_id=\$1::uuid ORDER BY created_at DESC LIMIT 1\", [u.rows[0].id]);
  console.log('latest pred:', p.rows[0]);
})().catch(e => console.error(e));
"
```

   `ml_prob` should be close to (but not equal to) 0.5 (the noop fallback returns exactly 0.5). If it's still 0.5 after activation, the file path in the model row is wrong.

## Step 4 — Rollback path

If a new model misbehaves:

1. Sidebar → ML Risk Center → click **Rollback** on the new row.
2. The previous active row (latest non-retired one) gets auto-promoted.
3. The in-process cache TTL is 30 s — wait, or **no need to wait**, `clearModelCache()` already ran.

Old versions stay in the registry forever (`status='retired'`). You can re-activate any of them with the **Activate** button.

## What to monitor

After rollout, watch these for the first 24 h:

- **`fraud_alerts`** with `alert_type='ML_001'` — count per hour. A spike (≥ 5× normal) usually means the model is mis-predicting; **rollback**.
- **`ml_predictions.blended_score`** distribution. If > 95% of rows are flagged, the model is over-triggering.
- **`recalculateRisk` latency** (via `score_breakdown.history` JSON timestamps). Should stay under 250 ms — ONNX is fast.

## Common gotchas

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ml_prob=0.5` after activation | Noop fallback hit | Check the runtime sees the file path; rebuild + redeploy |
| 401 on `/admin/ml/*` | Token expired or wrong role | Refresh page; only `super_admin` can write, `auditor` can read |
| All predictions `predicted_fraud=true` | threshold=0 | `admin_settings.ml_min_score_to_flag` got saved as empty string → `Math.floor(0.65) = 0`. Reset to `0.65` and Save |
| `feature_logging` empty | `ml_feature_logging_enabled=false` | Flip to `true` |
| ONNX file > 200 MB | Train too long / tree_method='gpu_hist' bug | Reduce `num_boost_round` to 200, switch to `tree_method='hist'` |

## Re-train cadence

- **Weekly** when traffic is normal (< 10 k users).
- **After any rule-engine overhaul** (Phase N shipped).
- **After any provider changes** (e.g. you start shipping iOS + Android in addition to web — adds new fraud patterns).
- **NOT MORE OFTEN** than daily — labelled fraud takes ~24 h to accumulate; more frequent retrains over-fit to noise.
