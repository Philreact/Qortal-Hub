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

The separate private reliable channel bounds each send (including waiting for
another send) to five seconds, below Hub's seven-second sidecar request timeout.
QUIC write deadlines interrupt flow-control stalls. Failed partial frames cancel
the stream and report a recoverable transport closure; replacement connections
have independent writers. Backend authorization rejections remain rejections.
The private-channel attach exchange also observes its connection deadline.
These limits do not change MoQ datagram delivery or media buffering.

Private bootstrap rejection `transport_already_attached` is surfaced as
`TRANSPORT_ALREADY_ATTACHED`, not a generic transport error. It is not retried
against another relay: the authenticated backend session already owns a private
transport. Apps should share their existing channel between consumers and route
responses by message ID, releasing it only when the last consumer is finished.

## Independent private reliable streams (sidecar 0.8.0)

`PRIVATE_CHANNEL_SEND` accepts optional `streamOptions` on reliable messages:

```js
{ streamKey: 'opaque-stream-label', endStream: false }
```

Keys are 1–96 ASCII letters, digits, dots, underscores or hyphens. They are
scoped to the owner-bound private channel; Hub does not interpret their names
or payloads. Each key opens a distinct bidirectional QUIC stream under the
existing attached connection. Omitting the option preserves the legacy stream.
Datagrams cannot specify stream options. `endStream: true` writes a final frame
and FIN; the receive half remains open for final replies (at most 30 seconds).
Applications should use unique keys for finite tasks and finish them in cleanup.

At most 32 keyed streams are live per connection. Each has an independent
five-second send deadline and a 192 KiB Hub pending-send budget, within existing
channel/owner budgets. A failed keyed write reports `RELIABLE_STREAM_FAILED`
and resets only that stream; connection failures still use relay recovery.
Streams share connection congestion control and the MASQUE path, not independent
bandwidth. A stream key does not imply a priority class or bypass authorization.

The sidecar IPC reader dispatches reliable sends through per-session/per-key
queues, not inline. Each key preserves FIFO order while unrelated keys run
independently. Admission is capped at 64 active keys, 16 queued jobs per key and
4 MiB overall. Jobs waiting over one second fail without sending, keeping the
queue plus five-second native write inside Hub's seven-second request deadline.
Idle key workers are removed. This avoids moving stream head-of-line blocking
into the IPC layer.

The backend advertises `reliableStreams: true` in its ATTACHED frame. Missing
support reports `RELIABLE_STREAMS_UNSUPPORTED`; it never silently multiplexes
keyed traffic onto the old stream. Deploy the backend first, then updated Hub
and sidecar together, then the QApp. The relay needs no change.

## Paced, deadline-aware MoQ delivery (sidecar 0.9.0)

Applications can supply generic local delivery policy on an object batch:

```js
{
  trackName: 'opaque-track',
  objects: [encryptedObject],
  delivery: { priority: 0, maxQueueAgeMillis: 120 }
}
```

Priority is 0 (latency-sensitive), 1 (live), or 2 (background).
Queue lifetime is an integer from 10 to 2000 milliseconds. Legacy publications
default to priority 1 and 200 milliseconds. These values neither grant access
nor require Hub to interpret the payload. Backend applications assign their
own outbound policies; an untrusted publisher cannot choose recipient priority.

Each MoQ connection has one scheduler, not one independent rate limiter per
track. It provides:

- Weighted 8:4:1 service between priority classes; round-robin within a class.
  Idle classes lend their unused service. FIFO order is preserved per track.
- A 64 KiB per-track and 256 KiB total queue cap, with 32 KiB reserved capacity
  for each other class. There are at most 128 queued tracks. Limits include
  encoded MoQ bytes. Changing class while a track has pending objects is rejected.
- Expiry before QUIC admission. Overload refuses new objects rather than
  silently replacing arbitrary fragments of an existing object sequence.
- A byte-credit pacer, initially 1 MB/s, with at most four datagrams / 4 KiB
  in one burst and no accumulated idle credit beyond that burst allowance.
- Conservative rate reduction on sustained packet loss / RTT inflation or a
  blocked QUIC datagram send, with gradual recovery under demand. A stable high
  RTT alone does not trigger reduction. This complements, never bypasses,
  QUIC congestion control; it is not an independent bandwidth guarantee.

Hub uses bounded, per-session/per-track IPC workers. A batch completes after
scheduled QUIC admission (not remote acknowledgement). Different publications
remain independent while one waits for pacing. Native IPC queue time counts
toward the delivery deadline. Both admission and worker queues are bounded.
A batch may partly transmit; it must never be blindly replayed.

`MOQ_QUEUE_LIMIT` and `MOQ_OBJECT_EXPIRED` are expected pressure outcomes, not
reasons to reconnect or switch relay. Connection failures retain existing
recovery. Session close cancels queued work and releases blocked QUIC sends.

Metrics expose `deliveryQueuedBytes`, `deliveryQueueDelayMillis`,
`deliveryPacingBytesPerSecond`, `deliverySent`, `deliveryExpired`,
`deliveryRejected`, and `deliverySendErrors`. Sent means handed to QUIC,
not received by the peer. Applications retain receiver feedback and use these
additional measurements for producer adaptation.

### Boundaries and rollout

The scheduler can expire data while it owns it; quic-go's public SendDatagram
API cannot retract an object already admitted to its internal queue. All tracks
still share congestion control, the outer MASQUE tunnel and physical bandwidth.
This is not global QoS across independent QUIC connections or applications.
Capture/encoding CPU starvation and receiver playout remain application concerns.

No media keys, codecs, screen detection, or call policy were added to Hub.
No relay protocol change is needed. Deploy the backend media service, then Hub
with its matching 0.9.0 sidecar, then the QApp. An old backend remains wire
compatible but does not provide scheduled downlink forwarding.

Tests cover priority/fairness, per-track order, reservations and memory caps,
expiry, pacing, slow-recipient isolation, shutdown, pressure without reconnect,
policy validation, and scheduled forwarding over real QUIC through MASQUE.

### Sidecar 0.9.1 validation fix

Queue dispatch and execution share complete parameter types for reliable sends
and MoQ publications. Both retain strict unknown-field rejection. Routing-only
parameter structs incorrectly rejected messageId/endStream and batched/delivery
before requests reached their handlers. Regression tests exercise the actual
line-plus-binary Serve path, including legacy requests and malformed fields.
Rebuild/restart Hub with the matching sidecar; no backend or relay update is
required for this validation correction.
