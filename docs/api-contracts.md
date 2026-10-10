# API Contracts

The API is served from the backend origin, with application endpoints under
`/api`.

## Health check

`GET /api/health`

Returns HTTP `200` when the API process is available:

```json
{
  "status": "ok"
}
```

This endpoint reports API availability; it does not verify database health.
Additional endpoint contracts will be documented here as routes are added.
