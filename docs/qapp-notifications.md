# Q-App notifications

Q-Apps can register publication subscriptions with `NOTIFICATION_ADD`, or ask
Hub to display a one-time OS alert with `NOTIFICATION_SHOW`. Both require the
existing `NOTIFICATION_PERMISSION` grant for the current app and account.

For a one-time alert, send a standard Q-App UI request:

```js
await qortalRequest({ action: 'NOTIFICATION_PERMISSION' });

const result = await qortalRequest({
  action: 'NOTIFICATION_SHOW',
  title: 'New reply', // optional; Hub prefixes the app name
  body: 'Alice replied to your video.',
  link: 'qortal://APP/Q-Tube/video/123?view=comments', // optional
});
// result: { shown: true } or { shown: false }
```

`body` is required and limited to 1,000 characters. `title` is optional and
limited to 120 characters. If supplied, `link` must be a `qortal://APP/` URL
for the requesting app and must be at most 2,048 characters. A notification
without a link focuses the app's current page when clicked.
Hub preserves the requesting app identifier in deep links.
Use a path or query for deep links; fragment (`#`) routes are not supported.

Hub verifies the notification permission and respects the global desktop mute
setting and the per-app desktop mute setting. Electron limits direct requests
to three displayed alerts per app per minute. When Hub is hidden, an alert is
shown only if exactly one matching standalone Q-App window is open. A click
focuses that window and opens the link there. When Hub is visible without a
matching app window, a click follows the existing Hub tab navigation path.

`{ shown: false }` means the alert was suppressed or the OS notification
service was unavailable. Direct alerts are transient; `NOTIFICATION_ADD`
subscriptions remain the mechanism for publication events and Hub's
notification history. Q-App guest pages cannot use Chromium's direct
`Notification` API.
