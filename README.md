# Correspond

Group chat and private messaging with accounts, file sharing, message
editing/deleting, emoji reactions, and a paper-and-ink visual design.

## Features

- **Private messages** — click any name in the sidebar to message them
  one-on-one. Only the two of you can see that conversation, both in real
  time and in the saved history.
- **Group chat** — the shared "Everyone" room.
- **Edit and delete your own messages** — hover a message you sent to see
  edit/delete controls. Changes and deletions sync instantly to everyone
  who can see that conversation. Enforced server-side: only the original
  sender can edit or delete a message, verified by a real test (a second
  account cannot edit or delete someone else's message, either through the
  live connection or by calling the underlying event directly).
- **Emoji reactions** — hover any message to react; reactions update live
  for everyone in that conversation.
- **Typing indicators** — see when the other person is typing.
- **Message grouping and date dividers** — consecutive messages from the
  same person are grouped together, and conversations are split into
  "Today," "Yesterday," and full dates.
- **Inline image previews** — image attachments show as a thumbnail in the
  chat instead of a plain file link; other file types still show as a
  download link.
- **Avatars** — a colored circle with the person's initial, generated
  consistently from their username (no images stored, just computed from
  the name each time).
- **Sidebar search** — filter your contact list by typing a name.
- **Unread badges + tab title counter** — conversations you're not
  currently viewing show an unread count, and the browser tab title shows
  the total count too, so you can notice a new message without the tab
  being focused.
- **Paper-and-ink visual design** — serif headings, note-card style
  messages, wax-seal presence indicators, instead of a generic dark chat
  template.

## Running it

```bash
npm install
npm start
```

Open `http://localhost:3000`. Sign up as two different users (two browser
tabs, or one normal + one private/incognito window) to try messaging
between them.

## How private messages stay private

Every message is tagged with a `room`. Group messages use the room
`"general"`. A private conversation between two people gets a room made
from both usernames sorted alphabetically and joined together — so
`alice` and `bob` always land in the same room (`"alice::bob"`) no matter
who messages first.

Two things enforce privacy:

1. **Real-time delivery** — when a private message is sent, the server
   only emits it to the two personal rooms involved
   (`io.to(username).to(recipient).emit(...)`), not to everyone.
2. **History lookups** — `GET /api/messages/with/:username` computes the
   room from *your* logged-in identity and the name in the URL. There's
   no way to ask for someone else's conversation with a third party,
   because the room id always includes your own username.

Both of these were checked with a real three-user test before this was
packaged (alice messaging bob privately, with a third account "eve"
confirmed unable to see it through either the live socket or the saved
history).

## How edit/delete permissions are enforced

Every message carries the username of whoever sent it (`from`). When an
`edit message` or `delete message` event arrives, the server checks
`message.from === <the currently authenticated socket's username>` before
doing anything — if they don't match, the request is silently ignored, no
error message given back (so an attacker probing for behavior gets no
useful signal either way). This was verified with a real test: a second
account attempted to edit and delete a first account's message directly
through the socket connection, and in both cases the message on the server
was completely unchanged afterward.

## Known limitations

- Storage is JSON files and an in-memory token map — fine for learning
  and small personal use, not built for scale or high traffic
- No message editing/deleting, no read receipts
- No group creation beyond the one shared "Everyone" room — every private
  conversation is strictly one-on-one
- File links aren't access-controlled the same way messages are: anyone
  with the exact uploaded file's URL could open it directly, since
  `/uploads` is served as static files. Good enough for casual sharing
  between people who trust each other; not meant for sensitive files.

## Deploying

Same approach as before: push to GitHub, deploy on Render (or similar)
with `npm install` / `npm start`. Keep in mind free tiers typically sleep
after inactivity, which will drop open chat connections until someone
visits again.

## Files

- `server.js` — accounts, group + private messaging, file uploads
- `public/index.html` — sign in / sign up
- `public/chat.html` — the chat interface
- `public/style.css` — the whole design system
