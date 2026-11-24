# Working on the Python SDK

## How parity is tested

`tests/test_parity.py` runs 38 workflow cases through both SDKs (the booking
starter, all eight faults, every check type, run limits, protocol violations, and
virtual time) and requires byte-identical reports after removing random IDs and
timings. It also checks that each SDK's schema accepts the other's batches and
rejects the same tampered ones, that `compare` gives identical results on mixed
pairs, and that fingerprints, imported report IDs, redaction, workflow parsing,
and Markdown summaries match. It needs Node and the built JavaScript SDK:

```sh
npm ci && npm run build            # repository root
cd packages/python && pip install -e ".[langgraph]" pytest && pytest
```
