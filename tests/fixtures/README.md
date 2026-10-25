These OpenAPI excerpts come from the immutable AppWorld docs in
`final-source-ff3ccbd-463c7fa/world-inputs/api_docs/openapi/`.
`spotify-search-openapi.json` retains `/spotify/songs` and `/spotify/artists`
operations unchanged. `gmail-reply-openapi.json` retains the reply operation and
moves its unchanged inline body schema into a local `components.schemas` reference,
matching the runtime OpenAPI reference form. Protected operations use a local mocked `/auth/token` and assert host-only bearer
header injection; no AppWorld service or model is used.
