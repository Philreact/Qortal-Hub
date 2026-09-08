# Generic multi-track Q-App transport

Sidecar 0.5.0 extends the existing owner-bound `PRIVATE_DATA_CHANNEL` capability.
No capture, codec, media encryption, jitter, call membership, or media-specific
priority policy lives in Hub.

`MOQ_SESSION_OPEN` accepts `publicationTrack` as either the existing single
string or an array of 1–8 distinct names, all under `publicationNamespace`.
One logical session uses one inner QUIC/MoQ connection through MASQUE. The
authenticated backend must subscribe to every declared publication before
opening completes. Undeclared publications are rejected; relay recovery
restores the same declarations and subscriptions with a fresh attach token.

`MOQ_OBJECT_PUBLISH` continues to accept one `Uint8Array`. For explicit track
selection and batching, `payload` may instead be:

```js
{ trackName: 'bulk', objects: [encryptedObject1, encryptedObject2] }
```

Batches have 1–8 objects, each 1–1024 bytes. They cross renderer/main/native IPC
in one request; each remains a separate QUIC datagram, not a larger datagram.
The native binary envelope prefixes each object with its uint16 big-endian
length and validates the whole envelope before sending anything. A batch may
partially send if the transport fails; it is never retried as reliable data.

Admission is bounded at 16 KiB pending per publication and 64 KiB per session,
with at most 128 subscriptions. A bulk publication cannot consume another
publication's entire per-track allowance. Limits and owner checks apply equally
to legacy and batch calls. The app should keep at most one bulk batch in flight;
small batches give other publications opportunities to send between them.
No stream has independent physical bandwidth: QUIC/MASQUE congestion control
still applies to the connection. Track separation alone does not promise QoS.

Recovered connections report interrupted publications as failed instead of
claiming dropped stale objects were delivered. Media apps can request a fresh
reference object; Hub does not interpret that object or decide media recovery.

Tests cover owner isolation, declaration/batch limits, independent queue
admission, malformed binary framing, and three opaque publication tracks on a
real QUIC-through-MASQUE connection with a verified relay egress address.

Deployment requires updated native Hub code and sidecar together; strict sidecar
version checking rejects stale binaries. Existing single-track apps remain
supported. Backends must implement routing for their own declared track names.
