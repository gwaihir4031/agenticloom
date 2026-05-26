# Bug: validator rejects valid UTF-8 multi-byte sequences

## Symptom

`POST /v1/items` returns 400 with `validation_failed` for payloads containing
emoji or CJK characters in the `name` field. Specifically: any 4-byte UTF-8
sequence (U+1F600 and above) and most 3-byte CJK characters trip the validator.

## Repro

```
curl -X POST /v1/items -d '{"name": "テスト"}'
→ 400 {"error": "validation_failed"}
```

## Expected

The `name` field's regex predicate should accept any valid UTF-8 string up to
the documented length limit (256 chars). The current regex pattern uses a
character class that erroneously excludes high code points.

## Out of scope

- Backfilling rejected items (manual replay tool exists)
- Renaming the field
- Changing the length limit
